import { describe, expect, it } from "vitest";

import { sanitizeFtsToken, sanitizeFtsWhitelist } from "./tokenize.js";

describe("FTS5 query sanitization", () => {
  it("wraps tokens as quoted phrases and escapes embedded quotes", () => {
    expect(sanitizeFtsToken('a"b')).toBe('"a""b"');
    expect(sanitizeFtsToken("AND")).toBe('"AND"');
    expect(sanitizeFtsToken("*")).toBe('"*"');
  });

  it("whitelists raw query input before tokenisation", () => {
    expect(sanitizeFtsWhitelist('a"b * (c) AND')).toBe("a b c AND");
  });
});
