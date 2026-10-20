import { describe, expect, it } from "vitest";
import { parseConfig } from "./src/config.js";

describe("local embedding config", () => {
  it("disables local embedding in user config", () => {
    const c = parseConfig({ embedding: { provider: "local" } });
    expect(c.embedding.provider).toBe("none");
    expect(c.embedding.enabled).toBe(false);
    expect(c.embedding.dimensions).toBe(0);
  });
});
