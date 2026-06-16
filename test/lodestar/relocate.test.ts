import { describe, it, expect } from "vitest";
import { resolveLine } from "../../src/lodestar/relocate";

const text = ["void a(){", "  doThing();", "}", "", "case SU_RepeatMode:"].join("\n");

describe("resolveLine", () => {
  it("keeps the stored line when it still matches", () => {
    expect(resolveLine(text, 5, "case SU_RepeatMode:")).toBe(5);
  });
  it("relocates when the line drifted but pattern still matches", () => {
    expect(resolveLine(text, 2, "case SU_RepeatMode:")).toBe(5);
  });
  it("falls back to stored line when no pattern", () => {
    expect(resolveLine(text, 2)).toBe(2);
  });
  it("falls back to stored line when pattern is absent from file", () => {
    expect(resolveLine(text, 3, "no_such_token")).toBe(3);
  });
});
