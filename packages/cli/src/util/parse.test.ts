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

  // KNOWN DEFECT: packages/cli/src/util/parse.ts:2 — parseInt truncates instead of
  // rejecting, so "7437abc" and "1.9" are silently accepted as 7437 / 1. A --port
  // typo therefore lands on a different port than the operator typed.
  it("KNOWN DEFECT: truncates trailing garbage and fractions instead of rejecting", () => {
    expect(parseInteger("7437abc")).toBe(7437);
    expect(parseInteger("1.9")).toBe(1);
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
