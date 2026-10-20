/**
 * Shared helper for chat_memory injectors.
 * Retrieval uses the caller's own team, plus — for the configured super-admin
 * team only — the explicit `superAdmin.sources` list. Injection text uses a
 * separate cap.
 *
 * Now uses MetadataClient (kernel /v3/meta/agent-fixed-asset/list-with-detail)
 * instead of TMC's proxy endpoint.
 */

import type { AgentContext } from "../types.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import type { MetadataClient } from "../../meta/client.js";
import type { MemorySuperAdminConfig } from "../../types.js";
import { checkAclOrDeny, type TdaiClient } from "../../tdai/client.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FixedAssetCtx {
  teamId: string;
  userId: string;
  agentId: string;
  agentName: string;
  isSelf: boolean;
}

const CACHE_KEY = "__tdaiFixedAssetCtxs";

export function injectionSummary<T>(items: T[], cap: number): T[] {
  if (!Number.isFinite(cap) || cap < 0) return items;
  return items.slice(0, cap);
}

/**
 * Cross-team memory visibility is opt-in and comes from configuration only:
 * a caller always sees its own team, and a caller on the configured
 * super-admin team additionally sees exactly the teams listed in
 * `superAdmin.sources`. Nothing else is cross-team visible — in particular a
 * non super-admin caller never gains visibility from a configured source list.
 */
export function sourceTeamVisible(
  callerTeamId: string,
  sourceTeamId: string,
  superAdmin?: MemorySuperAdminConfig,
): boolean {
  if (sourceTeamId === callerTeamId) return true;
  if (!superAdmin?.enabled || callerTeamId !== superAdmin.team_id) return false;
  return superAdmin.sources.some((source) => source.team_id === sourceTeamId);
}

/** The configured source list applies to the super-admin team only. */
function configuredSourcesFor(
  identity: TdaiIdentity,
  superAdmin?: MemorySuperAdminConfig,
): MemorySuperAdminConfig["sources"] {
  if (!superAdmin?.enabled || identity.teamId !== superAdmin.team_id) return [];
  return superAdmin.sources;
}

function parseChatMemoryAssetId(assetId: string): { teamId: string; agentId: string } | null {
  if (!assetId.startsWith("chat_memory-")) return null;
  const inner = assetId.slice("chat_memory-".length);
  const marker = "-agt";
  const dashAgt = inner.lastIndexOf(marker);
  if (dashAgt >= 0) {
    return { teamId: inner.slice(0, dashAgt), agentId: inner.slice(dashAgt + 1) };
  }
  if (inner === "default") return { teamId: "default", agentId: "default" };
  if (inner.startsWith("default-")) return { teamId: "default", agentId: inner.slice("default-".length) };
  return null;
}

// ── Resolver ───────────────────────────────────────────────────────────────────

/**
 * Get [self, ...imported] ctx. Within a single request, repeat calls hit the
 * ctx cache and do NOT re-call the kernel.
 *
 * Scope:
 *   - super-admin team → self + the configured `superAdmin.sources`, each kept
 *     with its own (team_id, user_id, agent_id, name). No ACL round-trip: the
 *     source list itself is the authorization.
 *   - every other team  → self + the agent's same-team chat_memory bindings,
 *     each gated by the kernel ACL (fail-closed when `aclClient` is absent).
 *
 * Fails gracefully: if kernel is unreachable or the agent has no fixed assets,
 * returns a single entry representing `identity` itself.
 */
export async function resolveFixedAssetCtxs(
  ctx: AgentContext,
  identity: TdaiIdentity,
  client: Pick<MetadataClient, "getAgentFixedAssets" | "getAgent"> | null,
  superAdmin?: MemorySuperAdminConfig,
  aclClient: Pick<TdaiClient, "checkAcl"> | null = null,
): Promise<FixedAssetCtx[]> {
  const custom = (ctx.metadata.custom ?? {}) as Record<string, unknown>;
  const cached = custom[CACHE_KEY] as FixedAssetCtx[] | undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;

  const selfCtx: FixedAssetCtx = {
    teamId: identity.teamId,
    userId: identity.userId,
    agentId: identity.agentId,
    agentName: identity.agentId,
    isSelf: true,
  };

  const configuredSources = configuredSourcesFor(identity, superAdmin);
  if (configuredSources.length > 0) {
    const imported = configuredSources
      .filter((source) =>
        !(source.team_id === identity.teamId
          && source.user_id === identity.userId
          && source.agent_id === identity.agentId))
      .map((source) => ({
        teamId: source.team_id,
        userId: source.user_id,
        agentId: source.agent_id,
        agentName: source.name ?? source.agent_id,
        isSelf: false,
      }));
    const result = [selfCtx, ...imported];
    custom[CACHE_KEY] = result;
    ctx.metadata.custom = custom;
    return result;
  }

  if (!client) {
    const list = [selfCtx];
    custom[CACHE_KEY] = list;
    ctx.metadata.custom = custom;
    return list;
  }

  let result: FixedAssetCtx[] = [selfCtx];
  try {
    // 只关心 chat_memory 绑定（下方循环 `item.asset_type !== "chat_memory"` 一律跳过），
    // 让 core 在 SQL 层过滤：无关类型（skill / wiki / code_graph）不再占分页额度，
    // 避免 skill 特别多的 agent（实际线上 519 skill）把 chat_memory 挤出翻页硬上限。
    const detail = await client.getAgentFixedAssets(identity.agentId, { assetTypes: ["chat_memory"] });
    // 内核侧 agent 记录带展示名时用它，保持 self 段与改造前一致。
    const kernelSelfName = detail.agent.name;
    const self = typeof kernelSelfName === "string" && kernelSelfName
      ? { ...selfCtx, agentName: kernelSelfName }
      : selfCtx;

    const items: FixedAssetCtx[] = [];
    for (const item of detail.items) {
      if (item.asset_type !== "chat_memory") continue;
      const explicit = item as { team_id?: string; agent_id?: string };
      const parsed = explicit.team_id && explicit.agent_id
        ? { teamId: explicit.team_id, agentId: explicit.agent_id }
        : parseChatMemoryAssetId(item.asset_id);
      if (!parsed) continue;
      if (parsed.agentId === identity.agentId && parsed.teamId === identity.teamId) continue;
      if (!sourceTeamVisible(identity.teamId, parsed.teamId, superAdmin)) continue;

      try {
        const sourceAgent = await client.getAgent(parsed.agentId);
        if (sourceAgent.agent_id !== parsed.agentId) continue;
        if (!sourceTeamVisible(identity.teamId, sourceAgent.team_id, superAdmin)) continue;
        // Imported memories are assets, not implicit team visibility: the kernel
        // ACL is the authorization for reading another agent's L1/L2/L3.
        // prewarm 路径的 custom 只有 session（没有 custom.userKey），回退到
        // SessionInfo.user_key。
        const session = custom.session;
        const sessionUserKey = session && typeof session === "object" && "user_key" in session
          && typeof session.user_key === "string" ? session.user_key : undefined;
        const userKey = identity.userKey ?? sessionUserKey;
        if (!aclClient || !userKey) continue;
        const acl = await checkAclOrDeny(aclClient, {
          user_key: userKey,
          asset_id: `chat_memory-${sourceAgent.team_id}-${sourceAgent.agent_id}`,
          agent_id: identity.agentId,
          action: "read",
        });
        if (!acl.allowed) continue;
        items.push({
          teamId: sourceAgent.team_id,
          userId: sourceAgent.owner_user_id ?? identity.userId,
          agentId: sourceAgent.agent_id,
          agentName: sourceAgent.name || item.name || sourceAgent.agent_id,
          isSelf: false,
        });
      } catch {
        // 绑定的来源 agent 已删除/不可见时跳过，避免用 chat_memory asset_id 当 agent_id 查询导致空召回。
      }
    }

    if (items.length > 0) result = [self, ...items];
  } catch (err) {
    // Silently degrade: inject only self
    console.warn("[fixed-asset] kernel error, injecting only self:", (err as Error).message);
  }

  custom[CACHE_KEY] = result;
  ctx.metadata.custom = custom;
  return result;
}
