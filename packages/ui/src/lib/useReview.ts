import { useMemo } from "preact/hooks";
import type { Fact, ListResult, Session, Vision } from "@grounded/core/contract";
import { api } from "../api.js";
import { useAsync, useDataVersion } from "../hooks.js";
import { loadSeen, newSince } from "./reviewState.js";

export interface ReviewData {
  facts: Fact[];
  sessions: Session[];
  vision: Vision[];
  /** new since last reviewed, per lane. */
  fresh: { facts: Fact[]; sessions: Session[]; vision: Vision[] };
  total: number;
  loading: boolean;
  error: string | null;
}

/** Everything the Review screen and its nav badge need, in one fetch set.
 * Project scoping applies to sessions; facts filter to global + project. */
export function useReview(project: string | null): ReviewData {
  const version = useDataVersion();
  const facts = useAsync<ListResult<Fact>>(
    () => api.facts.list({ limit: 500, status: "active" }),
    [version],
  );
  const sessions = useAsync<ListResult<Session>>(
    () => api.sessions.list({ project: project ?? undefined, limit: 200 }),
    [version, project],
  );
  const vision = useAsync<ListResult<Vision>>(() => api.vision.list({ limit: 200 }), [version]);

  return useMemo(() => {
    const seen = loadSeen();
    const f = (facts.data?.data ?? []).filter(
      (x) => !project || x.scope === "global" || x.scope === project || x.scope === `project:${project}`,
    );
    const s = sessions.data?.data ?? [];
    const v = vision.data?.data ?? [];
    const fresh = {
      facts: newSince(f, "facts", seen),
      sessions: newSince(s, "sessions", seen),
      vision: newSince(v, "vision", seen),
    };
    return {
      facts: f,
      sessions: s,
      vision: v,
      fresh,
      total: fresh.facts.length + fresh.sessions.length + fresh.vision.length,
      loading: facts.loading || sessions.loading || vision.loading,
      error: facts.error ?? sessions.error ?? vision.error,
    };
  }, [facts.data, sessions.data, vision.data, facts.loading, sessions.loading, vision.loading, facts.error, sessions.error, vision.error, project]);
}
