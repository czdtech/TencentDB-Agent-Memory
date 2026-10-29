import { describe, expect, it } from "vitest";
import { resolveClientAgentSource, resolveNamedRoute } from "../namedRoute.js";

describe("resolveNamedRoute", () => {
  it("uses the named agent prefix for a TencentDB route", () => {
    expect(resolveNamedRoute("/tencent-glm/space-1/v1/chat/completions", "codex")).toBe("tencent-glm");
  });

  it("keeps the protocol handler fallback for unprefixed paths", () => {
    expect(resolveNamedRoute("/v1/responses", "codex")).toBe("codex");
  });

  it("treats a leading /responses as a protocol word, not an agent name", () => {
    expect(resolveNamedRoute("/responses/space-1", "codex")).toBe("codex");
  });
});

describe("resolveClientAgentSource", () => {
  it("maps a configured channel route to its client family", () => {
    expect(
      resolveClientAgentSource("cliproxyapi-tencent-gemini", {
        "cliproxyapi-tencent-gemini": "pi",
      }),
    ).toBe("pi");
  });

  it("passes routes without an alias through unchanged", () => {
    expect(resolveClientAgentSource("claude-code", {})).toBe("claude-code");
    expect(resolveClientAgentSource("codex", {})).toBe("codex");
    expect(resolveClientAgentSource("claude-code")).toBe("claude-code");
  });
});
