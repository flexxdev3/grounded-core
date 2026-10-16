import type { BoxSchema } from "./types.js";

/**
 * The box's schema card: the ONE way a box reaches recall. Ingested into the
 * docs lane so "which cars use X" routes an agent to the box and the right
 * table. Schema only: no row ever enters Grounded.
 */
export function renderSchemaCard(s: BoxSchema, opts: { files: number }): string {
  const lines: string[] = [];
  lines.push(`# Databox box: ${s.box}`, "");
  if (s.description) lines.push(s.description, "");
  lines.push(
    `Structured data, queryable with read-only SQL (DuckDB dialect). ${opts.files} item files` +
      (s.indexedAt ? `, indexed ${s.indexedAt}.` : "."),
    "",
    `- MCP: \`ground_databox_query\` with box \`${s.box}\` (\`ground_databox_schema\` for this table list).`,
    `- HTTP: \`POST /databox/${s.box}/query\` with \`{"sql": "..."}\`.`,
    `- Cite a conclusion as \`databox:${s.box}\` plus the SQL, so anyone can re-run it.`,
    `- Every table has \`_item\` (the item's file name); array tables add \`_n\` (position in the array).`,
    "",
  );
  if (s.manifest) {
    lines.push("Source manifest: " + Object.entries(s.manifest).map(([k, v]) => `${k}=${v}`).join(", "), "");
  }
  lines.push("## Tables", "");
  for (const t of s.tables) {
    lines.push(`### ${t.name}${s.source === "index" ? ` (${t.rows.toLocaleString("en-US")} rows)` : ""}`, "");
    lines.push(t.columns.map((c) => `\`${c.name}\` ${shortType(c.type)}`).join(" · "), "");
  }
  return lines.join("\n");
}

/** Deep STRUCT types run to kilobytes; the card names the shape, `ground_databox_schema` has the rest. */
function shortType(t: string): string {
  return t.length <= 80 ? t : `${t.slice(0, 77)}...`;
}
