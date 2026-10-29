import { describe, expect, it } from "vitest";
import { resolveClientAgentSource, resolveNamedRoute } from "../namedRoute.js";

describe("resolveNamedRoute", () => {
  it("uses the named agent prefix for a TencentDB route", () => {
    expect(resolveNamedRoute("/tencent-glm/space-1/v1/chat/completions", "codex")).toBe("tencent-glm");
  });

  it("keeps the protocol handler fallback for unprefixed paths", () => {
    expect(resolveNamedRoute("/v1/responses", "codex")).toBe("codex");
  });

  it("keeps the cc-no provider alias on the Claude Code client family", () => {
    expect(resolveClientAgentSource("tencent-cc-no")).toBe("claude-code");
  });

  it("maps a configured channel route to its client family", () => {
    expect(
      resolveClientAgentSource("cliproxyapi-tencent-gemini", {
        "cliproxyapi-tencent-gemini": "pi",
      }),
    ).toBe("pi");
  });

  it("lets config override a builtin alias", () => {
    expect(
      resolveClientAgentSource("tencent-cc-no", { "tencent-cc-no": "codebuddy" }),
    ).toBe("codebuddy");
  });

  it("passes client-named routes through unchanged", () => {
    expect(resolveClientAgentSource("claude-code", {})).toBe("claude-code");
    expect(resolveClientAgentSource("codex", {})).toBe("codex");
  });
});
