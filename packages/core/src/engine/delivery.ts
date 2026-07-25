import type { DeliveryRank } from "../contract.js";

/**
 * Turn a raw (rank, ofActive) pair into the caller-facing delivery signal.
 * `typicalLimit` mirrors `config.delivery.typicalFactLimit`, which itself
 * mirrors the hardcoded `FACTS_LIMIT=8` in the live SessionStart hook
 * (`~/.claude/hooks/grounded-hook.sh`) — keeping the hook's assumption and the
 * engine's promise from drifting independently. A fact ranked at or below the
 * typical limit is "delivered" (a caller requesting the usual top-N would see
 * it); anything past it gets a warning naming the assumption it violates.
 */
export function computeDeliveryRank(rank: number, ofActive: number, typicalLimit: number): DeliveryRank {
  const delivered = rank <= typicalLimit;
  return delivered
    ? { rank, ofActive, delivered }
    : { rank, ofActive, delivered, warning: `rank ${rank} of ${ofActive} — most consumers request the top ${typicalLimit}` };
}
