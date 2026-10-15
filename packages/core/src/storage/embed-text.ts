/**
 * The exact text each lane embeds — shared by every adapter's write path AND
 * by `backfillVectors`, so a backfilled vector is byte-for-byte the vector the
 * row would have got had embeddings been on when it was written.
 */

export function factEmbedText(fact: string, detail: string | null | undefined): string {
  return `${fact}\n${detail ?? ""}`.trim();
}

export function sessionEmbedText(summary: string, details: string | null | undefined): string {
  return `${summary}\n${details ?? ""}`.trim();
}

export function docEmbedText(body: string): string {
  return body;
}

/** Default rows per `embedder.embed` call during a backfill. */
export const BACKFILL_BATCH = 32;
