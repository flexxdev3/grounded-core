import { beforeEach, describe, expect, it } from "vitest";
import { keepItem, loadSeen, markReviewed, newSince } from "./reviewState.js";

// vitest node env has no localStorage; shim one.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

const days = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

describe("reviewState", () => {
  it("starts empty and survives bad JSON", () => {
    expect(loadSeen()).toEqual({});
    store.set("grounded.review.lastSeen", "{nope");
    expect(loadSeen()).toEqual({});
  });

  it("never-reviewed lanes default to a 7-day window", () => {
    const items = [
      { id: 1, createdAt: days(1) },
      { id: 2, createdAt: days(10) },
    ];
    expect(newSince(items, "facts")).toEqual([items[0]]);
  });

  it("markReviewed moves the cutoff and honors updatedAt", () => {
    markReviewed("facts", new Date(days(2)));
    const fresh = { id: 1, createdAt: days(5), updatedAt: days(1) };
    const stale = { id: 2, createdAt: days(5), updatedAt: days(4) };
    expect(newSince([fresh, stale], "facts")).toEqual([fresh]);
  });

  it("keepItem hides one item; markReviewed clears kept sets", () => {
    const a = { id: 1, createdAt: days(1) };
    const b = { id: 2, createdAt: days(1) };
    keepItem("facts", 1);
    expect(newSince([a, b], "facts")).toEqual([b]);
    markReviewed("facts");
    expect(loadSeen().facts?.kept).toBeUndefined();
    expect(newSince([a, b], "facts")).toEqual([]);
  });

  it("lanes are independent", () => {
    markReviewed("facts", new Date(days(0)));
    const s = { id: 9, createdAt: days(1) };
    expect(newSince([s], "sessions")).toEqual([s]);
  });
});
