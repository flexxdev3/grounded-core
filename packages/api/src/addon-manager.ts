import { join } from "node:path";
import {
  ADDON_CATALOG,
  CONFIG_FILENAME,
  addonDefinition,
  addonRuntimePresent,
  addonSupported,
  installAddonRuntime,
  writeEmbeddingsConfig,
  type AddonDefinition,
  type AddonId,
} from "@grounded/core";
import type { EmbeddingDevice, GroundedConfig } from "@grounded/core/contract";
import { writeDataboxConfig, type Databox } from "@grounded/databox";
import type { EmbeddingsAddon } from "./addons.js";

/**
 * The Add-ons page's engine: one catalog (`GET /addons`) and one install job per
 * add-on. Install = fetch the add-on's native runtime into `<home>/addons/<id>/`
 * (packaged Core ships without them), then switch it on inside the running service:
 *   embeddings → the existing model-download/backfill job takes over;
 *   databox    → `[databox] enabled = true`, then the service attaches it live.
 * Host administration: the shared LAN listener never forwards these POSTs.
 */

export type AddonState = "unsupported" | "available" | "installing" | "on" | "off" | "error";

export interface AddonJob {
  state: "idle" | "running" | "done" | "error";
  phase?: string;
  detail?: string;
  progress?: { done: number; total: number };
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AddonView {
  id: AddonId;
  name: string;
  summary: string;
  description: string;
  supported: boolean;
  runtimeInstalled: boolean;
  enabled: boolean;
  state: AddonState;
  /** approximate download for turning it on, bytes (runtime not yet present + model, when relevant). */
  downloadBytes: number;
  job: AddonJob;
  /** add-on specific facts for the card (model, device, boxes, ...). */
  info: Record<string, unknown>;
}

export interface AddonManager {
  list(): Promise<AddonView[]>;
  get(id: string): Promise<AddonView | undefined>;
  /** false when a job is already running for this add-on. */
  install(id: AddonId, opts?: { device?: EmbeddingDevice }): boolean;
  disable(id: AddonId): Promise<void>;
  /** the live Databox, attached or detached at runtime. */
  databox(): Databox | undefined;
}

export interface AddonManagerDeps {
  loadConfig: () => GroundedConfig;
  embeddings: EmbeddingsAddon;
  /** reopen the store from config.toml (embeddings provider changed). */
  reloadStore: () => Promise<unknown>;
  /** build + start the service Databox from config (undefined when disabled). */
  createDatabox: (cfg: GroundedConfig) => Databox | undefined;
  /** the Databox the service started with. */
  initialDatabox?: Databox;
}

export function createAddonManager(deps: AddonManagerDeps): AddonManager {
  let databox = deps.initialDatabox;
  const jobs = new Map<AddonId, AddonJob>();
  const job = (id: AddonId): AddonJob => jobs.get(id) ?? { state: "idle" };
  const set = (id: AddonId, patch: Partial<AddonJob>): void => {
    jobs.set(id, { ...job(id), ...patch });
  };

  async function view(def: AddonDefinition): Promise<AddonView> {
    const cfg = deps.loadConfig();
    const supported = addonSupported(def);
    const runtimeInstalled = supported && (await addonRuntimePresent(cfg.home, def));
    let j = job(def.id);
    let enabled = false;
    let info: Record<string, unknown> = {};
    let downloadBytes = runtimeInstalled ? 0 : def.runtimeBytes;

    if (def.id === "embeddings") {
      const s = await deps.embeddings.status();
      enabled = s.enabled;
      info = { model: s.model, modelPresent: s.modelPresent, gpuBackend: s.gpuBackend, device: s.job.device ?? null, provider: s.provider };
      downloadBytes += s.downloadBytes;
      // after the runtime phase the embeddings job owns progress: surface it as ours.
      if (j.phase === "handoff" || (j.state !== "running" && s.job.state === "running")) {
        const e = s.job;
        const progress =
          e.phase === "download" && e.download ? { done: e.download.bytes, total: e.download.totalBytes }
          : e.phase === "backfill" && e.backfill ? { done: e.backfill.done, total: e.backfill.total }
          : undefined;
        j = {
          state: e.state === "idle" ? "running" : e.state,
          phase: e.phase ?? "starting",
          detail:
            e.phase === "download" && e.download ? `downloading ${e.download.file}`
            : e.phase === "backfill" && e.backfill ? `embedding existing ${e.backfill.lane}`
            : e.phase === "probe" ? "loading the model"
            : e.phase === "reload" ? "switching search on"
            : "starting",
          ...(progress ? { progress } : {}),
          ...(e.error ? { error: e.error } : {}),
          ...(j.startedAt ? { startedAt: j.startedAt } : {}),
          ...(e.finishedAt ? { finishedAt: e.finishedAt } : {}),
        };
        if (e.state === "done" || e.state === "error") jobs.set(def.id, j);
      }
    } else if (def.id === "databox") {
      enabled = Boolean(databox);
      const h = databox ? await databox.health() : undefined;
      info = { boxes: h?.boxes ?? (cfg.databox?.box.length ?? 0), detail: h?.detail ?? (cfg.databox?.enabled ? "enabled in config" : "off"), ok: h?.ok ?? null };
    }

    const state: AddonState =
      !supported ? "unsupported"
      : j.state === "running" ? "installing"
      : j.state === "error" ? "error"
      : enabled ? "on"
      : runtimeInstalled ? "off"
      : "available";
    return {
      id: def.id, name: def.name, summary: def.summary, description: def.description,
      supported, runtimeInstalled, enabled, state, downloadBytes, job: j, info,
    };
  }

  async function run(def: AddonDefinition, device: EmbeddingDevice | undefined): Promise<void> {
    const cfg = deps.loadConfig();
    if (!(await addonRuntimePresent(cfg.home, def))) {
      set(def.id, { phase: "runtime", detail: "downloading the runtime" });
      await installAddonRuntime(cfg.home, def, (detail) => set(def.id, { phase: "runtime", detail }));
    }
    if (def.id === "embeddings") {
      set(def.id, { phase: "handoff", detail: "starting" });
      if (!deps.embeddings.start(device ? { device } : {})) set(def.id, { phase: "handoff" });
      return; // the embeddings job reports from here (see view()).
    }
    // databox: turn it on in config (keeping configured boxes), then attach it live.
    set(def.id, { phase: "config", detail: "turning Databox on" });
    const current = deps.loadConfig();
    writeDataboxConfig(join(current.home, CONFIG_FILENAME), { enabled: true, box: current.databox?.box ?? [] });
    set(def.id, { phase: "attach", detail: "starting Databox" });
    if (!databox) databox = deps.createDatabox(deps.loadConfig());
    if (!databox) throw new Error("Databox did not start from the updated config.toml");
    set(def.id, { state: "done", phase: "done", detail: "on", finishedAt: new Date().toISOString() });
  }

  return {
    async list() {
      return Promise.all(ADDON_CATALOG.map(view));
    },
    async get(id) {
      const def = addonDefinition(id);
      return def ? view(def) : undefined;
    },
    install(id, opts = {}) {
      const def = addonDefinition(id);
      if (!def) throw new Error(`unknown add-on "${id}"`);
      if (!addonSupported(def)) throw new Error(`${def.name} is not available for ${process.platform}-${process.arch}`);
      if (job(id).state === "running") return false;
      jobs.set(id, { state: "running", phase: "starting", startedAt: new Date().toISOString() });
      run(def, opts.device).catch((err: unknown) => {
        set(id, { state: "error", error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() });
      });
      return true;
    },
    async disable(id) {
      const def = addonDefinition(id);
      if (!def) throw new Error(`unknown add-on "${id}"`);
      if (job(id).state === "running" && job(id).phase !== "handoff") throw new Error(`${def.name} is installing; wait for it to finish`);
      const cfg = deps.loadConfig();
      if (id === "embeddings") {
        writeEmbeddingsConfig(cfg.home, { provider: "none" });
        await deps.reloadStore();
      } else {
        writeDataboxConfig(join(cfg.home, CONFIG_FILENAME), { enabled: false, box: cfg.databox?.box ?? [] });
        const prev = databox;
        databox = undefined;
        await prev?.close();
      }
      jobs.delete(id);
    },
    databox: () => databox,
  };
}
