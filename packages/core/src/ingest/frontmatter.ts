export interface SplitDoc {
  /** raw frontmatter block WITHOUT the --- fences, or null when absent. */
  frontmatter: string | null;
  /** document text with the frontmatter block removed. */
  body: string;
}

const BOM = "﻿";
const FENCE_LINE = /^---\s*$/;
const CLOSING_FENCE_LINE = /^(---|\.\.\.)\s*$/;
const KEY_LINE = /^[A-Za-z_][A-Za-z0-9_-]*\s*:/m;

/**
 * Split a leading YAML frontmatter block off `text`, if present.
 *
 * Conservative on purpose: only recognizes a block at the very start of the
 * text (allowing a leading BOM), delimited by `---`/`---` or `---`/`...`
 * fence lines, and only when the block contains at least one `key:` style
 * line. A document that legitimately opens with a `---` horizontal rule (no
 * `key:` line before the next fence, or no closing fence at all) is left
 * untouched.
 */
export function splitFrontmatter(text: string): SplitDoc {
  let input = text;
  if (input.startsWith(BOM)) input = input.slice(BOM.length);

  const lines = input.split(/\r\n|\n/);
  if (lines.length === 0 || !FENCE_LINE.test(lines[0]!)) {
    return { frontmatter: null, body: text };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (CLOSING_FENCE_LINE.test(lines[i]!)) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // unterminated opening fence — not frontmatter.
    return { frontmatter: null, body: text };
  }

  const blockLines = lines.slice(1, closeIdx);
  const block = blockLines.join("\n");
  if (!KEY_LINE.test(block)) {
    return { frontmatter: null, body: text };
  }

  const remainderLines = lines.slice(closeIdx + 1);
  let body = remainderLines.join("\n");
  body = body.replace(/^(?:\r?\n)+/, "");

  return { frontmatter: block, body };
}

/** The frontmatter keys ingest honours as per-file tags. */
export interface FrontmatterTags {
  /** doc lane, e.g. "global" | "archive" | "administration". */
  scope?: string;
  /** owning project. */
  project?: string;
}

/**
 * Read the tag keys ingest cares about out of a raw frontmatter block.
 *
 * Deliberately not a YAML parser: only top-level `key: value` scalar lines are
 * read, quotes are stripped, and anything else (lists, nested maps, comments,
 * empty values) is ignored rather than guessed at. A wrong tag is worse than no
 * tag — an ingest that mis-reads a lane puts a document in the wrong place, and
 * that is the failure this whole path exists to prevent.
 */
export function parseFrontmatterTags(block: string | null): FrontmatterTags {
  const out: FrontmatterTags = {};
  if (!block) return out;
  for (const rawLine of block.split(/\r\n|\n/)) {
    // top-level keys only — an indented line belongs to a nested structure.
    if (/^\s/.test(rawLine)) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(rawLine);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (key !== "scope" && key !== "project") continue;
    let value = m[2]!.trim();
    // strip a trailing `# comment`, then surrounding quotes.
    value = value.replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1).trim();
    }
    // lists/maps/empties are not scalars — leave them unset.
    if (!value || value.startsWith("[") || value.startsWith("{")) continue;
    out[key] = value;
  }
  return out;
}
