import { describe, expect, it } from "vitest";
import { resolveForAgentWithLocal, type InstanceUpstreamRow } from "../instance-upstream-cache.js";

function row(partial: Partial<InstanceUpstreamRow>): InstanceUpstreamRow {
  return {
    group_id: "g1",
    group_type: "custom",
    name: "group",
    agents: [],
    enabled: true,
    mode: "custom_unified",
    base_url: "https://upstream.example/v1",
    api_key: "key",
    model_id: "m",
    ...partial,
  };
}

const LOCAL = { "newapi-tencent-pro-qayk": { url: "https://gw.example/v1", apiKey: "k" } };

describe("resolveForAgentWithLocal", () => {
  it("treats a locally configured named route as managed", () => {
    const items = [row({ agents: ["claude-code"] })];
    expect(resolveForAgentWithLocal(items, "newapi-tencent-pro-qayk", LOCAL)).toEqual({
      kind: "official",
      row: null,
    });
  });

  it("still refuses an agent that has neither a Core group nor a local route", () => {
    const items = [row({ agents: ["claude-code"] })];
    expect(resolveForAgentWithLocal(items, "some-other-agent", LOCAL).kind).toBe("unmanaged");
  });

  it("keeps a Core custom-group override authoritative over the local entry", () => {
    const items = [row({ agents: ["newapi-tencent-pro-qayk"] })];
    const res = resolveForAgentWithLocal(items, "newapi-tencent-pro-qayk", LOCAL);
    expect(res.kind).toBe("override");
  });

  it("preserves the zero-row backward-compat fallback", () => {
    expect(resolveForAgentWithLocal([], "anything", LOCAL)).toEqual({ kind: "official", row: null });
  });
});
