import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";

export type AdminAuthResult = "ok" | "missing" | "invalid";

/** Shared Bearer authentication for proxy administration endpoints. */
export function checkAdminAuth(c: Context, expected: string): AdminAuthResult {
  if (!expected) return "ok";

  const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return "missing";

  const provided = header.slice("Bearer ".length).trim();
  if (!provided) return "missing";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "ok" : "invalid";
}

export function adminAuthError(c: Context, result: Exclude<AdminAuthResult, "ok">): Response {
  const message = result === "missing"
    ? "Unauthorized: missing Bearer token"
    : "Unauthorized: invalid token";
  return c.json({ code: 401, message }, 401);
}

type AdminHandler = (c: Context) => Response | Promise<Response>;

/**
 * Fail-closed wrapper for ops endpoints reached over a public gateway domain.
 * `checkAdminAuth` treats an empty expected key as "allow", which is fine on a
 * private network but publishes these routes outright when the key is missing.
 * An unconfigured key therefore closes the endpoint instead of opening it.
 */
export function requireAdmin(apiKey: string | undefined, handler: AdminHandler): AdminHandler {
  return (c) => {
    const expected = (apiKey ?? "").trim();
    if (!expected) {
      return c.json({ code: 503, message: "Endpoint disabled: admin.apiKey is not configured" }, 503);
    }
    const result = checkAdminAuth(c, expected);
    return result === "ok" ? handler(c) : adminAuthError(c, result);
  };
}
