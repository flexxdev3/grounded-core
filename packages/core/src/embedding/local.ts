import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
/**
 * fp16 weights: cosine 1.0 to the fp32 file at the same CPU speed, half the
 * download (273 MB). int8 is ~2x faster but drifts (min cosine 0.947).
 * Measured on vivobook i9-13980HX, 2026-10-15.
 */
const DEFAULT_MODEL_FILE = "onnx/model_fp16.onnx";
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

/** a directory under the cabinet: `<home>/models/<org>--<name>`. */
export function localModelDir(cfg: GroundedConfig, model: string): string {
  return join(cfg.home, "models", model.replace(/\//g, "--"));
}

async function fetchTo(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new EmbedError(`local model download failed (${url}): ${(err as Error).message}`);
  }
  if (!res.ok) throw new EmbedError(`local model download returned ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, dest);
}

/** fetch the model files once into the cabinet; later starts are offline. */
export async function ensureLocalModel(dir: string, model: string, modelFile: string): Promise<void> {
  const base = `https://huggingface.co/${model}/resolve/main`;
  for (const f of [...TOKENIZER_FILES, modelFile]) {
    const dest = join(dir, f);
    if (existsSync(dest)) continue;
    mkdirSync(join(dest, ".."), { recursive: true });
    await fetchTo(`${base}/${f}`, dest);
  }
}

export function createLocalProvider(cfg: GroundedConfig): EmbeddingProvider {
  const model = cfg.embeddings.model ?? DEFAULT_MODEL;
  const dims = cfg.embeddings.dims ?? 768;
  const dir = cfg.embeddings.modelPath ?? localModelDir(cfg, model);
  const modelFile = cfg.embeddings.modelFile ?? DEFAULT_MODEL_FILE;
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
    const cpuOpts = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: "all" } as const;
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
