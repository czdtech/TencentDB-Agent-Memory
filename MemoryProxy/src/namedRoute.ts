/** Resolve a named upstream route from the first URL path segment. */
export function resolveNamedRoute(requestPath: string, fallbackAgent: string): string {
  const parts = requestPath.split("?")[0].split("/").filter(Boolean);
  if (parts.length === 0) return fallbackAgent;
  const protocolSegments = new Set(["v1", "responses", "proxy", "skill-bridge", "memory-bridge"]);
  return protocolSegments.has(parts[0]) ? fallbackAgent : parts[0];
}

/** Map a provider alias back to the client family used for session behavior. */
export function resolveClientAgentSource(routeName: string): string {
  return routeName === "tencent-cc-no" ? "claude-code" : routeName;
}
