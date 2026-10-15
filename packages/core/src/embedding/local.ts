import { createWriteStream, mkdirSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ConfigError, EmbedError } from "../contract.js";
import type { EmbeddingProvider, GroundedConfig } from "../contract.js";

/**
 * In-process embeddings: an ONNX model run on the CPU by onnxruntime-node.
 * No ollama, no GPU, no service. The runtime and tokenizer are optional deps,
 * loaded lazily so a cabinet that never selects "local" never loads them.
 *
 * Default model is nomic-embed-text-v1.5 (768 dims, the same model ollama
 * serves by default). Vectors are close to ollama's but not identical, so
 * switching provider on an existing cabinet is a re-embed.
 */

export const DEFAULT_LOCAL_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const DEFAULT_MODEL = DEFAULT_LOCAL_MODEL;
/**
 * fp16 weights: cosine 1.0 to the fp32 file at the same CPU speed, half the
 * download (273 MB). int8 is ~2x faster but drifts (min cosine 0.947).
 * Measured on vivobook i9-13980HX, 2026-10-15.
 */
export const DEFAULT_MODEL_FILE = "onnx/model_fp16.onnx";
/** what the default model costs to download, for the setup screen (fp16 + tokenizer). */
export const DEFAULT_LOCAL_DOWNLOAD_BYTES = 274_000_000;
const TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json"];
/** tokens per input; nomic allows 8192 but CPU cost grows with length. */
const MAX_TOKENS = 2048;
const BATCH = 16;

type Ort = typeof import("onnxruntime-node");
type Tok = InstanceType<typeof import("@huggingface/tokenizers").Tokenizer>;

interface Loaded {
  ort: Ort;
  device: "gpu" | "cpu";
  session: import("onnxruntime-node").InferenceSession;
  tokenizer: Tok;
  needsTokenTypes: boolean;
}

/** ollama's name for the same model; the shared default config carries it. */
const OLLAMA_NOMIC = "nomic-embed-text";

/** a directory under the cabinet: `<home>/models/<org>--<name>`. */
export function localModelDir(cfg: GroundedConfig, model: string): string {
  return join(cfg.home, "models", model.replace(/\//g, "--"));
}

export interface DownloadProgress {
  file: string;
  bytes: number;
  /** 0 when the server sent no length. */
  totalBytes: number;
}

/** Stream one file to `<dest>.part`, then rename: a cut download never looks complete. */
async function fetchTo(url: string, dest: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new EmbedError(`local model download failed (${url}): ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) throw new EmbedError(`local model download returned ${res.status} for ${url}`);
  const totalBytes = Number(res.headers.get("content-length") ?? 0);
  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp);
  let bytes = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      bytes += chunk.byteLength;
      if (onProgress && bytes - lastReport >= 1_000_000) {
        lastReport = bytes;
        onProgress({ file: dest, bytes, totalBytes });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw new EmbedError(`local model download interrupted (${url}): ${(err as Error).message}`);
  }
  renameSync(tmp, dest);
  onProgress?.({ file: dest, bytes, totalBytes });
}

/** fetch the model files once into the cabinet; later starts are offline. */
export async function ensureLocalModel(
  dir: string,
  model: string,
  modelFile: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const base = `https://huggingface.co/${model}/resolve/main`;
  for (const f of [...TOKENIZER_FILES, modelFile]) {
    const dest = join(dir, f);
    if (existsSync(dest)) continue;
    mkdirSync(join(dest, ".."), { recursive: true });
    await fetchTo(`${base}/${f}`, dest, onProgress);
  }
}

/** true when every file the model needs is already in `dir`. */
export function localModelPresent(dir: string, modelFile: string): boolean {
  return [...TOKENIZER_FILES, modelFile].every((f) => existsSync(join(dir, f)));
}

/** The model the "local" provider will load for this config, and where. */
export function resolveLocalModel(cfg: GroundedConfig): { model: string; modelFile: string; dir: string } {
  const configured = cfg.embeddings.model;
  const model = !configured || configured === OLLAMA_NOMIC ? DEFAULT_MODEL : configured;
  return {
    model,
    modelFile: cfg.embeddings.modelFile ?? DEFAULT_MODEL_FILE,
    dir: cfg.embeddings.modelPath ?? localModelDir(cfg, model),
  };
}

export function createLocalProvider(cfg: GroundedConfig): EmbeddingProvider {
  const { model, modelFile, dir } = resolveLocalModel(cfg);
  const dims = cfg.embeddings.dims ?? 768;
  // half the cores by default: embedding is bursty and should never pin the box.
  const threads = cfg.embeddings.threads ?? Math.max(1, Math.floor(availableParallelism() / 2));
  const device = cfg.embeddings.device ?? "auto";
  if (device !== "auto" && device !== "cpu" && device !== "gpu") {
    throw new ConfigError(`embeddings.device must be "auto", "cpu" or "gpu", got ${JSON.stringify(device)}`);
  }
  // DirectML ships inside onnxruntime-node on Windows and drives any DX12 GPU
  // (NVIDIA, AMD, Intel) with no CUDA install. Elsewhere: CPU for now.
  const gpuEp = process.platform === "win32" ? "dml" : undefined;
  let loading: Promise<Loaded> | undefined;
  let active: "gpu" | "cpu" | undefined;

  async function load(): Promise<Loaded> {
    let ort: Ort;
    let Tokenizer: typeof import("@huggingface/tokenizers").Tokenizer;
    try {
      ort = await import("onnxruntime-node");
      ({ Tokenizer } = await import("@huggingface/tokenizers"));
    } catch {
      throw new EmbedError(
        'local embeddings need onnxruntime-node and @huggingface/tokenizers (provider = "local")',
      );
    }
    if (!cfg.embeddings.modelPath) await ensureLocalModel(dir, model, modelFile);
    const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    const tokenizer = new Tokenizer(read("tokenizer.json"), read("tokenizer_config.json"));
    const path = join(dir, modelFile);
    // logSeverityLevel 3 = errors only: ORT warns about routine CPU placement of shape ops.
    const cpuOpts = {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    } as const;
    let session: import("onnxruntime-node").InferenceSession | undefined;
    let onGpu = false;
    if (device !== "cpu" && gpuEp) {
      try {
        // DirectML wants sequential execution and no memory pattern (ORT docs).
        session = await ort.InferenceSession.create(path, {
          ...cpuOpts,
          executionProviders: [gpuEp],
          executionMode: "sequential",
          enableMemPattern: false,
        });
        onGpu = true;
      } catch (err) {
        if (device === "gpu") throw new EmbedError(`no usable GPU for local embeddings: ${(err as Error).message}`);
      }
    } else if (device === "gpu") {
      throw new EmbedError(`local embeddings have no GPU backend on ${process.platform} yet`);
    }
    session ??= await ort.InferenceSession.create(path, { ...cpuOpts, executionProviders: ["cpu"] });
    active = onGpu ? "gpu" : "cpu";
    return {
      ort,
      device: active,
      session,
      tokenizer,
      needsTokenTypes: session.inputNames.includes("token_type_ids"),
    };
  }

  async function embedBatch(m: Loaded, texts: string[]): Promise<number[][]> {
    const encoded: number[][] = texts.map((t) => {
      const ids = m.tokenizer.encode(t).ids as number[];
      // keep [CLS] … [SEP]: truncate the middle-out tail, re-append the last special token.
      return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]!];
    });
    const len = Math.max(...encoded.map((e) => e.length));
    const n = texts.length;
    const ids = new BigInt64Array(n * len);
    const mask = new BigInt64Array(n * len);
    encoded.forEach((e, i) => {
      e.forEach((id, j) => {
        ids[i * len + j] = BigInt(id);
        mask[i * len + j] = 1n;
      });
    });
    const feeds: Record<string, import("onnxruntime-node").Tensor> = {
      input_ids: new m.ort.Tensor("int64", ids, [n, len]),
      attention_mask: new m.ort.Tensor("int64", mask, [n, len]),
    };
    if (m.needsTokenTypes) feeds.token_type_ids = new m.ort.Tensor("int64", new BigInt64Array(n * len), [n, len]);
    const out = await m.session.run(feeds);
    const hidden = out[m.session.outputNames[0]!]!;
    const h = hidden.dims[2]!;
    const data = hidden.data as Float32Array;
    // mean-pool over real tokens, then L2-normalise (sentence-transformers recipe for nomic).
    return encoded.map((e, i) => {
      const v = new Float64Array(h);
      for (let j = 0; j < e.length; j++) {
        const off = (i * len + j) * h;
        for (let k = 0; k < h; k++) v[k]! += data[off + k]!;
      }
      let norm = 0;
      for (let k = 0; k < h; k++) {
        v[k]! /= e.length;
        norm += v[k]! * v[k]!;
      }
      norm = Math.sqrt(norm) || 1;
      return Array.from(v, (x) => x / norm);
    });
  }

  return {
    id: `local:${model}`,
    dims,
    enabled: true,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const m = await (loading ??= load().catch((err) => {
        loading = undefined; // retry on the next call, e.g. after the network returns
        throw err;
      }));
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        try {
          out.push(...(await embedBatch(m, texts.slice(i, i + BATCH))));
        } catch (err) {
          throw err instanceof EmbedError ? err : new EmbedError(`local embed failed: ${(err as Error).message}`);
        }
      }
      return out;
    },
    async health(): Promise<{ ok: boolean; detail?: string; device?: "gpu" | "cpu" }> {
      const have = existsSync(join(dir, modelFile));
      try {
        await import("onnxruntime-node");
      } catch {
        return { ok: false, detail: "onnxruntime-node not installed" };
      }
      // known once the model has loaded; before that, "cpu" is certain only when forced.
      const where = active ?? (device === "cpu" || !gpuEp ? "cpu" : undefined);
      const how = where === "gpu" ? "gpu (directml)" : where === "cpu" ? `cpu, ${threads} threads` : "not loaded yet";
      return {
        ok: true,
        detail: `local ${model} (${how})${have ? "" : ", downloads on first use"}`,
        device: where,
      };
    },
  };
}
