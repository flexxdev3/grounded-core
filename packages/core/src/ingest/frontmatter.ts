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
