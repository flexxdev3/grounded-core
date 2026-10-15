import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "./router.js";

describe("parseRoute", () => {
  it("empty and bare hashes land on home", () => {
    expect(parseRoute("").view).toBe("home");
    expect(parseRoute("#").view).toBe("home");
    expect(parseRoute("#/").view).toBe("home");
  });

  it("parses a view", () => {
    expect(parseRoute("#/review").view).toBe("review");
    expect(parseRoute("#/tray").view).toBe("tray");
  });

  it("unknown views fall back to home", () => {
    expect(parseRoute("#/nope").view).toBe("home");
    expect(parseRoute("#/overview").view).toBe("home");
  });

  it("is case-insensitive on the view name", () => {
    expect(parseRoute("#/Review").view).toBe("review");
  });

  it("parses params", () => {
    const r = parseRoute("#/search?q=sqlite%20wal&x=1");
    expect(r.view).toBe("search");
    expect(r.params.get("q")).toBe("sqlite wal");
    expect(r.params.get("x")).toBe("1");
  });

  it("no params → empty URLSearchParams", () => {
    expect([...parseRoute("#/brief").params]).toEqual([]);
  });
});

describe("routeHash", () => {
  it("builds a bare route", () => {
    expect(routeHash("home")).toBe("#/home");
  });

  it("builds params and drops empty values", () => {
    expect(routeHash("search", { q: "a b", empty: "" })).toBe("#/search?q=a+b");
  });

  it("round-trips through parseRoute", () => {
    const r = parseRoute(routeHash("review", { tab: "sessions" }));
    expect(r.view).toBe("review");
    expect(r.params.get("tab")).toBe("sessions");
  });
});
