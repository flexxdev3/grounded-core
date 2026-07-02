import { useEffect, useState, useCallback } from "preact/hooks";
import { errMessage } from "./api.js";

/** Load async data with loading/error state and a manual `reload`. */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => live && (setData(d), setLoading(false)))
      .catch((e) => live && (setError(errMessage(e)), setLoading(false)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

// ---- toast singleton (any view can raise one) ----
type ToastListener = (msg: string) => void;
const listeners = new Set<ToastListener>();
export function toast(msg: string): void {
  for (const l of listeners) l(msg);
}
export function useToastChannel(): string {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const l: ToastListener = (m) => {
      setMsg(m);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(""), 2200);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      clearTimeout(timer);
    };
  }, []);
  return msg;
}

// ---- global data version: bumped after any mutation so every view reloads ----
let version = 0;
const versionListeners = new Set<(v: number) => void>();
export function bumpData(): void {
  version += 1;
  for (const l of versionListeners) l(version);
}
export function useDataVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const l = (nv: number) => setV(nv);
    versionListeners.add(l);
    return () => {
      versionListeners.delete(l);
    };
  }, []);
  return v;
}
