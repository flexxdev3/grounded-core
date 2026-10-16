import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { BoxConfig } from "./types.js";

/**
 * Rewrite only the `[databox]` table and its `[[databox.box]]` entries in a
 * config.toml, keeping every other line as written. The Databox block is
 * regenerated at the end of the file (comments inside it are not kept).
 */
export function writeDataboxConfig(path: string, cfg: { enabled: boolean; box: BoxConfig[] }): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current.split("\n");
  const kept: string[] = [];
  let inDatabox = false;
  for (const l of lines) {
    const header = /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(#.*)?$/.exec(l);
    if (header) inDatabox = header[1] === "databox" || header[1]!.startsWith("databox.");
    if (!inDatabox) kept.push(l);
  }
  const q = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string
  const block = [
    "[databox]",
    "# structured data boxes: an extractor writes <root>/items/**.json; Grounded indexes and queries them",
    `enabled = ${cfg.enabled}`,
    ...cfg.box.flatMap((b) => [
      "",
      "[[databox.box]]",
      `name = ${q(b.name)}`,
      `root = ${q(b.root)}`,
      ...(b.description ? [`description = ${q(b.description)}`] : []),
    ]),
    "",
  ];
  const head = kept.join("\n").replace(/\n*$/, "");
  const next = `${head ? `${head}\n\n` : ""}${block.join("\n")}`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, path);
}
