import { describe, it, expect } from "vitest";
import { resolveCallerScope } from "../core/request-scope.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";

const rows = [
  { record_id: "a", session_key: "s1", session_id: "s1", role: "user", message_text: "paseo one", score: 0.9, recorded_at: "2026-10-01T00:00:00Z" },
  { record_id: "b", session_key: "s2", session_id: "s2", role: "user", message_text: "paseo two", score: 0.8, recorded_at: "2026-10-02T00:00:00Z" },
];
const store = {
  isFtsAvailable: () => true,
  getCapabilities: () => ({ nativeHybridSearch: true }),
  searchL0Hybrid: async () => rows,
} as any;
const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop } as any;

async function search(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const headers = { authorization: "Bearer test-fixture", "x-tdai-service-id": "default", "x-tdai-team-id": "team-t", "x-tdai-user-id": "usr-u", "x-tdai-agent-id": "agt-a", ...extraHeaders };
  let out: any;
  const deps: V2RouterDeps = { getStore: () => store, getEmbedding: () => undefined, getStorage: () => undefined, logger, deployMode: "standalone" };
  await handleV2Route({ headers, method: "POST" } as any, {} as any, "/v3/conversation/search", "POST",
    async () => body as any, (_r, _s, b) => { out = b; }, deps);
  return out;
}
const sessionOf: Record<string, string> = Object.fromEntries(rows.map((r) => [r.record_id, r.session_key]));
const sessions = (env: any) => (env?.data?.messages ?? []).map((m: any) => sessionOf[m.id]).sort();

describe("caller scope session default", () => {
  it("does not invent a session when none is given", () => {
    const d = resolveCallerScope({ headerTeamId: "t", headerUserId: "u", headerAgentId: "a" });
    expect(d.ok && d.scope.sessionId).toBe("");
  });
});

describe("/v3/conversation/search session filter", () => {
  it("without a session returns cross-session results", async () => {
    const env = await search({ query: "paseo" });
    expect(env.code).toBe(0);
    expect(sessions(env)).toEqual(["s1", "s2"]);
  });
  it("with a body session returns only that session", async () => {
    expect(sessions(await search({ query: "paseo", session_id: "s1" }))).toEqual(["s1"]);
  });
  it("with a header session returns only that session", async () => {
    expect(sessions(await search({ query: "paseo" }, { "x-tdai-session-id": "s2" }))).toEqual(["s2"]);
  });
});
