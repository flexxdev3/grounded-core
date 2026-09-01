import type { DeliveryRank } from "../contract.js";

// Re-exported here (not just from engine/brief.ts) so write-path callers can
// import the whole pinned-reserve-warning signal from the same narrow
// "@grounded/core/delivery" subpath they already use for computeDeliveryRank,
// without dragging in openStore/database drivers via the full brief.js module
// graph. brief.ts remains the source of truth; this is a pure re-export.
export { pinnedFactsReserveStatus } from "./brief.js";

/**
 * Fraction of the facts reserve the PINNED set alone must reach, by rendered
 * chars, before a fact write earns a warning. Pinned facts are a delivery
 * GUARANTEE (see `truncateFactsToReserve` in engine/brief.ts) — every one of
 * them renders in full text regardless of budget, which means a pinned set
 * that keeps growing can silently crowd non-pinned facts out of the brief
 * entirely. 0.75 gives the operator runway to notice before that happens,
 * not just after.
 */
const PINNED_RESERVE_WARN_RATIO = 0.75;

/**
 * Char budget above which a fact's text earns a terseness warning. 200, not a
 * rounder 250, because that is the operator's hard rule for fact text: a fact
 * reads as ONE line, and the explanation belongs in `detail`.
 *
 * Measured on `fact.fact` alone, never the rendered brief line — the writer
 * controls the text, not the `- ` bullet, the ` — detail` tail, or the
 * ` (fact:NN)` citation the renderer wraps around it, so warning about the
 * rendered length would name a number they cannot act on.
 */
const FACT_TEXT_WARN_CHARS = 200;

/**
 * Turn a raw (rank, ofActive) pair into the caller-facing delivery signal.
 * `typicalLimit` mirrors `config.delivery.typicalFactLimit`, which itself
 * mirrors the hardcoded `FACTS_LIMIT=8` in the live SessionStart hook
 * (`~/.claude/hooks/grounded-hook.sh`) — keeping the hook's assumption and the
 * engine's promise from drifting independently. A fact ranked at or below the
 * typical limit is "delivered" (a caller requesting the usual top-N would see
 * it); anything past it gets a warning naming the assumption it violates.
 *
 * `pinnedReserve`, when supplied, layers a SECOND, independent warning check
 * on top of the rank check: how much of the facts reserve the pinned set
 * alone consumes (rendered chars, from `pinnedFactsReserveStatus` in
 * engine/brief.ts). This is deliberately the same function/shape rather than
 * a parallel mechanism — one write-time delivery signal, two things it can
 * warn about. Both warnings can fire together; they're joined, not replaced.
 *
 * `factText`, when supplied, layers a THIRD independent check in the same
 * shape: the fact's own text length against the one-line terseness rule. Like
 * the others it is a warning, never a rejection — the 400 lane is for
 * malformed input, and a long fact is merely a worse fact.
 */
export function computeDeliveryRank(
  rank: number,
  ofActive: number,
  typicalLimit: number,
  pinnedReserve?: { renderedChars: number; reserveChars: number },
  factText?: string,
): DeliveryRank {
  const delivered = rank <= typicalLimit;
  const warnings: string[] = [];
  if (!delivered) {
    warnings.push(`rank ${rank} of ${ofActive} — most consumers request the top ${typicalLimit}`);
  }
  if (pinnedReserve && pinnedReserve.reserveChars > 0) {
    const ratio = pinnedReserve.renderedChars / pinnedReserve.reserveChars;
    if (ratio >= PINNED_RESERVE_WARN_RATIO) {
      warnings.push(
        `pinned facts use ${Math.round(ratio * 100)}% of the facts reserve ` +
          `(${pinnedReserve.renderedChars}/${pinnedReserve.reserveChars} chars) — ` +
          `non-pinned facts may be crowded out of the brief`,
      );
    }
  }
  if (factText !== undefined && factText.length > FACT_TEXT_WARN_CHARS) {
    warnings.push(
      `fact text is ${factText.length} chars — facts should read as one line ` +
        `(≤${FACT_TEXT_WARN_CHARS}); move the explanation into \`detail\``,
    );
  }
  return warnings.length > 0
    ? { rank, ofActive, delivered, warning: warnings.join("; ") }
    : { rank, ofActive, delivered };
}
