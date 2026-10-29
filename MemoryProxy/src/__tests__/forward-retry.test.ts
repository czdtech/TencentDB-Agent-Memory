import { describe, expect, it, vi, afterEach } from "vitest";
import { stageForwardWithRetry } from "../pipeline/stages/forward-with-retry.js";
import type { ForwardTarget } from "../guard-adapter.js";
import type { createPipeline } from "../logger.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeTarget(overrides: Partial<ForwardTarget> = {}): ForwardTarget {
  return {
    url: "https://upstream.test/v1/chat/completions",
    model: "gemini-3.8-flash-high",
    retryTarget: null,
    ...overrides,
  } as unknown as ForwardTarget;
}

function makePipe() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    forwardDone: vi.fn(),
  } as unknown as ReturnType<typeof createPipeline>;
}

const body = { model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "test prompt" }] };

function run(pipe: ReturnType<typeof makePipe>, target: ForwardTarget) {
  return stageForwardWithRetry({
    target,
    upstreamHeaders: { "content-type": "application/json" },
    upstreamBody: body,
    originalBody: body,
    originalHeaders: { "content-type": "application/json" },
    pipe,
    forwardTimeoutMs: 5000,
    protocol: "openai",
    buildRetryBody: (original, retryModel) => ({ ...original, model: retryModel }),
  });
}

function jsonResponse(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("stageForwardWithRetry transient 502/503/504 in-place retry", () => {
  it("retries once on 502 and replays the identical body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? jsonResponse({ error: { message: "Bad Gateway" } }, 502)
        : jsonResponse(
            { id: "chatcmpl-test", choices: [{ message: { role: "assistant", content: "success after retry" } }] },
            200,
          );
    });

    const pipe = makePipe();
    const res = await run(pipe, makeTarget());

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual(JSON.parse(calls[1].init?.body as string));
    expect(res.resp.status).toBe(200);
    expect(pipe.error).not.toHaveBeenCalledWith("FORWARD_RETRY_FAILED", expect.anything());
  });

  it("stops at two attempts when 502 keeps coming back", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      return jsonResponse({ error: { message: "Bad Gateway Permanent" } }, 502);
    });

    const res = await run(makePipe(), makeTarget());

    expect(calls).toBe(2);
    expect(res.resp.status).toBe(502);
  });

  it("retries a connection failure and preserves the retry's 4xx", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed: connection reset");
      return jsonResponse({ error: { message: "Invalid model parameters" } }, 400);
    });

    const pipe = makePipe();
    const res = await run(pipe, makeTarget());

    expect(calls).toBe(2);
    expect(res.resp.status).toBe(400);
    expect(pipe.error).toHaveBeenCalledWith("FORWARD", expect.anything());
  });

  it("leaves routed-model retry to the caller instead of retrying in place", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      return jsonResponse({ error: { message: "Bad Gateway" } }, 502);
    });

    const target = makeTarget({ retryTarget: { url: "https://upstream.test/v1", model: "fallback-model" } as never });
    const pipe = makePipe();
    const res = await run(pipe, target);

    // retryTarget 存在时不就地重试；502 也不落在 routed-model 的 4xx 重试区间
    expect(calls).toBe(1);
    expect(res.retried).toBe(false);
    expect(res.resp.status).toBe(502);
    expect(pipe.info).not.toHaveBeenCalledWith("FORWARD_RETRY", expect.anything());
  });

  it("does not retry after a forward timeout", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      const err = new DOMException("timeout", "TimeoutError");
      throw err;
    });

    const pipe = makePipe();
    await expect(run(pipe, makeTarget())).rejects.toThrow();

    expect(calls).toBe(1);
    expect(pipe.error).toHaveBeenCalledWith("FORWARD", expect.stringContaining("Timeout"));
  });
});
