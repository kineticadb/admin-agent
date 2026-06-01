# Evals

Model-output evals that complement the unit tests in `src/**/*.test.ts`.

Unit tests check the _inputs_: the system prompt, the report template file, the tool catalog. They cannot check the _output_ — whether the model honors those instructions when actually running. Evals fill that gap.

## What runs here

| Eval            | File                    | What it checks                                                                                                                                                                                                                          |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report-format` | `report-format.eval.ts` | Runs the full agent loop against a mocked Kinetica session and asserts the model's final report conforms to the template in `knowledge/templates/report.md` (top-level heading, required sections in canonical order, metadata labels). |

## Why evals are separate from unit tests

- **They hit the real Anthropic API.** Non-deterministic, slow (tens of seconds), and cost money (typically < $0.10 per run, but not free).
- **They require credentials.** `ANTHROPIC_API_KEY` or a completed OAuth login.
- **They aren't suitable for CI on every PR.** Run them manually before shipping prompt/tool changes, or on a schedule.

Vitest's `include: ["src/**/*.test.ts"]` pattern deliberately doesn't match `*.eval.ts`, so evals don't run as part of `npm test` or CI.

## Running an eval

```bash
# Requires ANTHROPIC_API_KEY in env (or prior OAuth login via `npm run dev -- --login`)
npm run eval
```

Exit codes:

- `0` — report captured and all structural assertions passed.
- `1` — assertion failed (structural violation, or agent never saved a report).
- `2` — harness failure (missing API key, SDK error before assertions ran).

## Design choices

- **Mock the Kinetica session, not the Anthropic API.** We want real model behavior — that's the whole point. `MockKineticaSession` in `mock-session.ts` returns canned Response objects shaped like real Kinetica wire format (`data_str` double-encoded envelope for port 9191, plain JSON for host manager on port 9300).
- **Capture `save_report` instead of letting it write.** `capturing-save-report.ts` replaces the real disk-writing tool with an in-memory capture. Lets the model's prompted behavior ("call save_report at end of investigation") fire normally without creating stray files.
- **Structural regex checks, not LLM-as-judge.** For "does the report have the right shape?" we pin the invariants with pattern matches in `report-assertions.ts`. Save LLM-as-judge for fuzzier questions like "is the root cause plausible?".
- **Auto-allow all tools.** The approval gate is exercised by unit tests (`src/approval/*.test.ts`); the eval skips it to keep runs non-interactive and reproducible.

## Adding a new eval

1. Create `src/evals/<name>.eval.ts`. Follow the pattern in `report-format.eval.ts`: build the MCP server, call `query()`, consume until `type: "result"`, assert on the captured output, return an exit code.
2. If your scenario needs different Kinetica behavior (errors, missing endpoints, specific table data), pass `dbResponses` / `hmResponses` overrides to `createMockSession()`.
3. Add a pure-function test for any new assertion logic in `*.test.ts` so the validator itself is covered by the fast unit suite.
4. Add an `eval:<name>` entry in `package.json` scripts for ergonomic invocation.
