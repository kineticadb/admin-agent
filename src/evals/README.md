# Evals

Model-output evals that complement the unit tests in `src/**/*.test.ts`.

Unit tests check the _inputs_: the system prompt, the report template file, the tool catalog. They cannot check the _output_ — whether the model honors those instructions when actually running. Evals fill that gap.

## What runs here

| Eval                  | File                          | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `report-format`       | `report-format.eval.ts`       | Runs the full agent loop against a mocked Kinetica session and asserts the model's final report conforms to the template in `knowledge/templates/report.md` (top-level heading, required sections in canonical order, metadata labels).                                                                                                                                                                                                          |
| `knowledge-retrieval` | `knowledge-retrieval.eval.ts` | Three scenarios (see below). Asserts the agent actually READS the knowledge documents its prompt cards oblige it to read: at least one `kinetica_knowledge_read` before `save_report`, the ids read include the document matching the issue, a remediation that starts/stops/restarts anything read `service-management` and emits no `gadmin` service command, the report still conforms to the template, and the report names the ids it read. |

### Why `knowledge-retrieval` exists

Progressive disclosure traded a guarantee for a trigger. While every knowledge document was rendered into the prompt in full, the agent could not fail to have the rules in context. Now the prompt carries a card and the agent must CHOOSE to fetch the body — and this repo has already measured the agent declining exactly that kind of invitation once: on a live cluster it skipped the entire Loki log dimension because the prompt framed it as probably-unavailable. A unit test can prove the card renders. Only a real model run can prove the card is acted on.

Its assertions are deliberately structural — did a read happen, before the report, of the matching id; is a `gadmin` command absent — never about wording, which would flake on model non-determinism. Run it twice before concluding a regression.

## Why evals are separate from unit tests

- **They hit the real Anthropic API.** Non-deterministic, slow (tens of seconds), and cost money (typically < $0.10 per run, but not free).
- **They require credentials.** `ANTHROPIC_API_KEY` or a completed OAuth login.
- **They aren't suitable for CI on every PR.** Run them manually before shipping prompt/tool changes, or on a schedule.

Vitest's `include: ["src/**/*.test.ts"]` pattern deliberately doesn't match `*.eval.ts`, so evals don't run as part of `npm test` or CI.

## Running an eval

```bash
# Requires ANTHROPIC_API_KEY in env (or prior OAuth login via `npm run dev -- --login`)
npm run eval                       # report-format (the default)
npm run eval:report-format
npm run eval:knowledge-retrieval
```

Exit codes:

- `0` — report captured and all structural assertions passed.
- `1` — assertion failed (structural violation, or agent never saved a report). **The model did something wrong.**
- `2` — harness failure (missing API key, SDK error, MCP server never connected, or the run never reached the model). **Nothing about the model's behaviour can be concluded.**

### Telling a failed RUN from a failed ASSERTION

This distinction is load-bearing, and the harness used to get it wrong. With an invalid
`ANTHROPIC_API_KEY` the run returned instantly and the eval printed:

```
Turns: 1. Cost: $0.0000. Cache reads: 0 tokens. Knowledge reads: 0 [none].
FAIL: Agent never called save_report.
```

— exit 1, indistinguishable from a genuine behavioural regression, with no hint that the
API was never reached. `transcript.ts` now reads the result message's `subtype`/`is_error`,
watches the init message for MCP servers that never connected, and recognises the
signature of a run that never happened (no tool calls, one turn, \$0.00 billed). Any of
those prints `HARNESS FAILURE: <why>` and exits **2**. Both evals also print the agent's
last words on any failure, so a model that asked a question or refused is visible rather
than merely absent.

### Where a run's report goes

**Every** run — pass or fail — writes its captured report to
`reports/eval-<scenario>-<pass|fail>-<UTC timestamp>.md` (gitignored, credential-scrubbed),
and the eval prints the path rather than the body. Each file opens with a `---` frontmatter
block recording the outcome, turns, cost, tool calls and the knowledge ids read, so the
artifact answers questions on its own:

```
---
scenario: memory-pressure
outcome: PASS
run_at: 2026-09-16T04:35:30.064Z
turns: 35
cost_usd: 0.7677
tool_calls: 33
knowledge_reads: [memory-pressure, tiered-objects, service-management]
---
```

Failures were the original motive: three times a failing CONTENT assertion has turned on
report text that existed only in terminal scrollback, and twice it turned out to be the
assertion's fault rather than the model's. Passes are kept for the mirror-image reason — a
green run is the evidence that a fix worked, and a conditional assertion (assertion 3, say)
can pass **vacuously** when the run never exercised it, so `knowledge_reads` is often the
only way to tell a working trigger from an untested one.

If the write fails, a FAILING run's body is printed as before so the evidence is never lost;
a passing one's is not. The dump never throws, because it must not turn an assertion failure
(exit 1) into a harness failure (exit 2).

If you see `HARNESS FAILURE`, fix the environment — do not read it as an eval result.

### Rule: never debug the harness through the API

A live eval run costs a few minutes and ~$0.29, and its output cannot distinguish a
harness bug from a model regression by inspection. Three consecutive runs of
`knowledge-retrieval` failed on harness bugs, each "fixed" by reasoning rather than by
test, and each fix was incomplete.

**When an eval fails for a harness reason, reproduce it offline first.**
`harness-integration.test.ts` simulates the whole conversation the harness must survive —
issue → investigate → ask about saving → operator answers → save → end — with a fake
message stream and no API. Both historical bugs are caught by it: a gate that never opens
makes the test HANG, and a loop that breaks on the first `result` makes it find no
`save_report` call. Extend that simulation to reproduce the new failure, fix it, then
spend the $0.29.

An eval that has never passed is not a regression detector — it is an unvalidated
assertion, and its failures carry no information. Get it green once before trusting
anything it says.

**A diagnostic can produce the false conclusion it was added to prevent.** The MCP
connection check first reported EVERY server that was not `connected`, which includes the
operator's ambient claude.ai connectors (Gmail, Slack, Stripe, …) sitting at `needs-auth`
as their normal resting state. That turned a healthy run — 34 tool calls, 2 turn groups,
4 correct knowledge reads — into a `HARNESS FAILURE`. It now filters on the eval's own
server name, exactly as `run-agent.ts` always did. Scope every health check to the thing
you actually own.

### The three `knowledge-retrieval` scenarios

| Scenario           | Issue                                         | Tests                                                                                                               |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `memory-pressure`  | slow queries + eviction warnings              | A matched playbook card is acted on. Healthy mock cluster.                                                          |
| `stale-rank`       | rank 2 offline, cluster degraded              | A DIFFERENT card routes correctly, **and** the `service-management` trigger fires. Uses `createStaleRankSession()`. |
| `unapplied-config` | `tps_per_tom` raised but throughput unchanged | The trigger fires when the restart is **incidental** to the investigation. Uses `createUnappliedConfigSession()`.   |

The second exists because four runs of the first never once retrieved
`service-management` — the document that exists _because_ the agent invented
`gadmin restart rank 2`, which moved from always-inline to a card behind a MANDATORY
trigger when the corpus went progressive-disclosure. Assertion 3 is conditional (it can
only fire on a remediation that touches a service), so those runs passed it vacuously and
left the highest-risk document in the corpus untested.

Closing that needed a mocked cluster where restarting is the obvious fix, not just a
differently-worded issue: against the healthy default mock the agent has nothing to
restart. `createStaleRankSession()` reports rank 2 `not_responding` on
`/show/system/status` and `stopped` in the host manager. It lives in `mock-session.ts`,
not in the `.eval.ts` file, because vitest excludes `*.eval.ts` — a wrong endpoint key
there would only surface on a paid run.

That scenario also asserts it actually **exercised** the trigger: if its Remediation ends
up touching no service, the eval fails with `FAIL (scenario coverage)` and says plainly
that this is a weakness in the scenario, not a model regression. A vacuous pass is worse
than a failure here, because it reads as evidence when it is the absence of evidence.

The third exists because the second turned out to cover only the **obvious** case, where a
restart IS the investigation. The failure measured on 2026-09-16 was the incidental one: the
agent wrote `systemctl stop gpudb` inside a memory-pressure investigation and never read
`service-management`. `memory-pressure` does not reproduce that reliably — across three live
runs its Remediation instructed a service action exactly **once**, depending on which
root-cause hypothesis the agent happened to chase, so it probes the case by luck rather than
by construction.

`createUnappliedConfigSession()` closes that the same way `createStaleRankSession()` closed
the first gap — by changing the WORLD, not the wording. It reports `conf.tps_per_tom = 8`
from `/show/system/properties` while the running process is still on 4, which is the trap
`gpudb-conf.md` documents as measured: `/alter/system/properties` edits the file in place and
the process never re-reads it, so a read-back shows the new value whether or not it ever took
effect. A written-but-unapplied config has exactly one correct remediation, and it is a
restart — inside an investigation that is otherwise about throughput. It carries
`mustExerciseServiceTrigger: true`, so it cannot pass vacuously either.

Note what the mock deliberately does **not** do: there is no endpoint that can report
"written but not applied" (both `/show/system/properties` and `/admin/show/configuration`
read the file), so the uptime is supplied in the issue text as a real operator would
volunteer it. The diagnosis still has to come from the corpus.

Its `expectAnyOf` lists `service-management` first, which looks odd for an assertion about
card routing and is deliberate. Measured over two live runs: the restart-required mechanism
— `tps_per_tom` included, with the measured 4→8 result — is already in the prompt verbatim,
because `mutation-safety` is `disclosure: inline`. An agent that reads `gpudb-conf` here
spends a turn re-reading what it was handed at startup. What is genuinely absent from the
prompt is the full-stack ordering (`gpudb_host_manager` appears only in
`service-management.md`), and the agent produced it — so the one read it made was the one
that added information. **`disclosure: inline` changes which on-demand reads are still
necessary**, and a scenario that expects a document without checking whether the fact is
already inline is demanding a wasted turn. Card routing is covered by the other two
scenarios; this one's non-vacuous guarantee is `mustExerciseServiceTrigger`.

### Two verdicts, reported separately

`knowledge-retrieval` prints a **retrieval verdict** before it looks at the report:

```
Retrieval assertions PASSED (read before reporting, and read a matching document).
```

Those two assertions need only the tool-call transcript, so they hold whether or not a
report was saved. The remaining three (`service-management` trigger, report structure,
knowledge-id citation) examine the report and cannot run without it.

This split exists because three consecutive runs of _correct_ retrieval — 4, then 6
knowledge reads, each landing on a different protocol hook — were reported as a bare
`FAIL: Agent never called save_report`, giving no credit for the behaviour actually under
test. A missing report is **still a FAIL and still exit 1**: saving on consent is real
behaviour worth verifying, and the report is the artifact three assertions examine. What
changed is that the output now says which half passed.

### Why the evals supply an operator

Saving is gated on operator consent (see "Post-Report Behavior" in both prompts), so an
eval with nobody to consent cannot pass however well the agent behaves. Measured, back
when the question was conversational: a run with 29 turns, 28 tool calls and 4 correct
knowledge reads still reported `FAIL: Agent never called save_report` — the agent asked,
ended its turn, and nobody answered.

Since 2026-09-16 the question is a `(Y/n)` widget the agent raises **mid-turn** via
`confirm_save_report`, so the eval server must **register that tool** — the prompt
instructs the model to call it, and a server without it points the instruction at
nothing. Both evals build the real tool (never a stub, which could drift from the one
prod ships) with an auto-approving operator:

```ts
makeConfirmSaveReportTool({ consent: createSaveConsent(), confirm: () => Promise.resolve(true) });
```

`scripted-operator.ts` remains as a fallback rather than the main path. Consent no longer
needs a conversational turn, so the save normally lands before the first `end_turn` and
the generator returns unused — but an agent that ends a turn for its own reasons before
the report exists (announcing a plan, asking a clarifying question) would still stall the
run. It mirrors prod exactly, down to the primitive: `makeInteractivePrompt` in
`run-agent.ts` awaits a `TurnGate` that the output loop opens on
`stop_reason === "end_turn"`, and so does this. It stops as soon as the report is
captured, so a spare reply never buys another billed turn.

`consumeTranscript()` in `transcript.ts` is the other half, and the subtler one. **A result
message arrives at the end of each agent turn, not once per session** — `run-agent.ts`
handles one and keeps iterating, opening its turn gate so the prompt generator "can exit
cleanly". An eval that `break`s on the first result abandons the stream mid-conversation: anything
the scripted operator yields afterwards goes into a stream nobody is reading. Both evals had this bug, and it survived the first fix — the second
measured run still reported `FAIL: Agent never called save_report` at 30 turns with 6
correct knowledge reads.

The consuming loop therefore lives in one tested function rather than duplicated inline in
each eval, and both evals print **`Turn groups: N`** — the count of result messages. `N > 1`
is the direct evidence that the operator's reply was delivered and the conversation
continued. Its absence is what hid this bug twice.

### Asserting the ask, not just the save

`consent-assertions.ts` checks that `confirm_save_report` was called **before** the first
save that needed it, and the artifact frontmatter records the answer as `asked_first`.

Both exist because a PASS cannot answer the question on its own. The capturing
`save_report` writes whether or not the widget fired — and in production the real handler
falls back to prompting inline — so a model that skipped the ask produces a green run that
looks identical to one that asked. Measured 2026-09-16: four runs went green on the first
attempt after the widget landed, and their artifacts could not distinguish the two paths,
because the frontmatter recorded `tool_calls` as a **count**. The names were in hand the
whole time: `transcript.ts` collects every `tool_use` block with its `name`.

A `partial: true` save is exempt, because both prompts prescribe saving a budget-pressure
checkpoint without confirmation — an assertion blind to that flag would fail the agent for
following its instructions. `asked_first` is omitted entirely when no consent-requiring
save happened, and recorded as `false` (never omitted) when one happened unasked, since
`false` is the finding the field exists to surface.

This is the same lesson as the eval it sits beside: **when a change replaces a guarantee
with a trigger, assert the trigger, not just the outcome** — otherwise the assertion is
satisfied by the fallback that exists precisely because the trigger might not fire.

## Design choices

- **Mock the Kinetica session, not the Anthropic API.** We want real model behavior — that's the whole point. `MockKineticaSession` in `mock-session.ts` returns canned Response objects shaped like real Kinetica wire format (`data_str` double-encoded envelope for port 9191, plain JSON for host manager on port 9300).
- **Capture `save_report` instead of letting it write.** `capturing-save-report.ts` replaces the real disk-writing tool with an in-memory capture. Lets the model's prompted behavior ("call save_report at end of investigation") fire normally without creating stray files. Its companion `confirm_save_report` IS the real tool, with consent auto-granted — the question it asks is the behaviour under test, so only the disk write is doubled.
- **Structural regex checks, not LLM-as-judge.** For "does the report have the right shape?" we pin the invariants with pattern matches in `report-assertions.ts`. Save LLM-as-judge for fuzzier questions like "is the root cause plausible?".
- **Auto-allow all tools.** The approval gate is exercised by unit tests (`src/approval/*.test.ts`); the eval skips it to keep runs non-interactive and reproducible.

## Adding a new eval

1. Create `src/evals/<name>.eval.ts`. Follow the pattern in `report-format.eval.ts`: build the MCP server, call `query()`, consume until `type: "result"`, assert on the captured output, return an exit code.
2. If your scenario needs different Kinetica behavior (errors, missing endpoints, specific table data), pass `dbResponses` / `hmResponses` overrides to `createMockSession()`.
3. Add a pure-function test for any new assertion logic in `*.test.ts` so the validator itself is covered by the fast unit suite.
4. Add an `eval:<name>` entry in `package.json` scripts for ergonomic invocation.
