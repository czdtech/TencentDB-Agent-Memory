/**
 * Caller scope. Headers are the authority. A body field may fill a hole.
 * A body field that disagrees with a header is rejected.
 */

export interface CallerScope {
  teamId: string;
  userId: string;
  agentId: string;
  sessionId: string;
}

export type ScopeDecision =
  | { ok: true; scope: CallerScope }
  | { ok: false; status: 422 | 403; message: string };

export interface ScopeInput {
  headerTeamId?: string;
  headerUserId?: string;
  headerAgentId?: string;
  headerSessionId?: string;
  bodyTeamId?: string;
  bodyUserId?: string;
  bodyAgentId?: string;
  bodySessionId?: string;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function oneField(name: string, header: string, body: string): { ok: true; value: string } | { ok: false; status: 403 | 422; message: string } {
  if (header && body && header !== body) {
    return { ok: false, status: 403, message: `body ${name} conflicts with the authenticated header` };
  }
  const value = header || body;
  if (!value) return { ok: false, status: 422, message: `missing ${name}` };
  return { ok: true, value };
}

export function resolveCallerScope(input: ScopeInput): ScopeDecision {
  const team = oneField("team_id", clean(input.headerTeamId), clean(input.bodyTeamId));
  if (!team.ok) return team;
  const user = oneField("user_id", clean(input.headerUserId), clean(input.bodyUserId));
  if (!user.ok) return user;
  const agent = oneField("agent_id", clean(input.headerAgentId), clean(input.bodyAgentId));
  if (!agent.ok) return agent;
  const session = clean(input.headerSessionId) || clean(input.bodySessionId) || "v1";
  return {
    ok: true,
    scope: { teamId: team.value, userId: user.value, agentId: agent.value, sessionId: session },
  };
}

export function headerValue(headers: Record<string, unknown>, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return clean(raw[0]);
  return clean(raw);
}

export function scopeFromHttp(headers: Record<string, unknown>, body: Record<string, unknown> | undefined): ScopeDecision {
  return resolveCallerScope({
    headerTeamId: headerValue(headers, "x-tdai-team-id"),
    headerUserId: headerValue(headers, "x-tdai-user-id"),
    headerAgentId: headerValue(headers, "x-tdai-agent-id"),
    headerSessionId: headerValue(headers, "x-tdai-session-id"),
    bodyTeamId: clean(body?.team_id),
    bodyUserId: clean(body?.user_id),
    bodyAgentId: clean(body?.agent_id),
    bodySessionId: clean(body?.session_id) || clean(body?.session_key),
  });
}
