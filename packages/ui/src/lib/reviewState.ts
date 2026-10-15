/** Review bookkeeping — which items are new "since you last looked here".
 * Stored per browser (localStorage); the console says "here" on purpose.
 *
 * Shape per lane: a lastSeen timestamp (set by "Mark all reviewed") plus a
 * small set of individually kept item ids ("Keep" on one card). Marking a
 * lane reviewed clears its kept set — the timestamp covers everything. */

export type ReviewLane = "facts" | "sessions" | "vision";

const KEY = "grounded.review.lastSeen";

interface LaneState {
  at?: string;
  kept?: number[];
}

export type ReviewSeen = Partial<Record<ReviewLane, LaneState>>;

export function loadSeen(): ReviewSeen {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as ReviewSeen;
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}

function save(seen: ReviewSeen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

/** "Mark all reviewed" — everything in the lane up to now is seen. */
export function markReviewed(lane: ReviewLane, at: Date = new Date()): void {
  const seen = loadSeen();
  seen[lane] = { at: at.toISOString() };
  save(seen);
}

/** "Keep" on one card — that item alone stops counting as new. */
export function keepItem(lane: ReviewLane, id: number): void {
  const seen = loadSeen();
  const state = seen[lane] ?? {};
  const kept = new Set(state.kept ?? []);
  kept.add(id);
  seen[lane] = { ...state, kept: [...kept].slice(-500) };
  save(seen);
}

/** The newest of createdAt/updatedAt, for "changed since". */
function stamp(item: { createdAt?: string; updatedAt?: string }): string {
  const c = item.createdAt ?? "";
  const u = item.updatedAt ?? "";
  return u > c ? u : c;
}

/** Items changed after the lane was last reviewed and not individually kept.
 * Never-reviewed → everything from the last 7 days counts, so a first visit
 * isn't a wall of history. */
export function newSince<T extends { id: number; createdAt?: string; updatedAt?: string }>(
  items: T[],
  lane: ReviewLane,
  seen: ReviewSeen = loadSeen(),
): T[] {
  const state = seen[lane] ?? {};
  const cutoff = state.at ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const kept = new Set(state.kept ?? []);
  return items.filter((i) => stamp(i) > cutoff && !kept.has(i.id));
}
