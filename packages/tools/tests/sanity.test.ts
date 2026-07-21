import { describe, it, expect } from "vitest";
import { TOOLS_VERSION } from "../src/index.js";

describe("sanity", () => {
  it("exports TOOLS_VERSION", () => {
    expect(TOOLS_VERSION).toBe("0.1.0");
  });
});
