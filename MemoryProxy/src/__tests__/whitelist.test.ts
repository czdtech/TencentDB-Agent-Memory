import { describe, expect, it } from "vitest";
import { matchWhitelistEndpoint, normalizeWhitelistRequestPath } from "../routes/whitelist.js";
import { joinUrl } from "../guard-adapter.js";

describe("whitelist matching and joinUrl for newapi/cliproxyapi prefixes", () => {
  it("normalizes paths with newapi- and cliproxyapi- prefixes", () => {
    expect(normalizeWhitelistRequestPath("/newapi-tencent-pro/default/v1/responses")).toBe("/v1/responses");
    expect(normalizeWhitelistRequestPath("/newapi-tencent-pro/default/responses")).toBe("/responses");
    expect(normalizeWhitelistRequestPath("/newapi-tencent-cc/default/v1/messages")).toBe("/v1/messages");
    expect(normalizeWhitelistRequestPath("/cliproxyapi-tencent-gemini/default/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("matches whitelist endpoint for newapi-tencent-pro responses", () => {
    const entry = matchWhitelistEndpoint("/newapi-tencent-pro/default/v1/responses");
    expect(entry).not.toBeNull();
    expect(entry?.pathSuffix).toBe("/v1/responses");
    expect(entry?.upstreamEndpoint).toBe("/responses");
  });

  it("joins upstream URL with /responses instead of falling back to /chat/completions", () => {
    const upstream = joinUrl("https://new-api-production-e8f1.up.railway.app/v1", "/newapi-tencent-pro/default/v1/responses");
    expect(upstream).toBe("https://new-api-production-e8f1.up.railway.app/v1/responses");
  });
});
