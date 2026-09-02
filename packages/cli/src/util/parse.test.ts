import { describe, it, expect } from "vitest";
import { parseInteger, parseFloatOpt, parseList, parseEnvPair, parseTypedId } from "./parse.js";

describe("parseInteger", () => {
  it("parses a decimal integer", () => {
    expect(parseInteger("7437")).toBe(7437);
    expect(parseInteger("-3")).toBe(-3);
  });

  it("throws on non-numeric input", () => {
    expect(() => parseInteger("abc")).toThrow(/expected an integer, got "abc"/);
    expect(() => parseInteger("")).toThrow(/expected an integer/);
  });

  // FIXED: parseInt used to truncate rather than reject, so "7437abc" and "1.9"
  // were silently accepted as 7437 / 1 — a --port typo landed on a port the
  // operator never typed.
  it("rejects trailing garbage and fractions instead of truncating them", () => {
    expect(() => parseInteger("7437abc")).toThrow(/expected an integer, got "7437abc"/);
    expect(() => parseInteger("1.9")).toThrow(/expected an integer, got "1.9"/);
    expect(() => parseInteger("7437 ")).toThrow(/expected an integer/);
    expect(() => parseInteger(" 7437")).toThrow(/expected an integer/);
    expect(() => parseInteger("0x1f")).toThrow(/expected an integer/);
    expect(() => parseInteger("1e3")).toThrow(/expected an integer/);
  });

  it("names the value parseInt would have silently produced", () => {
    // the whole point: show the operator the number they did not mean to type
    expect(() => parseInteger("7437abc")).toThrow(/would silently read this as 7437/);
    expect(() => parseInteger("1.9")).toThrow(/would silently read this as 1/);
    // nothing salvageable → a plain example instead of a bogus suggestion
    expect(() => parseInteger("abc")).toThrow(/expected a whole number, e\.g\. 7437/);
  });

  it("accepts an explicit plus sign and zero", () => {
    expect(parseInteger("+7437")).toBe(7437);
    expect(parseInteger("0")).toBe(0);
    expect(parseInteger("-0")).toBe(-0);
  });

  it("rejects integers too large to represent exactly", () => {
    expect(() => parseInteger("9007199254740993")).toThrow(/out of range/);
  });
});

describe("parseFloatOpt", () => {
  it("parses floats and integers", () => {
    expect(parseFloatOpt("0.75")).toBe(0.75);
    expect(parseFloatOpt("2")).toBe(2);
  });

  it("throws on non-numeric input", () => {
    expect(() => parseFloatOpt("high")).toThrow(/expected a number, got "high"/);
  });

  // same defect class as parseInteger: parseFloat("0.75xyz") used to yield 0.75
  it("rejects trailing garbage rather than truncating it", () => {
    expect(() => parseFloatOpt("0.75xyz")).toThrow(/expected a number, got "0.75xyz"/);
  });

  it("rejects empty/whitespace input instead of reading it as 0", () => {
    expect(() => parseFloatOpt("")).toThrow(/expected a number/);
    expect(() => parseFloatOpt("   ")).toThrow(/expected a number/);
  });

  it("rejects Infinity and NaN, which are not usable option values", () => {
    expect(() => parseFloatOpt("Infinity")).toThrow(/expected a number/);
    expect(() => parseFloatOpt("NaN")).toThrow(/expected a number/);
  });
});

describe("parseList", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(parseList("fact, session ,doc")).toEqual(["fact", "session", "doc"]);
    expect(parseList("a,,b,")).toEqual(["a", "b"]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseList("")).toEqual([]);
    expect(parseList(" , , ")).toEqual([]);
  });
});

describe("parseEnvPair", () => {
  it("accumulates repeatable KEY=VAL flags", () => {
    const one = parseEnvPair("GROUNDED_URL=http://127.0.0.1:7437");
    expect(one).toEqual({ GROUNDED_URL: "http://127.0.0.1:7437" });
    const two = parseEnvPair("GROUNDED_TOKEN=abc", one);
    expect(two).toEqual({ GROUNDED_URL: "http://127.0.0.1:7437", GROUNDED_TOKEN: "abc" });
  });

  it("does not mutate the accumulator it was handed", () => {
    const acc = { A: "1" };
    parseEnvPair("B=2", acc);
    expect(acc).toEqual({ A: "1" });
  });

  it("keeps '=' inside the value (URLs, base64, query strings)", () => {
    expect(parseEnvPair("URL=http://h/?a=1&b=2")).toEqual({ URL: "http://h/?a=1&b=2" });
  });

  it("allows an empty value", () => {
    expect(parseEnvPair("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("trims whitespace around the key", () => {
    expect(parseEnvPair("  KEY  =v")).toEqual({ KEY: "v" });
  });

  it("rejects input with no '=' or an empty key", () => {
    expect(() => parseEnvPair("NOEQUALS")).toThrow(/expected KEY=VAL/);
    expect(() => parseEnvPair("=orphan")).toThrow(/expected KEY=VAL/);
  });

  it("later values win for a repeated key", () => {
    expect(parseEnvPair("K=second", { K: "first" })).toEqual({ K: "second" });
  });
});

describe("parseTypedId", () => {
  it("accepts the three source types", () => {
    expect(parseTypedId("fact:2")).toBe("fact:2");
    expect(parseTypedId("session:274")).toBe("session:274");
    expect(parseTypedId("doc:1091")).toBe("doc:1091");
  });

  it("rejects unknown types, missing ids, and non-numeric ids", () => {
    for (const bad of ["vision:1", "fact:", "fact", "doc:abc", "doc:1.5", " fact:1", "fact:1 "]) {
      expect(() => parseTypedId(bad)).toThrow(/invalid typed id/);
    }
  });
});
