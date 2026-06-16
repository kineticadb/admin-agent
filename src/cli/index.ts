import pc from "picocolors";
import { printBanner } from "./banner.js";
import { selectModel } from "./select-model.js";
import { getVersion } from "./version.js";
import { authenticateAnthropic } from "../auth/preflight.js";
import { logout } from "../auth/logout.js";
import { loadEnvFile } from "../session/env-file.js";
import { connectWithRetry, connectBestEffort } from "../session/verify.js";
import { verifyBundle } from "../bundle/verify-bundle.js";
import { runAgent, SUPPORTED_MODELS, DEFAULT_AGENT_MODEL } from "../agent/run-agent.js";
import type { AgentModel } from "../agent/run-agent.js";
import { resolveMaxBudgetUsd, isValidBudget } from "../agent/session-budget.js";
import type { KineticaSession } from "../types/index.js";

export let verbose = false;

// Session established during startup — used by agent loop in Phase 3
let session: KineticaSession | undefined;

/**
 * Value of a `--name=value` flag, or undefined if the flag is absent. Splits on
 * the FIRST `=` only, so values containing `=` (paths, org UUIDs) survive intact —
 * `arg.split("=")[1]` would truncate them at the first `=`.
 */
function flagValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const arg = args.find((a) => a.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

/**
 * Version to label a bundle session. Prefer the bundle's CAPTURED version — it's the
 * era of the frozen logs/config the agent reasons over, so version-specific quirks must
 * follow it. Fall back to the best-effort live probe's version only when the bundle has
 * none (the live cross-check may reach a since-upgraded cluster; labeling frozen evidence
 * with that version would misapply quirks).
 */
export function chooseBundleSessionVersion(
  bundleVersion?: string,
  liveVersion?: string,
): string | undefined {
  return bundleVersion ?? liveVersion;
}

function printHelp(): void {
  const lines = [
    "",
    "  admin-agent",
    "",
    "  Autonomous diagnostic agent for Kinetica databases",
    "",
    "  Usage:",
    "    admin-agent [flags]",
    "",
    "  Flags:",
    "    --help                Show this help message",
    "    --version             Print version and exit",
    "    --verbose             Enable verbose output (stack traces on error)",
    "    --login               Force OAuth login (even if ANTHROPIC_API_KEY is set)",
    "    --login-method=TYPE   Login method: claudeai (Pro/Max) or console",
    "    --login-org=UUID      Target organization UUID for OAuth",
    "    --logout              Log out from Anthropic account and exit",
    `    --model=NAME          Override agent model (${SUPPORTED_MODELS.join(" | ")}); default: sonnet`,
    "    --max-budget=USD      Per-session budget cap in USD (API-key billing only); default: 5.00",
    "    --bundle=PATH         Offline mode: diagnose from an extracted support bundle directory",
    "",
    "  Environment variables:",
    "    ANTHROPIC_API_KEY      Anthropic API key (if not set, OAuth login via browser is used)",
    "    ADMIN_AGENT_MAX_BUDGET Per-session budget cap in USD (overridden by --max-budget)",
    "    KINETICA_URL           Kinetica endpoint URL",
    "    KINETICA_USER          Admin username",
    "    KINETICA_PASS          Admin password",
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--verbose")) {
    verbose = true;
  }

  if (args.includes("--version")) {
    process.stdout.write(getVersion() + "\n");
    return;
  }

  if (args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.includes("--logout")) {
    const result = await logout();
    process.stderr.write(result.message + "\n");
    process.exitCode = result.success ? 0 : 1;
    return;
  }

  // Parse OAuth login flags
  const forceLogin = args.includes("--login");
  const loginMethod = flagValue(args, "--login-method") as "claudeai" | "console" | undefined;
  const loginOrgUUID = flagValue(args, "--login-org");

  // Parse --model flag; validated against SUPPORTED_MODELS so runAgent can trust the value.
  const modelValue = flagValue(args, "--model");
  let model: AgentModel | undefined;
  if (modelValue !== undefined) {
    if ((SUPPORTED_MODELS as readonly string[]).includes(modelValue)) {
      model = modelValue as AgentModel;
    } else {
      const valid = SUPPORTED_MODELS.join(", ");
      process.stderr.write(
        pc.red(`Error: unknown --model value "${modelValue}". Valid models: ${valid}\n`),
      );
      process.exitCode = 1;
      return;
    }
  }

  // Parse --max-budget flag; must be a positive finite number. Reject bad input loudly
  // (the user typed it now) — env/default fallback is handled by resolveMaxBudgetUsd.
  const budgetValue = flagValue(args, "--max-budget");
  let maxBudgetFlag: number | undefined;
  if (budgetValue !== undefined) {
    const parsed = Number(budgetValue);
    if (!isValidBudget(parsed)) {
      process.stderr.write(
        pc.red(
          `Error: invalid --max-budget value "${budgetValue}". Use a positive number, e.g. --max-budget=10\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    maxBudgetFlag = parsed;
  }

  // Parse --bundle flag: offline mode against an extracted support bundle directory.
  // An explicit-but-empty value (`--bundle=`, e.g. an unset shell var) is a mistake,
  // not a request for bundle mode — reject it loudly rather than entering bundle mode
  // with an empty path (which would stat("") and exit with a confusing message).
  const bundlePath = flagValue(args, "--bundle");
  if (bundlePath?.trim() === "") {
    process.stderr.write(
      pc.red(
        "Error: --bundle requires a directory path, e.g. --bundle=/path/to/extracted-bundle\n",
      ),
    );
    process.exitCode = 1;
    return;
  }

  loadEnvFile();

  // Print the logo/version banner first — the model line is emitted below,
  // after the operator has had a chance to pick one.
  printBanner();

  // When the operator didn't pin a model via --model and the terminal is
  // interactive, let them choose for this session. The choice is deliberately
  // not persisted — prompting fresh each interactive launch keeps the model
  // easy to change. Non-interactive runs (CI, piped input) skip the prompt and
  // fall back to DEFAULT_AGENT_MODEL, mirroring the precedence used for
  // Kinetica credentials.
  if (model === undefined && process.stdin.isTTY) {
    model = await selectModel();
  }

  // Resolve the effective model once selection is settled. runAgent re-applies
  // the same `?? DEFAULT_AGENT_MODEL` for non-CLI callers, so the two sites
  // never drift.
  const effectiveModel: AgentModel = model ?? DEFAULT_AGENT_MODEL;
  process.stderr.write(pc.dim(`Model: ${effectiveModel}\n`));

  // Authenticate with Anthropic BEFORE collecting Kinetica credentials.
  // Fail fast if no API key and OAuth is impossible (non-interactive terminal).
  const authResult = await authenticateAnthropic({ forceLogin, loginMethod, loginOrgUUID });
  if (authResult.method === "oauth") {
    const acctInfo = authResult.email ? ` (${authResult.email})` : "";
    process.stderr.write(pc.dim(`Authenticated via OAuth${acctInfo}\n`));
  } else {
    process.stderr.write(pc.dim("Authenticated via API key\n"));
  }

  // Resolve the effective budget: --max-budget flag > ADMIN_AGENT_MAX_BUDGET env > default.
  const maxBudgetUsd = resolveMaxBudgetUsd(maxBudgetFlag);

  // Bundle entry point: validate the bundle, then attempt a best-effort live
  // connection so the agent can cross-check frozen evidence against current state.
  // The bundle is the guaranteed source; live is attached only if reachable
  // (the cluster is often down — that's why a bundle exists).
  if (bundlePath !== undefined) {
    const result = await verifyBundle(bundlePath);
    if (!result.ok) {
      process.stderr.write(pc.red(`Error: ${result.error}\n`));
      process.exitCode = 1;
      return;
    }
    if (result.missingExpected.length > 0) {
      process.stderr.write(
        pc.yellow(
          `Warning: bundle is missing expected artifact(s): ${result.missingExpected.join(", ")}. ` +
            `Diagnosing with what is present.\n`,
        ),
      );
    }

    const live = await connectBestEffort();
    process.stderr.write(
      live
        ? pc.dim("Live connection available — bundle + live verification enabled.\n")
        : pc.dim("No reachable live connection — offline bundle analysis only.\n"),
    );

    // Label the session with the bundle's captured version (the evidence the agent
    // reasons over), not the live probe's — and warn if a reachable live cluster
    // reports a DIFFERENT version (it may have been upgraded since the bundle's capture).
    if (
      live?.kineticaVersion &&
      result.kineticaVersion &&
      live.kineticaVersion !== result.kineticaVersion
    ) {
      process.stderr.write(
        pc.yellow(
          `Warning: live cluster version (${live.kineticaVersion}) differs from the bundle's ` +
            `captured version (${result.kineticaVersion}). Reasoning over the bundle uses the ` +
            `captured version; the live cluster may have been upgraded since capture.\n`,
        ),
      );
    }

    // connectBestEffort never enters degraded mode (it only attaches when the DB
    // engine on 9191 answers), so degraded is always false here.
    await runAgent(
      live?.session,
      chooseBundleSessionVersion(result.kineticaVersion, live?.kineticaVersion),
      false,
      model,
      {
        authMethod: authResult.method,
        maxBudgetUsd,
        bundleSource: result.bundleSource,
      },
    );
    return;
  }

  const { session: connectedSession, kineticaVersion, degraded } = await connectWithRetry();
  session = connectedSession;
  await runAgent(session, kineticaVersion, degraded, model, {
    authMethod: authResult.method,
    maxBudgetUsd,
  });
}

export function getSession(): KineticaSession | undefined {
  return session;
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(pc.red(`Error: ${message}\n`));
    if (verbose && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  });
}
