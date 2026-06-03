import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @inquirer/prompts before importing the module under test.
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
}));

// Mock the model source-of-truth so this unit test does not pull in the
// heavy Agent SDK that run-agent.ts imports at module load.
vi.mock("../agent/run-agent.js", () => ({
  SUPPORTED_MODELS: ["sonnet", "haiku", "opus"] as const,
  DEFAULT_AGENT_MODEL: "sonnet" as const,
}));

import { select } from "@inquirer/prompts";
import { selectModel, MODEL_LABELS } from "./select-model.js";
import { SUPPORTED_MODELS, DEFAULT_AGENT_MODEL } from "../agent/run-agent.js";

const mockSelect = select as unknown as ReturnType<typeof vi.fn>;

describe("MODEL_LABELS", () => {
  it("has a non-empty label for every supported model", () => {
    for (const model of SUPPORTED_MODELS) {
      expect(MODEL_LABELS[model]).toBeTruthy();
    }
  });
});

describe("selectModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the model chosen via the prompt", async () => {
    mockSelect.mockResolvedValue("opus");
    const result = await selectModel();
    expect(result).toBe("opus");
  });

  it("renders one choice per supported model, in tuple order", async () => {
    mockSelect.mockResolvedValue("sonnet");
    await selectModel();

    const config = mockSelect.mock.calls[0][0] as {
      choices: ReadonlyArray<{ value: string; name: string }>;
    };
    expect(config.choices).toHaveLength(SUPPORTED_MODELS.length);
    expect(config.choices.map((c) => c.value)).toEqual([...SUPPORTED_MODELS]);
  });

  it("labels each choice from MODEL_LABELS", async () => {
    mockSelect.mockResolvedValue("sonnet");
    await selectModel();

    const config = mockSelect.mock.calls[0][0] as {
      choices: ReadonlyArray<{ value: keyof typeof MODEL_LABELS; name: string }>;
    };
    for (const choice of config.choices) {
      expect(choice.name).toBe(MODEL_LABELS[choice.value]);
    }
  });

  it("defaults the highlighted option to DEFAULT_AGENT_MODEL", async () => {
    mockSelect.mockResolvedValue("sonnet");
    await selectModel();

    const config = mockSelect.mock.calls[0][0] as { default: string };
    expect(config.default).toBe(DEFAULT_AGENT_MODEL);
  });
});
