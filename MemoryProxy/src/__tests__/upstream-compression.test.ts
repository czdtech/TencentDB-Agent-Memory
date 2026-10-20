import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { zstdCompressSync } from "node:zlib";
import type { Context } from "hono";
import { buildUpstreamHeaders, extractSseUsage } from "../pipeline/runners/openai-chat.js";
import { stageForwardWithRetry } from "../pipeline/stages/forward-with-retry.js";

const SSE_BODY = [
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const JSON_BODY = {
  id: "chatcmpl-2",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_2", type: "function", function: { name: "shell", arguments: '{"cmd":"pwd"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

let server: Server;
let upstreamUrl = "";
let lastAcceptEncoding = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastAcceptEncoding = String(req.headers["accept-encoding"] ?? "");
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const parsed = raw ? (JSON.parse(raw) as { stream?: boolean }) : {};
      const payload = parsed.stream ? SSE_BODY : JSON.stringify(JSON_BODY);
      const wantsZstd = lastAcceptEncoding.toLowerCase().includes("zstd");
      const body = wantsZstd ? zstdCompressSync(Buffer.from(payload)) : Buffer.from(payload);
      res.writeHead(200, {
        "content-type": parsed.stream ? "text/event-stream" : "application/json",
        ...(wantsZstd ? { "content-encoding": "zstd" } : {}),
        "content-length": String(body.length),
      });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeContext(headers: Record<string, string>): Context {
  const h = new Headers(headers);
  return {
    req: {
      raw: { headers: h },
      header: (name: string) => h.get(name) ?? undefined,
    },
  } as unknown as Context;
}

function makePipe() {
  return {
    info: () => {},
    error: () => {},
    forwardDone: () => {},
  } as never;
}

async function forward(headers: Record<string, string>, body: Record<string, unknown>) {
  return stageForwardWithRetry({
    target: { url: upstreamUrl, model: "deepseek-chat", retryTarget: null } as never,
    upstreamHeaders: headers,
    upstreamBody: body,
    originalBody: body,
    originalHeaders: headers,
    pipe: makePipe(),
    forwardTimeoutMs: 5000,
    protocol: "openai",
    timeoutBehavior: "gated",
    buildRetryBody: (original, retryModel) => ({ ...original, model: retryModel }),
  });
}

const CLIENT_HEADERS = {
  "accept-encoding": "zstd, br, gzip",
  "content-type": "application/json",
};

describe("upstream compression negotiation (fake origin)", () => {
  it("streams plain SSE with tool calls and usage when headers come from the runner", async () => {
    const headers = buildUpstreamHeaders(
      makeContext(CLIENT_HEADERS),
      {} as never,
      {} as never,
      undefined,
      "",
    );
    const { resp } = await forward(headers, { model: "deepseek-chat", stream: true });

    expect(lastAcceptEncoding).toBe("identity");
    expect(resp.headers.get("content-encoding")).toBeNull();

    const text = await resp.text();
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"name":"shell"');
    expect(text).toContain("data: [DONE]");
    expect(extractSseUsage(text)).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it("parses non-stream tool-call JSON without an encoding header", async () => {
    const headers = buildUpstreamHeaders(
      makeContext(CLIENT_HEADERS),
      {} as never,
      {} as never,
      undefined,
      "",
    );
    const { resp } = await forward(headers, { model: "deepseek-chat", stream: false });

    expect(lastAcceptEncoding).toBe("identity");
    expect(resp.headers.get("content-encoding")).toBeNull();

    const payload = JSON.parse(await resp.text()) as typeof JSON_BODY;
    expect(payload.choices[0].message.tool_calls[0].function.name).toBe("shell");
    expect(payload.usage.total_tokens).toBe(8);
  });

  it("positive control: forwarding the client's raw zstd header yields compressed, unparsable bytes", async () => {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "deepseek-chat", stream: true }),
    });

    expect(lastAcceptEncoding).toBe("zstd, br, gzip");
    expect(resp.headers.get("content-encoding")).toBe("zstd");

    const bytes = Buffer.from(await resp.arrayBuffer());
    expect(bytes.subarray(0, 4).equals(ZSTD_MAGIC)).toBe(true);
    expect(bytes.includes(Buffer.from('"finish_reason":"stop"'))).toBe(false);
  });
});
