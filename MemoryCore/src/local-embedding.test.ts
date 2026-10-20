import { describe, expect, it } from "vitest";
import { parseConfig } from "./src/config.js";
describe("local embedding config", () => { it("enables local with 768 dims", () => { const c = parseConfig({ embedding: { provider: "local" } }); expect(c.embedding.provider).toBe("local"); expect(c.embedding.enabled).toBe(true); expect(c.embedding.dimensions).toBe(768); }); });
