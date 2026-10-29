/** Resolve a named upstream route from the first URL path segment. */
export function resolveNamedRoute(requestPath: string, fallbackAgent: string): string {
  const parts = requestPath.split("?")[0].split("/").filter(Boolean);
  if (parts.length === 0) return fallbackAgent;
  const protocolSegments = new Set(["v1", "responses", "proxy", "skill-bridge", "memory-bridge"]);
  return protocolSegments.has(parts[0]) ? fallbackAgent : parts[0];
}

/** Aliases that predate the config-driven map (kept for existing deployments). */
const BUILTIN_CLIENT_ALIASES: Record<string, string> = {
  "tencent-cc-no": "claude-code",
};

/**
 * Map a named route to the client family whose dialect/session behavior applies.
 * The route name keeps selecting the upstream (`upstream.agents[route]`); only
 * the client side — adapter, injection profile, session key — is remapped.
 * Config: `upstream.clientAliases`.
 */
export function resolveClientAgentSource(
  routeName: string,
  aliases?: Record<string, string>,
): string {
  return aliases?.[routeName] ?? BUILTIN_CLIENT_ALIASES[routeName] ?? routeName;
}
