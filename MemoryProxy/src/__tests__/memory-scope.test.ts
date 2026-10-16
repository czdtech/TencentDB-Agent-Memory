import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import { DEFAULT_CONFIG } from "../config.js";
import type { MemorySuperAdminConfig, ProxyConfig } from "../types.js";
import type { AgentEntity, FixedAssetItem, MetadataClient } from "../meta/client.js";
import type { TdaiClient } from "../tdai/client.js";
import type { TdaiIdentity } from "../tdai/types.js";
import type { AgentContext } from "../injection/types.js";
import type { SessionInfo } from "../session/types.js";
import {
  resolveFixedAssetCtxs,
  sourceTeamVisible,
  type FixedAssetCtx,
} from "../injection/injectors/tdai-fixed-asset.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { TdaiProfileMemoryInjector } from "../injection/injectors/tdai-profile-memory-injector.js";
import type { TdaiMemoryConfig } from "../tdai/types.js";
import { setMetadataClient } from "../meta/client.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";

/**
 * Cloud super-admin scope: one explicit config drives BOTH the automatic
 * memory/profile injection and the explicit memory-bridge search, ordinary
 * identities never gain cross-team visibility, and a super-admin identity may
 * read every configured source but never write to one.
 */

const SUPER_ADMIN: MemorySuperAdminConfig = {
  enabled: true,
  team_id: "team-super",
  apiKey: "admin-key",
  sources: [
    { team_id: "team-a", user_id: "usr-a", agent_id: "agt-a", name: "team-a" },
    { team_id: "team-b", user_id: "usr-b", agent_id: "agt-b", name: "team-b" },
  ],
};

const SUPER_IDENTITY: TdaiIdentity = {
  teamId: "team-super",
  userId: "usr-super",
  agentId: "agt-super",
  sessionId: "sess-super",
  userKey: "sk-super",
};

function makeConfig(): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    tdai: {
      ...DEFAULT_CONFIG.tdai,
      enabled: true,
      endpoint: "https://kernel.test",
      apiKey: "svc-token",
      serviceId: "default",
      memory: {
        ...DEFAULT_CONFIG.tdai.memory,
        enabled: true,
        inject: true,
        recallL1: true,
        injectL2L3: true,
      },
    },
    coreSkill: {
      ...DEFAULT_CONFIG.coreSkill,
      endpoint: "https://kernel.test",
      serviceToken: "svc-token",
      serviceId: "default",
    },
    superAdmin: SUPER_ADMIN,
  };
}

function agentCtx(custom: Record<string, unknown>): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: "test",
      keyId: "test",
      modelId: "test",
      stream: false,
      agentSource: "test",
      custom,
    },
  };
}

type MetadataStub = Pick<MetadataClient, "getAgentFixedAssets" | "getAgent">;

function metadataStub(assets: FixedAssetItem[], agents: Record<string, AgentEntity>): MetadataStub {
  return {
    getAgentFixedAssets: async () => ({ agent: {}, items: assets, total: assets.length }),
    getAgent: async (agentId: string) => {
      const found = agents[agentId];
      if (!found) throw new Error(`agent not found: ${agentId}`);
      return found;
    },
  };
}

function aclStub(allowedAssetIds: string[]): Pick<TdaiClient, "checkAcl"> {
  return {
    checkAcl: async (params) => ({ allowed: allowedAssetIds.includes(params.asset_id), reason: "test" }),
  };
}

function chatMemoryAsset(teamId: string, agentId: string): FixedAssetItem {
  return { asset_id: `chat_memory-${teamId}-${agentId}`, asset_type: "chat_memory" };
}

function agentEntity(agentId: string, teamId: string, name: string): AgentEntity {
  return { agent_id: agentId, team_id: teamId, name };
}

afterEach(() => {
  __resetSessionStoreForTests();
  setMetadataClient(null);
  vi.unstubAllGlobals();
});

describe("resolveFixedAssetCtxs scope", () => {
  it("gives the super-admin team self plus every configured source with its own identity", async () => {
    const ctxs = await resolveFixedAssetCtxs(agentCtx({}), SUPER_IDENTITY, null, SUPER_ADMIN);

    expect(ctxs).toEqual([
      { teamId: "team-super", userId: "usr-super", agentId: "agt-super", agentName: "agt-super", isSelf: true },
      { teamId: "team-a", userId: "usr-a", agentId: "agt-a", agentName: "team-a", isSelf: false },
      { teamId: "team-b", userId: "usr-b", agentId: "agt-b", agentName: "team-b", isSelf: false },
    ]);
  });

  it("keeps a non super-admin team self-only even when sources are configured", async () => {
    const identity: TdaiIdentity = {
      teamId: "team-x",
      userId: "usr-x",
      agentId: "agt-x",
      sessionId: "sess-x",
      userKey: "sk-x",
    };

    const ctxs = await resolveFixedAssetCtxs(agentCtx({}), identity, metadataStub([], {}), SUPER_ADMIN, aclStub([]));

    expect(ctxs).toEqual([
      { teamId: "team-x", userId: "usr-x", agentId: "agt-x", agentName: "agt-x", isSelf: true },
    ]);
    expect(sourceTeamVisible("team-x", "team-a", SUPER_ADMIN)).toBe(false);
    expect(sourceTeamVisible("team-super", "team-a", SUPER_ADMIN)).toBe(true);
  });

  it("admits same-team assets only when the kernel ACL allows them, and never other teams", async () => {
    const identity: TdaiIdentity = {
      teamId: "team-x",
      userId: "usr-x",
      agentId: "agt-x",
      sessionId: "sess-x",
      userKey: "sk-x",
    };
    const assets = [chatMemoryAsset("team-x", "agt-peer"), chatMemoryAsset("team-a", "agt-a")];
    const agents = {
      "agt-peer": agentEntity("agt-peer", "team-x", "peer"),
      "agt-a": agentEntity("agt-a", "team-a", "team-a"),
    };
    const allowed: FixedAssetCtx = {
      teamId: "team-x",
      userId: "usr-x",
      agentId: "agt-peer",
      agentName: "peer",
      isSelf: false,
    };

    const granted = await resolveFixedAssetCtxs(
      agentCtx({}),
      identity,
      metadataStub(assets, agents),
      SUPER_ADMIN,
      aclStub(["chat_memory-team-x-agt-peer"]),
    );
    expect(granted).toEqual([
      { teamId: "team-x", userId: "usr-x", agentId: "agt-x", agentName: "agt-x", isSelf: true },
      allowed,
    ]);

    const denied = await resolveFixedAssetCtxs(
      agentCtx({}),
      identity,
      metadataStub(assets, agents),
      SUPER_ADMIN,
      aclStub([]),
    );
    expect(denied).toEqual([
      { teamId: "team-x", userId: "usr-x", agentId: "agt-x", agentName: "agt-x", isSelf: true },
    ]);
  });
});

describe("automatic profile injection scope", () => {
  it("injects the configured cross-team sources for the super-admin team", async () => {
    const seen: Array<{ path: string; agentId: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as { agent_id?: string };
      const agentId = body.agent_id ?? "";
      seen.push({ path: url, agentId });
      if (url.endsWith("/v3/core/read")) {
        return new Response(JSON.stringify({ code: 0, data: { content: `persona of ${agentId}` } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v3/scenario/ls")) {
        return new Response(JSON.stringify({ code: 0, data: { entries: [{ path: `scenes/${agentId}.md`, summary: "s" }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected kernel call: ${url}`);
    });

    const baseConfig: TdaiMemoryConfig = {
      enabled: true,
      endpoint: "https://kernel.test",
      apiKey: "svc-token",
      serviceId: "default",
      writeL0: false,
      recallL1: true,
      injectL2L3: true,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1500,
    };
    const injector = new TdaiProfileMemoryInjector(baseConfig, null, SUPER_ADMIN);
    const blocks = await injector.execute(
      agentCtx({
        session: {
          session_id: "sess-super",
          team_id: "team-super",
          user_id: "usr-super",
          agent_id: "agt-super",
          user_key: "sk-super",
          space_id: "default",
        },
        userKey: "sk-super",
      }),
    );
    const text = blocks.map((block) => block.content).join("\n");

    expect(text).toContain('<agent name="team-a" role="imported_from" agent_id="agt-a">');
    expect(text).toContain('<agent name="team-b" role="imported_from" agent_id="agt-b">');
    expect(text).toContain('<agent name="agt-super" role="self" agent_id="agt-super">');
    expect(seen.filter((call) => call.path.endsWith("/v3/core/read")).map((call) => call.agentId)).toEqual([
      "agt-super",
      "agt-a",
      "agt-b",
    ]);
  });
});

interface UpstreamCall {
  url: string;
  body: Record<string, unknown>;
}

function bridgeContext(sub: string, body: Record<string, unknown>, sessionId: string): Context {
  return {
    req: {
      url: `http://proxy.test/memory-bridge/v3/${sub}`,
      method: "POST",
      header: (name: string) => {
        const headers: Record<string, string> = {
          "x-conversation-id": sessionId,
          "x-tdai-service-id": "default",
          "content-type": "application/json",
        };
        return headers[name.toLowerCase()];
      },
      text: async () => JSON.stringify(body),
    },
  } as unknown as Context;
}

async function seedSession(sessionId: string, sessionInfo: SessionInfo): Promise<void> {
  await getSessionStore().set(sessionId, {
    status: "initialized",
    keyId: sessionId,
    startedAt: Date.now(),
    attemptCount: 0,
    sessionInfo,
  });
}

function upstreamStub(calls: UpstreamCall[], data: Record<string, unknown> = { items: [] }): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Kernel HTTP stub for the same-team fixed-asset listing. */
function kernelStub(items: FixedAssetItem[] = []): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/v3/meta/agent-fixed-asset/list-with-detail")) {
      return new Response(JSON.stringify({ code: 0, data: { agent: {}, items, total: items.length, limit: 100, offset: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected kernel call: ${url}`);
  });
}

describe("memory-bridge source scope", () => {
  it("lets the super-admin search every configured source and marks each hit's source", async () => {
    await seedSession("sess-super", {
      session_id: "sess-super",
      team_id: "team-super",
      user_id: "usr-super",
      agent_id: "agt-super",
      user_key: "sk-super",
      space_id: "default",
    });
    const calls: UpstreamCall[] = [];
    const handler = createMemoryBridgeHandler(makeConfig(), {
      fetcher: upstreamStub(calls, { items: [{ id: "m-1", content: "c-1", score: 1 }] }),
    });

    const res = await handler(bridgeContext("atomic/search", { query: "hello", limit: 5 }, "sess-super"));
    const envelope: {
      code: number;
      data: {
        items: Array<{ source_agent_id: string; source_agent_role: string }>;
        searched_agents: Array<{ agent_id: string; role: string }>;
      };
    } = await res.json();

    expect(res.status).toBe(200);
    expect(calls.map((call) => [call.body.team_id, call.body.agent_id])).toEqual([
      ["team-super", "agt-super"],
      ["team-a", "agt-a"],
      ["team-b", "agt-b"],
    ]);
    expect(envelope.data.items.map((item) => item.source_agent_id)).toEqual(["agt-super", "agt-a", "agt-b"]);
    expect(envelope.data.items.map((item) => item.source_agent_role)).toEqual(["self", "imported_from", "imported_from"]);
    expect(envelope.data.searched_agents.map((entry) => entry.agent_id)).toEqual(["agt-super", "agt-a", "agt-b"]);
  });

  it("keeps a normal agent self-only and refuses a configured source agent", async () => {
    await seedSession("sess-x", {
      session_id: "sess-x",
      team_id: "team-x",
      user_id: "usr-x",
      agent_id: "agt-x",
      user_key: "sk-x",
      space_id: "default",
    });
    kernelStub();
    const calls: UpstreamCall[] = [];
    const handler = createMemoryBridgeHandler(makeConfig(), {
      fetcher: upstreamStub(calls, { items: [{ id: "m-x", content: "c-x", score: 1 }] }),
    });

    const res = await handler(bridgeContext("atomic/search", { query: "hello" }, "sess-x"));
    const envelope: {
      data: { items: Array<{ source_agent_id: string; source_agent_role: string }> };
    } = await res.json();

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.body.agent_id)).toEqual(["agt-x"]);
    expect(envelope.data.items.map((item) => item.source_agent_id)).toEqual(["agt-x"]);
    expect(envelope.data.items.map((item) => item.source_agent_role)).toEqual(["self"]);

    const denied = await handler(
      bridgeContext("scenario/ls", { agent_id: "agt-a", path_prefix: "" }, "sess-x"),
    );
    const deniedBody: { code: number } = await denied.json();
    expect(denied.status).toBe(403);
    expect(deniedBody.code).toBe(40303);
  });

  it("rejects a super-admin write aimed at another source with 403 and no upstream call", async () => {
    await seedSession("sess-super", {
      session_id: "sess-super",
      team_id: "team-super",
      user_id: "usr-super",
      agent_id: "agt-super",
      user_key: "sk-super",
      space_id: "default",
    });
    const calls: UpstreamCall[] = [];
    const handler = createMemoryBridgeHandler(makeConfig(), { fetcher: upstreamStub(calls) });

    const res = await handler(
      bridgeContext("conversation/add", { agent_id: "agt-a", messages: [{ role: "user", content: "hi" }] }, "sess-super"),
    );
    const body: { code: number } = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe(40304);
    expect(calls).toHaveLength(0);
  });

  it("still forwards a super-admin write to its own memory", async () => {
    await seedSession("sess-super", {
      session_id: "sess-super",
      team_id: "team-super",
      user_id: "usr-super",
      agent_id: "agt-super",
      user_key: "sk-super",
      space_id: "default",
    });
    const calls: UpstreamCall[] = [];
    const handler = createMemoryBridgeHandler(makeConfig(), { fetcher: upstreamStub(calls, { ok: true }) });

    const res = await handler(
      bridgeContext("conversation/add", { messages: [{ role: "user", content: "hi" }] }, "sess-super"),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://kernel.test/v3/conversation/add");
    expect(calls[0].body.team_id).toBe("team-super");
    expect(calls[0].body.agent_id).toBe("agt-super");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
