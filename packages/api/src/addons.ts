import { embeddingsAddonPlan, installLocalEmbeddings, type EmbeddingsAddonPlan } from "@grounded/core";
import type { EmbeddingDevice, GroundedConfig, Store } from "@grounded/core/contract";

/**
 * The Embeddings add-on as a background job the console can start and poll:
 * download the model → load it once (GPU or CPU) → rewrite config.toml →
 * reopen the store with vectors on → embed the rows written while it was off.
 * One job per process; the API keeps serving throughout (lexical until the swap).
 */
export interface EmbeddingsJob {
  state: "idle" | "running" | "done" | "error";
  phase?: "download" | "probe" | "config" | "reload" | "backfill";
  download?: { file: string; bytes: number; totalBytes: number };
  backfill?: { lane: "facts" | "sessions" | "docs"; done: number; total: number };
  device?: "gpu" | "cpu";
  embedded?: { facts: number; sessions: number; docs: number };
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface EmbeddingsAddon {
  status(): Promise<EmbeddingsAddonPlan & { job: EmbeddingsJob }>;
  /** starts the job; returns false when one is already running. */
  start(opts: { device?: EmbeddingDevice }): boolean;
}

export function createEmbeddingsAddon(deps: {
  loadConfig: () => GroundedConfig;
  /** reopen the store from the (rewritten) config and swap it in; returns the new store. */
  reload: () => Promise<Store>;
}): EmbeddingsAddon {
  let job: EmbeddingsJob = { state: "idle" };

  async function run(device: EmbeddingDevice | undefined): Promise<void> {
    const cfg = deps.loadConfig();
    const result = await installLocalEmbeddings(cfg, {
      ...(device ? { device } : {}),
      onProgress: (p) => {
        if (p.phase === "download") {
          job = { ...job, phase: "download", download: { file: p.file.split(/[\\/]/).pop()!, bytes: p.bytes, totalBytes: p.totalBytes } };
        } else {
          job = { ...job, phase: p.phase };
        }
      },
    });
    job = { ...job, phase: "reload", device: result.device };
    const store = await deps.reload();
    job = { ...job, phase: "backfill" };
    const embedded = await store.backfillVectors({
      onProgress: (b) => {
        job = { ...job, backfill: b };
      },
    });
    job = { ...job, state: "done", embedded, finishedAt: new Date().toISOString() };
  }

  return {
    async status() {
      return { ...(await embeddingsAddonPlan(deps.loadConfig())), job };
    },
    start(opts) {
      if (job.state === "running") return false;
      job = { state: "running", startedAt: new Date().toISOString() };
      run(opts.device).catch((err: unknown) => {
        job = { ...job, state: "error", error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() };
      });
      return true;
    },
  };
}
