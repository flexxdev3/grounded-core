import { Command } from "commander";
import { detect, resolveHome } from "@grounded/core";
import type { GlobalOpts } from "../util/global.js";
import { c, line, header, field, printJson, fail } from "../util/output.js";
import { confirm, interactive } from "../util/prompt.js";

const ADDONS = ["embeddings"] as const;
const POLL_MS = 1000;

interface AddonStatus {
  provider: string;
  enabled: boolean;
  runtimeInstalled: boolean;
  model: string;
  modelPresent: boolean;
  downloadBytes: number;
  gpuBackend: string | null;
  job: {
    state: "idle" | "running" | "done" | "error";
    phase?: string;
    download?: { file: string; bytes: number; totalBytes: number };
    backfill?: { lane: string; done: number; total: number };
    device?: "gpu" | "cpu";
    embedded?: { facts: number; sessions: number; docs: number };
    error?: string;
  };
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** The add-on runs inside the service (it swaps the live store), so the CLI only drives it over HTTP. */
async function serviceUrl(g: GlobalOpts, port?: string): Promise<string> {
  const home = resolveHome(g.home ?? process.env.GROUNDED_HOME);
  const d = await detect({ home, ...(port ? { port: Number(port) } : {}) });
  if (!d.running || !d.health) fail("Grounded is not running. Start it with `grounded start`, then retry.");
  return `http://127.0.0.1:${d.health.port}`;
}

async function call(url: string, init?: RequestInit): Promise<{ status: number; data: AddonStatus }> {
  const token = process.env.GROUNDED_API_TOKEN;
  const res = await fetch(`${url}/addons/embeddings`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = (await res.json()) as { data?: AddonStatus; error?: string };
  if (!body.data) fail(body.error ?? `the service answered ${res.status}`);
  return { status: res.status, data: body.data };
}

function describe(s: AddonStatus): void {
  field("search by meaning", s.enabled ? c.green(`on (${s.provider})`) : c.yellow("off (keyword search only)"));
  field("model", s.model);
  field("download", s.modelPresent ? "already downloaded" : `${mb(s.downloadBytes)}, once`);
  field("graphics card", s.gpuBackend ? `used when available (${s.gpuBackend})` : "not supported here yet; runs on the CPU");
}

function progress(j: AddonStatus["job"]): string {
  if (j.phase === "download" && j.download) {
    const pct = j.download.totalBytes ? ` ${Math.floor((j.download.bytes / j.download.totalBytes) * 100)}%` : "";
    return `downloading ${j.download.file} ${mb(j.download.bytes)}${pct}`;
  }
  if (j.phase === "backfill" && j.backfill) return `embedding existing ${j.backfill.lane} ${j.backfill.done}/${j.backfill.total}`;
  return (
    { probe: "loading the model", config: "updating config", reload: "switching search on" }[j.phase ?? ""] ?? "starting"
  );
}

export function addonCommand(global: () => GlobalOpts): Command {
  const cmd = new Command("addon").description("optional add-ons (embeddings)");

  cmd
    .command("status")
    .description("show the add-ons and whether they are on")
    .option("--port <n>", "service port")
    .action(async (opts: { port?: string }) => {
      const g = global();
      const { data } = await call(await serviceUrl(g, opts.port));
      if (g.json) return printJson({ embeddings: data });
      header("Embeddings add-on");
      describe(data);
    });

  cmd
    .command("add")
    .argument("<name>", `add-on to turn on: ${ADDONS.join(" | ")}`)
    .description("turn on an add-on (embeddings: download the model and switch on search by meaning)")
    .option("--device <d>", "auto | cpu | gpu (default auto: the GPU when usable)")
    .option("--port <n>", "service port")
    .option("-y, --yes", "no confirmation prompt")
    .action(async (name: string, opts: { device?: string; port?: string; yes?: boolean }) => {
      const g = global();
      if (!(ADDONS as readonly string[]).includes(name)) fail(`unknown add-on "${name}". Available: ${ADDONS.join(", ")}`);
      if (opts.device && !["auto", "cpu", "gpu"].includes(opts.device)) fail("--device must be auto, cpu or gpu");
      const url = await serviceUrl(g, opts.port);
      const { data: plan } = await call(url);

      header("Embeddings add-on");
      describe(plan);
      if (!plan.runtimeInstalled) fail("this install is missing the embeddings runtime (onnxruntime-node).");
      if (plan.enabled && plan.job.state !== "running") {
        line(c.green("already on."));
        return;
      }
      line();
      line("Grounded will download the model, check for a usable graphics card, switch on search");
      line("by meaning and embed everything already in your cabinet. It keeps working meanwhile.");
      if (!opts.yes && interactive && !(await confirm("Turn it on?", true))) return line(c.dim("aborted."));

      const started = await call(url, { method: "POST", body: JSON.stringify(opts.device ? { device: opts.device } : {}) });
      if (started.status === 409) line(c.dim("already running; following it."));

      let last = "";
      for (;;) {
        const { data } = await call(url);
        const j = data.job;
        if (j.state === "error") fail(`embeddings add-on failed: ${j.error ?? "unknown error"}`);
        if (j.state === "done") {
          line(c.green(`search by meaning is on (${j.device === "gpu" ? "graphics card" : "CPU"}).`));
          if (j.embedded) line(c.dim(`embedded ${j.embedded.facts} facts, ${j.embedded.sessions} sessions, ${j.embedded.docs} doc chunks`));
          if (j.device === "cpu") {
            line(c.yellow("Embeddings run on the CPU here: slower, and heavier on the computer than on a GPU."));
          }
          return;
        }
        const p = progress(j);
        if (p !== last) {
          line(c.dim(p));
          last = p;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    });

  return cmd;
}
