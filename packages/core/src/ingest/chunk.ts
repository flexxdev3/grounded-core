import { createHash } from "node:crypto";

export interface Chunk {
  idx: number;
  body: string;
  bodyHash: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Derive a title: first markdown heading, else first non-empty line, else "untitled". */
export function deriveTitle(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.slice(0, 120);
  }
  return fallback;
}

/**
 * Chunk markdown into ~targetChars pieces with overlap, preferring splits on
 * blank lines (paragraph/heading boundaries). Each chunk gets a sha256 hash.
 */
export function chunkText(
  text: string,
  targetChars: number,
  overlapChars: number,
): Chunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const target = Math.max(1, targetChars);
  const overlap = Math.max(0, Math.min(overlapChars, target - 1));

  // Split into paragraph blocks, keep boundaries.
  const blocks = normalized.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  const rawChunks: string[] = [];
  let cur = "";
  for (const block of blocks) {
    if (block.length >= target) {
      if (cur) {
        rawChunks.push(cur);
        cur = "";
      }
      // hard-split an oversized block by characters.
      for (let i = 0; i < block.length; i += target - overlap) {
        rawChunks.push(block.slice(i, i + target));
        if (i + target >= block.length) break;
      }
      continue;
    }
    const candidate = cur ? `${cur}\n\n${block}` : block;
    if (candidate.length > target && cur) {
      rawChunks.push(cur);
      cur = block;
    } else {
      cur = candidate;
    }
  }
  if (cur) rawChunks.push(cur);

  if (rawChunks.length === 0) rawChunks.push(normalized.slice(0, target));

  return rawChunks.map((body, idx) => ({
    idx,
    body,
    bodyHash: sha256(body),
  }));
}
