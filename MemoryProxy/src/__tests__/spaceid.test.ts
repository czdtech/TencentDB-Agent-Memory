import { describe, expect, it } from "vitest";
import { extractSpaceIdFromPath } from "../credit-reporter.js";

describe("extractSpaceIdFromPath", () => {
  it("extracts spaceId from a named TencentDB route", () => {
    expect(extractSpaceIdFromPath("/tencent-glm/default/v1/chat/completions")).toBe("default");
    expect(extractSpaceIdFromPath("/newapi-tencent-pro/default/v1/chat/completions")).toBe("default");
    expect(extractSpaceIdFromPath("/cliproxyapi-tencent-gemini/default/v1/chat/completions")).toBe("default");
    expect(extractSpaceIdFromPath("/newapi-tencent-pro-low/default/v1/chat/completions")).toBe("default");
  });
});
