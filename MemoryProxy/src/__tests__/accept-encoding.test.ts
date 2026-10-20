import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  SKIP_REQUEST_HEADERS_HOP_BY_HOP,
  SKIP_REQUEST_HEADERS_WITH_INTERNAL,
  copyUpstreamRequestHeaders,
} from "../common/constants.js";
import { buildUpstreamHeaders as buildOpenAiUpstreamHeaders } from "../pipeline/runners/openai-chat.js";
import { buildUpstreamHeaders as buildAnthropicUpstreamHeaders } from "../pipeline/runners/anthropic.js";
import { buildUpstreamHeaders as buildCodexUpstreamHeaders } from "../pipeline/runners/codex.js";
import { buildUpstreamHeaders as buildWorkbuddyUpstreamHeaders } from "../pipeline/runners/workbuddy.js";
import { buildDirectRequestHeaders } from "../pipeline/runners/direct.js";
import { buildAuxUpstreamHeaders } from "../pipeline/runners/utility.js";
import { buildPassthroughHeaders } from "../systemUserPassthrough.js";

const CLIENT_HEADERS = {
  "accept-encoding": "zstd, br, gzip",
  "content-type": "application/json",
  "user-agent": "opencode/2.0.32",
  authorization: "Bearer client-entry-key",
  "x-tdai-user-key": "internal-identity",
};

function makeContext(init: Record<string, string> = CLIENT_HEADERS): Context {
  const headers = new Headers(init);
  return {
    req: {
      raw: { headers },
      header: (name: string) => headers.get(name) ?? undefined,
    },
  } as unknown as Context;
}

function acceptEncodingKeys(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((key) => key.toLowerCase() === "accept-encoding");
}

function expectIdentity(headers: Record<string, string>) {
  expect(acceptEncodingKeys(headers)).toEqual(["accept-encoding"]);
  expect(headers["accept-encoding"]).toBe("identity");
}

describe("copyUpstreamRequestHeaders", () => {
  it("replaces every client accept-encoding variant with identity", () => {
    const raw = new Headers();
    raw.append("accept-encoding", "zstd");
    raw.append("accept-encoding", "gzip, br");

    const headers = copyUpstreamRequestHeaders(raw, SKIP_REQUEST_HEADERS_HOP_BY_HOP);

    expectIdentity(headers);
    expect(headers["accept-encoding"]).not.toContain("zstd");
  });

  it("does not leak a mixed-case accept-encoding key from a headers-like source", () => {
    const source = {
      forEach(cb: (value: string, key: string) => void) {
        cb("zstd", "Accept-Encoding");
        cb("application/json", "Content-Type");
      },
    } as unknown as Headers;

    const headers = copyUpstreamRequestHeaders(source, new Set());

    expectIdentity(headers);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("keeps ordinary client headers and drops only skipped ones", () => {
    const headers = copyUpstreamRequestHeaders(
      makeContext().req.raw.headers,
      SKIP_REQUEST_HEADERS_WITH_INTERNAL,
    );

    expect(headers["user-agent"]).toBe("opencode/2.0.32");
    expect(headers["authorization"]).toBe("Bearer client-entry-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-tdai-user-key"]).toBeUndefined();
  });

  it("is wired into both shared skip sets", () => {
    expect(SKIP_REQUEST_HEADERS_HOP_BY_HOP.has("accept-encoding")).toBe(true);
    expect(SKIP_REQUEST_HEADERS_WITH_INTERNAL.has("accept-encoding")).toBe(true);
  });
});

describe("runner upstream header builders", () => {
  const config = {
    upstream: { apiKey: "server-upstream-key" },
    costGuard: { anthropicUpstream: undefined },
  } as never;

  it("openai-chat forces identity on primary and retry headers", () => {
    const primary = buildOpenAiUpstreamHeaders(makeContext(), config, {} as never, undefined, "");
    expectIdentity(primary);
    expect(primary["authorization"]).toBe("Bearer client-entry-key");

    const retry = copyUpstreamRequestHeaders(
      makeContext().req.raw.headers,
      SKIP_REQUEST_HEADERS_HOP_BY_HOP,
    );
    expectIdentity(retry);
  });

  it("anthropic forces identity and keeps the x-api-key override path intact", () => {
    const headers = buildAnthropicUpstreamHeaders(
      makeContext(),
      config,
      {} as never,
      undefined,
      "server-upstream-key",
    );

    expectIdentity(headers);
    expect(headers["x-api-key"]).toBe("server-upstream-key");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("codex forces identity", () => {
    expectIdentity(buildCodexUpstreamHeaders(makeContext(), config));
  });

  it("workbuddy forces identity", () => {
    expectIdentity(buildWorkbuddyUpstreamHeaders(makeContext(), config));
  });

  it("direct forces identity and strips the internal identity header", () => {
    const headers = buildDirectRequestHeaders(makeContext());

    expectIdentity(headers);
    expect(headers["x-tdai-user-key"]).toBeUndefined();
  });

  it("utility forces identity for both openai and anthropic whitelist entries", () => {
    for (const protocol of ["openai", "anthropic"] as const) {
      const headers = buildAuxUpstreamHeaders(makeContext(), config, { protocol } as never);
      expectIdentity(headers);
    }
  });

  it("system-user passthrough forces identity and swaps the entry key", () => {
    const headers = buildPassthroughHeaders(makeContext(), config);

    expectIdentity(headers);
    expect(headers["authorization"]).toBe("Bearer server-upstream-key");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
