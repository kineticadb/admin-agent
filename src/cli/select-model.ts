import { select } from "@inquirer/prompts";
import { SUPPORTED_MODELS, DEFAULT_AGENT_MODEL } from "../agent/run-agent.js";
import type { AgentModel } from "../agent/run-agent.js";

/**
 * Human-readable labels for each supported model, shown in the interactive
 * picker.
 *
 * Typed as a full `Record<AgentModel, string>` on purpose: adding a model to
 * `SUPPORTED_MODELS` without a matching label here is a compile error, so the
 * picker can never silently fall behind the source-of-truth tuple (the same
 * guard `TOOL_CATALOG` applies to tools).
 */
export const MODEL_LABELS: Record<AgentModel, string> = {
  sonnet: "Sonnet — balanced, best general coding (default)",
  haiku: "Haiku — fastest & cheapest, lighter reasoning",
  opus: "Opus — deepest reasoning, slower & pricier",
};

/**
 * Interactively prompts the operator to choose the agent model for this
 * session.
 *
 * Choices are rendered from `SUPPORTED_MODELS` so the picker stays in lockstep
 * with the `--model` validator, and the highlighted default is
 * `DEFAULT_AGENT_MODEL` — so a bare Enter reproduces the non-interactive
 * default behavior exactly.
 *
 * The caller owns the TTY guard: this must only be invoked when
 * `process.stdin.isTTY` is truthy and no `--model` flag was supplied. The
 * choice is deliberately never persisted — prompting fresh on each interactive
 * launch keeps the model easy to change session to session.
 */
export async function selectModel(): Promise<AgentModel> {
  return select<AgentModel>({
    message: "Select model for this session:",
    default: DEFAULT_AGENT_MODEL,
    choices: SUPPORTED_MODELS.map((value) => ({ value, name: MODEL_LABELS[value] })),
  });
}
