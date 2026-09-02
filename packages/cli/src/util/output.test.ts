import { describe, it, expect, vi, afterEach } from "vitest";
import { c, printJson, line, header, field, ok, truncate, isTTY } from "./output.js";

function captureStdout(fn: () => void): string {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("color gating", () => {
  // Tests run with stdout piped, so the palette must be the identity functions.
  // This is what keeps `grounded --json | jq` and CI logs free of ANSI escapes.
  it("is a no-op palette when stdout is not a TTY", () => {
    expect(isTTY).toBe(false);
    for (const fn of [c.bold, c.dim, c.green, c.red, c.yellow, c.cyan, c.magenta]) {
      expect(fn("x")).toBe("x");
    }
  });
});

describe("printJson", () => {
  it("emits pretty JSON with a trailing newline", () => {
    const out = captureStdout(() => printJson({ method: "docker", port: 7437 }));
    expect(out).toBe('{\n  "method": "docker",\n  "port": 7437\n}\n');
    expect(JSON.parse(out)).toEqual({ method: "docker", port: 7437 });
  });

  it("round-trips arrays (the shape `mcp install --json` emits)", () => {
    const out = captureStdout(() => printJson([{ target: "codex" }]));
    expect(JSON.parse(out)).toEqual([{ target: "codex" }]);
  });
});

describe("line / header / field", () => {
  it("line() with no argument writes just a newline", () => {
    expect(captureStdout(() => line())).toBe("\n");
  });

  it("field pads the label to a 12-column gutter", () => {
    const out = captureStdout(() => field("port", "7437"));
    expect(out).toBe("port         7437\n");
  });

  it("field does not truncate a label longer than the gutter", () => {
    const out = captureStdout(() => field("a-very-long-label", "v"));
    expect(out).toBe("a-very-long-label v\n");
  });

  it("header writes the text plus a newline", () => {
    expect(captureStdout(() => header("Grounded is live"))).toBe("Grounded is live\n");
  });
});

describe("ok", () => {
  it("renders the health words", () => {
    expect(ok(true)).toBe("ok");
    expect(ok(false)).toBe("fail");
  });
});

describe("truncate", () => {
  it("collapses whitespace and trims", () => {
    expect(truncate("  a \n\t b  ", 100)).toBe("a b");
  });

  it("returns the flattened string untouched when it fits", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("caps at n characters total, ellipsis included", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("measures the flattened length, not the raw length", () => {
    // 10 raw chars, 5 flattened — must not be truncated.
    expect(truncate("a    b   c", 6)).toBe("a b c");
  });
});
