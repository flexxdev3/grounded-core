import type { DeliveryRank } from "../contract.js";

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
 */
export function computeDeliveryRank(
  rank: number,
  ofActive: number,
  typicalLimit: number,
  pinnedReserve?: { renderedChars: number; reserveChars: number },
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
  return warnings.length > 0
    ? { rank, ofActive, delivered, warning: warnings.join("; ") }
    : { rank, ofActive, delivered };
}
