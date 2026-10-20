import { describe, expect, it } from "vitest";
import { buildPersonaPrompt } from "./persona-generation.js";

describe("persona statistics", () => {
  it("uses the authoritative memory count instead of the checkpoint cursor", () => {
    const result = buildPersonaPrompt({
      mode: "incremental",
      currentTime: "2026-08-25T00:00:00.000Z",
      totalProcessed: 0,
      memoryCount: 1137,
      sceneCount: 1,
      changedSceneCount: 0,
      changedScenesContent: "",
      personaFilePath: "persona.md",
      checkpointPath: "checkpoint.json",
    });

    expect(result.userPrompt).toContain("**总记忆数**: 1137 条");
    expect(result.userPrompt).not.toContain("**总记忆数**: 0 条");
  });
});
