import { describe, it, expect } from "vitest";
import { computeDeliveryRank } from "./delivery.js";

describe("computeDeliveryRank — fact text length warning", () => {
  it("stays silent at exactly the 200-char boundary", () => {
    const d = computeDeliveryRank(1, 1, 8, undefined, "z".repeat(200));
    expect(d.delivered).toBe(true);
    expect(d.warning).toBeUndefined();
  });

  it("warns one char over the boundary, naming the length and the remedy", () => {
    const d = computeDeliveryRank(1, 1, 8, undefined, "z".repeat(201));
    expect(d.warning).toMatch(/201 chars/);
    expect(d.warning).toMatch(/detail/);
  });

  it("is a warning only — never changes `delivered`", () => {
    const d = computeDeliveryRank(1, 1, 8, undefined, "z".repeat(500));
    expect(d.delivered).toBe(true);
  });

  it("joins with the other independent warnings rather than replacing them", () => {
    // rank past typicalLimit + pinned reserve over 75% + over-long text: three
    // separate checks, one joined warning string.
    const d = computeDeliveryRank(
      9,
      9,
      8,
      { renderedChars: 800, reserveChars: 1000 },
      "z".repeat(300),
    );
    expect(d.warning).toMatch(/rank 9 of 9/);
    expect(d.warning).toMatch(/facts reserve/);
    expect(d.warning).toMatch(/300 chars/);
    // joined, not replaced — the three checks appear in declaration order
    expect(d.warning!.indexOf("rank 9")).toBeLessThan(d.warning!.indexOf("facts reserve"));
    expect(d.warning!.indexOf("facts reserve")).toBeLessThan(d.warning!.indexOf("300 chars"));
  });

  it("omits the check entirely when no text is supplied", () => {
    const d = computeDeliveryRank(1, 1, 8);
    expect(d.warning).toBeUndefined();
  });
});
