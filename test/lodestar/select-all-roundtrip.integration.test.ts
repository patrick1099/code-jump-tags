import { describe, it, expect } from "vitest";
import {
  resolveTagLine,
  matchAnchor,
  similarity,
  normalizeWs
} from "../../src/lodestar/relocate";

// Models the exact gesture: select-all a file, cut, edit the content elsewhere,
// then paste it back (reordered + with insertions/deletions around the tagged
// line). The marker/jump position is recomputed by resolveTagLine from the
// STALE stored line, so the only thing that matters for recovery is whether a
// line matching `original` (then `current`) still exists in the final document.

const ANCHOR = "static int compute_crc16(const uint8_t *buf, int len)";

describe("select-all -> cut -> modify -> paste back (Plan 1)", () => {
  // The document AFTER the round-trip: heavily reorganised (the tag's old line 3
  // is meaningless now), many lines added above and below, the anchored line
  // survives intact but has drifted all the way down to line 13.
  const pastedBack = [
    "// ---- file header rewritten during the round-trip ----", // 1
    "#include <stdint.h>", //                                      2
    "#include <string.h>", //                                      3
    "#include \"crc.h\"", //                                       4
    "", //                                                         5
    "// a helper that did not exist before", //                    6
    "static uint8_t reflect8(uint8_t b)", //                       7
    "{", //                                                        8
    "    return b;", //                                            9
    "}", //                                                       10
    "", //                                                        11
    "// the tagged function, moved and surrounded by new code", // 12
    ANCHOR, //                                                    13  <- survives
    "{", //                                                       14
    "    uint16_t crc = 0xFFFF;", //                              15
    "    return crc;", //                                         16
    "}" //                                                        17
  ].join("\n");

  const STALE_STORED_LINE = 3; // where the tag sat before the whole-file churn

  it("recovers the tag when the tagged line itself survived the edit", () => {
    // original === current at creation; neither was touched by the live churn
    // (iron law: reanchor never writes original).
    const m = matchAnchor(pastedBack, STALE_STORED_LINE, ANCHOR, ANCHOR);
    expect(m).toEqual({ status: "original", line: 13 });
    expect(resolveTagLine(pastedBack, STALE_STORED_LINE, ANCHOR, ANCHOR)).toBe(13);
  });

  it("still recovers if the tagged line was lightly edited in the same round-trip", () => {
    const lightlyEdited = pastedBack.replace(
      ANCHOR,
      "static int compute_crc16(const uint8_t *buffer, int len)" // buf -> buffer
    );
    expect(
      similarity(
        normalizeWs(ANCHOR),
        normalizeWs("static int compute_crc16(const uint8_t *buffer, int len)")
      )
    ).toBeGreaterThanOrEqual(0.9);

    expect(resolveTagLine(lightlyEdited, STALE_STORED_LINE, ANCHOR, ANCHOR)).toBe(13);
  });

  it("survives a POISONED current: original still rescues it via the double match", () => {
    // Simulate the worst live case: during in-editor churn, reanchor adopted a
    // neighbour's text into `current` (poison). original is unchanged and the
    // real line still reads ANCHOR -> original-first match wins.
    const poisonedCurrent = "    return crc;"; // a wrong neighbour line's text
    const m = matchAnchor(pastedBack, STALE_STORED_LINE, ANCHOR, poisonedCurrent);
    expect(m.status).toBe("original");
    expect(m.line).toBe(13);
  });

  it("is honestly 'lost' only if the tagged line itself was rewritten beyond recognition", () => {
    // The user rewrote the tagged line during the modify step; nothing in the
    // final file is >= 0.9 similar to original or current.
    const rewritten = pastedBack.replace(
      ANCHOR,
      "double solve_quadratic(double a, double b, double c)"
    );
    const m = matchAnchor(rewritten, STALE_STORED_LINE, ANCHOR, ANCHOR);
    expect(m.status).toBe("lost");
    expect(m.line).toBe(STALE_STORED_LINE); // falls back to the stored line
  });
});
