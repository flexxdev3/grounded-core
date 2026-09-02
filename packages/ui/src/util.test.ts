import { describe, it, expect, vi, afterEach } from "vitest";
import { fmtDate, typeLabel, parseTypedId, copyText } from "./util.js";

describe("fmtDate", () => {
  it("renders a stored UTC instant as 'YYYY-MM-DD HH:MM'", () => {
    expect(fmtDate("2026-06-24T01:04:37.123Z")).toBe("2026-06-24 01:04");
  });

  it("does NOT shift the instant into local time — it slices the stored string", () => {
    // The console shows stored UTC verbatim; anything else would silently
    // disagree with the JSON createdAt the API returns.
    const iso = "2026-06-24T23:59:00.000Z";
    expect(fmtDate(iso)).toBe("2026-06-24 23:59");
  });

  it("renders an em-dash for null/undefined/empty rather than 'Invalid Date'", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate("")).toBe("—");
  });

  it("passes a short string through without padding", () => {
    expect(fmtDate("2026-06-24")).toBe("2026-06-24");
  });
});

describe("typeLabel", () => {
  it("abbreviates session to fit the fixed-width card gutter", () => {
    expect(typeLabel("fact")).toBe("fact");
    expect(typeLabel("session")).toBe("sess");
    expect(typeLabel("doc")).toBe("doc");
  });

  it("keeps every label at four characters or fewer", () => {
    for (const t of ["fact", "session", "doc"] as const) {
      expect(typeLabel(t).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("parseTypedId", () => {
  it("splits a typed id into its lane and numeric id", () => {
    expect(parseTypedId("doc:1091")).toEqual({ type: "doc", num: 1091 });
    expect(parseTypedId("fact:2")).toEqual({ type: "fact", num: 2 });
    expect(parseTypedId("session:274")).toEqual({ type: "session", num: 274 });
  });

  it("round-trips with the id shape the API emits", () => {
    for (const id of ["fact:1", "session:99", "doc:100000"] as const) {
      const { type, num } = parseTypedId(id);
      expect(`${type}:${num}`).toBe(id);
    }
  });
});

describe("copyText", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).navigator;
    vi.restoreAllMocks();
  });

  it("reports success when the clipboard write resolves", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true });
    await expect(copyText("doc:12")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("doc:12");
  });

  it("returns false instead of throwing when the clipboard is denied", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } },
      configurable: true,
    });
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("returns false instead of throwing when there is no clipboard API at all", async () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    await expect(copyText("x")).resolves.toBe(false);
  });
});
