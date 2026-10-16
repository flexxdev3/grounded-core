import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME } from "../config.js";
import { importAddonModule } from "../addons/runtime.js";
import { EmbedError } from "../contract.js";
import type { EmbeddingDevice, GroundedConfig } from "../contract.js";
import {
  DEFAULT_LOCAL_DOWNLOAD_BYTES,
  createLocalProvider,
  ensureLocalModel,
  localModelPresent,
  resolveLocalModel,
  type DownloadProgress,
} from "./local.js";

/**
 * The Embeddings add-on: turn on search-by-meaning for a cabinet that runs
 * lexical-only. Never automatic — it downloads a model, so the user opts in
 * from the console (or `grounded addon add embeddings`) after seeing the size.
 */

export interface EmbeddingsAddonPlan {
  /** the provider in use now ("none" = lexical-only). */
  provider: string;
  /** true when vectors are already on. */
  enabled: boolean;
  /** onnxruntime-node + tokenizer importable. */
  runtimeInstalled: boolean;
  model: string;
  modelPresent: boolean;
  /** bytes still to download (0 when the model is already here). */
  downloadBytes: number;
  /** GPU backend this platform can use, if any. */
  gpuBackend: "directml" | null;
  /** the device setting in config.toml (`[embeddings] device`, default auto). */
  device: EmbeddingDevice;
}

export async function runtimeInstalled(): Promise<boolean> {
  try {
    await importAddonModule("onnxruntime-node");
    await importAddonModule("@huggingface/tokenizers");
    return true;
  } catch {
    return false;
  }
}

export async function embeddingsAddonPlan(cfg: GroundedConfig): Promise<EmbeddingsAddonPlan> {
  const { model, modelFile, dir } = resolveLocalModel(cfg);
  const present = localModelPresent(dir, modelFile);
  return {
    provider: cfg.embeddings.provider,
    enabled: cfg.embeddings.provider !== "none",
    runtimeInstalled: await runtimeInstalled(),
    model,
    modelPresent: present,
    downloadBytes: present ? 0 : DEFAULT_LOCAL_DOWNLOAD_BYTES,
    gpuBackend: process.platform === "win32" ? "directml" : null,
    device: cfg.embeddings.device ?? "auto",
  };
}

export type AddonProgress =
  | ({ phase: "download" } & DownloadProgress)
  | { phase: "probe" }
  | { phase: "config"; configPath: string };

/**
 * Download the model, load it once to learn whether the GPU works, then point
 * config.toml at it. The caller reopens its store afterwards (and backfills).
 */
export async function installLocalEmbeddings(
  cfg: GroundedConfig,
  opts: { device?: EmbeddingDevice; onProgress?: (p: AddonProgress) => void } = {},
): Promise<{ device: "gpu" | "cpu"; model: string; configPath: string }> {
  if (!(await runtimeInstalled())) {
    throw new EmbedError("the embeddings add-on runtime (onnxruntime-node) is not installed");
  }
  const { model, modelFile, dir } = resolveLocalModel(cfg);
  await ensureLocalModel(dir, model, modelFile, (p) => opts.onProgress?.({ phase: "download", ...p }));

  opts.onProgress?.({ phase: "probe" });
  const device = opts.device ?? "auto";
  const probe = createLocalProvider({ ...cfg, embeddings: { ...cfg.embeddings, provider: "local", device } });
  await probe.embed(["grounded"]);
  const where = (await probe.health()).device ?? "cpu";

  const configPath = writeEmbeddingsConfig(cfg.home, { provider: "local", device });
  opts.onProgress?.({ phase: "config", configPath });
  return { device: where, model, configPath };
}

/**
 * Rewrite only the `[embeddings]` table of `<home>/config.toml`, keeping every
 * other line (and the operator's comments elsewhere) as written.
 */
export function writeEmbeddingsConfig(
  home: string,
  emb: { provider: GroundedConfig["embeddings"]["provider"]; device?: EmbeddingDevice },
): string {
  const path = join(home, CONFIG_FILENAME);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = [
    "[embeddings]",
    `provider = ${JSON.stringify(emb.provider)}`,
    ...(emb.device ? [`# auto = the GPU when usable, else the CPU`, `device = ${JSON.stringify(emb.device)}`] : []),
    "",
  ].join("\n");
  // The table runs from its header to the next header (or EOF). Trailing
  // comments and blank lines in that span introduce the NEXT table: keep them.
  const lines = current.split("\n");
  const start = lines.findIndex((l) => /^\s*\[embeddings\]\s*(#.*)?$/.test(l));
  let next: string;
  if (start === -1) {
    next = `${current.replace(/\n*$/, "\n\n")}${block}`;
  } else {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    let keepFrom = end;
    while (keepFrom > start + 1 && /^\s*(#.*)?$/.test(lines[keepFrom - 1]!)) keepFrom--;
    // the block already ends in one blank line; drop the tail's leading blanks.
    const tail = lines.slice(keepFrom, end);
    while (tail.length && tail[0]!.trim() === "") tail.shift();
    next = [...lines.slice(0, start), ...block.split("\n"), ...tail, ...lines.slice(end)].join("\n");
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, path);
  return path;
}
