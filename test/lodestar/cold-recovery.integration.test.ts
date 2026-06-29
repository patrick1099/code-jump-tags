import { describe, it, expect } from "vitest";
import {
  resolveTagLine,
  matchAnchor,
  backfillOriginal,
  similarity,
  normalizeWs
} from "../../src/lodestar/relocate";
import type { LodestarStore } from "../../src/lodestar/types";

// End-to-end exercise of Plan 1's cold-recovery brain: a tag whose stored line
// number has gone stale (lines inserted/removed above) and whose line text may
// have been lightly renamed, resolves back to the REAL line via the immutable
// `original` identity anchor first, then falls to `current`, then to nothing.
// This is the logic-level stand-in for the manual VS Code check
// (build tag -> close -> externally rename that line -> reopen -> tag finds it).

const ANCHOR = "static int compute_crc16(const uint8_t *buf, int len)";

// The file AFTER an external edit: 4 lines were inserted at the top, so the
// anchored function signature has drifted from its original line down to line 6.
function fileWithSignature(signatureLine: string): string {
  return [
    "// added header comment 1", // 1
    "// added header comment 2", // 2
    "// added header comment 3", // 3
    "#include <stdint.h>", //        4
    "", //                          5
    signatureLine, //               6  <- the tag's real line now
    "{", //                         7
    "    return 0;", //             8
    "}" //                          9
  ].join("\n");
}

describe("cold recovery (Plan 1 integration)", () => {
  it("heals through pure line drift: identical text found at the new line via original", () => {
    const file = fileWithSignature(ANCHOR);
    // Tag was created when the signature sat at line 2; original === current === text.
    const stored = 2;

    const m = matchAnchor(file, stored, ANCHOR, ANCHOR);
    expect(m).toEqual({ status: "original", line: 6 });
    expect(resolveTagLine(file, stored, ANCHOR, ANCHOR)).toBe(6);
  });

  it("heals through a light rename: buf -> buffer stays >= 0.9 similar, original still matches", () => {
    const renamed = "static int compute_crc16(const uint8_t *buffer, int len)";
    // Precondition: the rename is small enough to clear the single threshold.
    expect(similarity(normalizeWs(ANCHOR), normalizeWs(renamed))).toBeGreaterThanOrEqual(0.9);

    const file = fileWithSignature(renamed);
    const stored = 2;

    const m = matchAnchor(file, stored, ANCHOR, ANCHOR);
    expect(m).toEqual({ status: "original", line: 6 });
    expect(resolveTagLine(file, stored, ANCHOR, ANCHOR)).toBe(6);
  });

  it("falls to current when original is gone: heavy rename recognised by the live anchor", () => {
    const heavyRename = "static uint16_t calc_frame_checksum(const uint8_t *frame, size_t n)";
    // Precondition: the rename is too large for original to match (below threshold)...
    expect(similarity(normalizeWs(ANCHOR), normalizeWs(heavyRename))).toBeLessThan(0.9);

    const file = fileWithSignature(heavyRename);
    const stored = 2;

    // original (old identity) misses; current (= the new text) rescues it.
    const m = matchAnchor(file, stored, ANCHOR, heavyRename);
    expect(m).toEqual({ status: "current", line: 6 });
    expect(resolveTagLine(file, stored, ANCHOR, heavyRename)).toBe(6);
  });

  it("reports lost and keeps the stored line when neither anchor matches", () => {
    const unrelated = "double newtons_method(double x0, double eps)";
    const file = fileWithSignature(unrelated);
    const stored = 2;

    const m = matchAnchor(file, stored, ANCHOR, ANCHOR);
    expect(m).toEqual({ status: "lost", line: 2 });
    // No usable anchor and no pattern -> the stored line is returned unchanged.
    expect(resolveTagLine(file, stored, ANCHOR, ANCHOR)).toBe(2);
  });

  it("legacy tag with no original: backfill seeds it from text, then cold recovery heals", () => {
    // A tag persisted before 0.7.0: it has `text` (current) but no `original`.
    const store: LodestarStore = {
      version: 1,
      tree: [
        {
          type: "folder",
          id: "f",
          title: "x",
          children: [
            { type: "tag", id: "t", note: "", file: "crc.c", line: 2, text: ANCHOR }
          ]
        }
      ]
    } as any;

    backfillOriginal(store);
    const tag = (store.tree[0] as any).children[0];
    expect(tag.original).toBe(ANCHOR); // identity seeded once from the live text

    // After backfill the tag recovers exactly like a natively-created one.
    const file = fileWithSignature(ANCHOR);
    expect(resolveTagLine(file, tag.line, tag.original, tag.text)).toBe(6);
  });
});
