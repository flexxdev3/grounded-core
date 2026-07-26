import { describe, it, expect } from "vitest";
import { projectFromPath } from "./project.js";

describe("projectFromPath", () => {
  it("extracts the project segment from a normal corpus path", () => {
    expect(projectFromPath("/home/flexx/work/0-tools/homelab-context/corpus/grounded/STATE.md")).toBe(
      "grounded",
    );
  });

  it("returns null when there is no corpus/ segment", () => {
    expect(projectFromPath("/home/flexx/work/0-tools/grounded/grounded-core/src/index.ts")).toBeNull();
  });

  it("returns null for a file directly inside corpus/ with no subdirectory", () => {
    expect(projectFromPath("/home/flexx/work/0-tools/homelab-context/corpus/README.md")).toBeNull();
  });

  it("extracts the project segment for paths nested deeper than the project dir", () => {
    expect(projectFromPath("/home/flexx/work/0-tools/homelab-context/corpus/x/y/z.md")).toBe("x");
  });

  it("returns null when 'corpus' appears only as a substring, not a path segment", () => {
    expect(projectFromPath("/home/corpusdata/foo.md")).toBeNull();
  });
});
