import { useEffect, useState } from "preact/hooks";
import type { HealthReport } from "@grounded/core/contract";
import { api } from "../api.js";

const DISMISS_KEY = "grounded.cpuNotice.dismissed";
const POLL_MS = 60_000;

/**
 * Plain-language notice shown while embeddings run on the CPU. Most users do
 * not know what an embedding is; they do notice a warm, busy laptop. Dismissal
 * is remembered per embedder, so switching provider or device shows it again.
 */
export function CpuNotice({ onDetails }: { onDetails: () => void }) {
  const [emb, setEmb] = useState<HealthReport["embeddings"] | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let live = true;
    const tick = () =>
      api
        .health()
        .then((h) => live && setEmb(h.embeddings))
        .catch(() => {});
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!emb || emb.device !== "cpu" || emb.dims === 0) return null;
  const key = `${emb.provider}@cpu`;
  if (dismissed === key) return null;

  const dismiss = () => {
    setDismissed(key);
    try {
      localStorage.setItem(DISMISS_KEY, key);
    } catch {
      /* per-session only */
    }
  };

  return (
    <div class="cpu-notice" role="status">
      <span class="cpu-notice-mark" aria-hidden="true">◐</span>
      <div class="cpu-notice-body">
        <strong>Grounded is using your processor (CPU) for search.</strong>
        <span>
          To find things by meaning, Grounded turns your notes into numbers called embeddings. Right now that work
          runs on the CPU instead of a graphics card (GPU). Everything still works, but adding lots of documents is
          slower and your computer may run warm and loud while it does. Embeddings are recommended on a computer
          with a GPU.
        </span>
      </div>
      <div class="cpu-notice-actions">
        <button class="btn btn-ghost" onClick={onDetails}>
          Details
        </button>
        <button class="btn" onClick={dismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
