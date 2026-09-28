import { describe, expect, it, vi, afterEach } from "vitest";
import { handleChatCompletions } from "../handler.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { ProxyConfig } from "../types.js";
import type { Context } from "hono";

describe("forwardWithRetry transient 502/503/504 retry logic", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("retries on 502 Bad Gateway and succeeds with identical body on second attempt", async () => {
    const upstreamCalls: Array<{ url: string; init?: RequestInit }> = [];

    global.fetch = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // Dispatch internal metadata/discovery endpoints to clean 200s
      if (url.includes("/instance-upstream/") || url.includes("/v3/internal/")) {
        return new Response(JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Upstream chat completions calls
      if (url.includes("/chat/completions")) {
        upstreamCalls.push({ url, init });
        if (upstreamCalls.length === 1) {
          return new Response(JSON.stringify({ error: { message: "Bad Gateway" } }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "success after retry" } }],
            usage: { total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const config: ProxyConfig = {
      ...DEFAULT_CONFIG,
      server: { host: "127.0.0.1", port: 8096, forwardTimeoutMs: 5000 },
      upstream: { url: "https://upstream.test/v1", apiKey: "test-key", agents: {} },
    };

    const mockContext = {
      req: {
        path: "/tencent-gemini/default/v1/chat/completions",
        header: () => "",
        json: async () => ({ model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "test prompt" }] }),
        raw: {
          headers: new Headers(),
        },
      },
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((val) => val),
      body: vi.fn().mockImplementation((val) => val),
    } as unknown as Context;

    const res = await handleChatCompletions(mockContext, config);

    // 1. Assert exactly 2 calls reached the actual upstream completion endpoint
    expect(upstreamCalls).toHaveLength(2);

    // 2. Assert request body and model are identical across retries
    const body1 = JSON.parse(upstreamCalls[0].init?.body as string);
    const body2 = JSON.parse(upstreamCalls[1].init?.body as string);
    expect(body1).toEqual(body2);
    expect(body1.model).toBe("gemini-3.8-flash-high");

    // 3. Assert final status is 200 and payload matches
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("success after retry");
  });

  it("fails with 502 after retry exhaustion when upstream returns consecutive 502s", async () => {
    const upstreamCalls: Array<{ url: string; init?: RequestInit }> = [];

    global.fetch = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/instance-upstream/") || url.includes("/v3/internal/")) {
        return new Response(JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/chat/completions")) {
        upstreamCalls.push({ url, init });
        return new Response(JSON.stringify({ error: { message: "Bad Gateway Permanent" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const config: ProxyConfig = {
      ...DEFAULT_CONFIG,
      server: { host: "127.0.0.1", port: 8096, forwardTimeoutMs: 5000 },
      upstream: { url: "https://upstream.test/v1", apiKey: "test-key", agents: {} },
    };

    const mockContext = {
      req: {
        path: "/tencent-gemini/default/v1/chat/completions",
        header: () => "",
        json: async () => ({ model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "test prompt" }] }),
        raw: {
          headers: new Headers(),
        },
      },
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((val) => val),
      body: vi.fn().mockImplementation((val) => val),
    } as unknown as Context;

    const res = await handleChatCompletions(mockContext, config);

    // Strictly 2 attempts made
    expect(upstreamCalls).toHaveLength(2);
    expect(res.status).toBe(502);
  });

  it("retries on initial connection failure and preserves 4xx response from retry", async () => {
    const upstreamCalls: Array<{ url: string; init?: RequestInit }> = [];

    global.fetch = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/instance-upstream/") || url.includes("/v3/internal/")) {
        return new Response(JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/chat/completions")) {
        upstreamCalls.push({ url, init });
        if (upstreamCalls.length === 1) {
          throw new TypeError("fetch failed: connection reset");
        }
        return new Response(JSON.stringify({ error: { message: "Invalid model parameters" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const config: ProxyConfig = {
      ...DEFAULT_CONFIG,
      server: { host: "127.0.0.1", port: 8096, forwardTimeoutMs: 5000 },
      upstream: { url: "https://upstream.test/v1", apiKey: "test-key", agents: {} },
    };

    const mockContext = {
      req: {
        path: "/tencent-gemini/default/v1/chat/completions",
        header: () => "",
        json: async () => ({ model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "test prompt" }] }),
        raw: {
          headers: new Headers(),
        },
      },
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((val) => val),
      body: vi.fn().mockImplementation((val) => val),
    } as unknown as Context;

    const res = await handleChatCompletions(mockContext, config);

    expect(upstreamCalls).toHaveLength(2);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toBe("Invalid model parameters");
  });
});
