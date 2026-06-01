import pc from "picocolors";
import { printBanner } from "./banner.js";
import { getVersion } from "./version.js";
import { authenticateAnthropic } from "../auth/preflight.js";
import { logout } from "../auth/logout.js";
import { loadEnvFile } from "../session/env-file.js";
import { connectWithRetry } from "../session/verify.js";
import { runAgent, SUPPORTED_MODELS, DEFAULT_AGENT_MODEL } from "../agent/run-agent.js";
import type { AgentModel } from "../agent/run-agent.js";
import type { KineticaSession } from "../types/index.js";

export let verbose = false;

// Session established during startup — used by agent loop in Phase 3
let session: KineticaSession | undefined;

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
    "",
    "  Environment variables:",
    "    ANTHROPIC_API_KEY  Anthropic API key (if not set, OAuth login via browser is used)",
    "    KINETICA_URL       Kinetica endpoint URL",
    "    KINETICA_USER      Admin username",
    "    KINETICA_PASS      Admin password",
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
  const loginMethodArg = args.find((a) => a.startsWith("--login-method="));
  const loginMethod = loginMethodArg?.split("=")[1] as "claudeai" | "console" | undefined;
  const loginOrgArg = args.find((a) => a.startsWith("--login-org="));
  const loginOrgUUID = loginOrgArg?.split("=")[1];

  // Parse --model flag; validated against SUPPORTED_MODELS so runAgent can trust the value.
  const modelArg = args.find((a) => a.startsWith("--model="));
  const modelValue = modelArg?.split("=")[1];
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

  loadEnvFile();
  // Resolve the effective model here so the banner displays it directly
  // beneath the version. runAgent re-applies the same `?? DEFAULT_AGENT_MODEL`
  // for non-CLI callers, so the two sites never drift.
  const effectiveModel: AgentModel = model ?? DEFAULT_AGENT_MODEL;
  printBanner(effectiveModel);

  // Authenticate with Anthropic BEFORE collecting Kinetica credentials.
  // Fail fast if no API key and OAuth is impossible (non-interactive terminal).
  const authResult = await authenticateAnthropic({ forceLogin, loginMethod, loginOrgUUID });
  if (authResult.method === "oauth") {
    const acctInfo = authResult.email ? ` (${authResult.email})` : "";
    process.stderr.write(pc.dim(`Authenticated via OAuth${acctInfo}\n`));
  } else {
    process.stderr.write(pc.dim("Authenticated via API key\n"));
  }

  const { session: connectedSession, kineticaVersion, degraded } = await connectWithRetry();
  session = connectedSession;
  await runAgent(session, kineticaVersion, degraded, model);
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
