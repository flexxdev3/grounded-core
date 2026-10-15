import { useEffect, useState } from "preact/hooks";
import type { HealthReport } from "@grounded/core/contract";
import type { EmbeddingsAddonStatus } from "@grounded/client";
import { api, errMessage } from "../api.js";
import { Modal } from "./Modal.js";

const DISMISS_KEY = "grounded.embeddingsNotice.dismissed";
const HEALTH_POLL_MS = 60_000;
const JOB_POLL_MS = 1000;

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * The console's two embedding notices, in plain language — most users do not
 * know what an embedding is:
 *  - off (lexical-only): recommend the Embeddings add-on. Never turned on for
 *    the user, because it downloads a model.
 *  - on, but on the CPU: say it is slower and heavier than on a GPU.
 * "Not now" / "Got it" is remembered per state, so a change shows it again.
 */
export function EmbeddingsNotice({ onDetails }: { onDetails: () => void }) {
  const [emb, setEmb] = useState<HealthReport["embeddings"] | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [setupOpen, setSetupOpen] = useState(false);

  const refresh = () =>
    api
      .health()
      .then((h) => setEmb(h.embeddings))
      .catch(() => {});

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, []);

  if (!emb) return null;
  const off = emb.dims === 0;
  const key = off ? "off" : emb.device === "cpu" ? `${emb.provider}@cpu` : null;

  const dismiss = () => {
    if (!key) return;
    setDismissed(key);
    try {
      localStorage.setItem(DISMISS_KEY, key);
    } catch {
      /* this visit only */
    }
  };

  const banner =
    key && dismissed !== key ? (
      off ? (
        <div class="emb-notice" role="status">
          <span class="emb-notice-mark" aria-hidden="true">◇</span>
          <div class="emb-notice-body">
            <strong>Search by meaning is off.</strong>
            <span>
              Right now Grounded finds things by matching your words. Turn on the Embeddings add-on and it also finds
              them by meaning, so “coffee maker cleaning” finds your note about descaling the espresso machine. It is
              a one-time download.
            </span>
          </div>
          <div class="emb-notice-actions">
            <button class="btn btn-ghost" onClick={dismiss}>
              Not now
            </button>
            <button class="btn btn-primary" onClick={() => setSetupOpen(true)}>
              Set up
            </button>
          </div>
        </div>
      ) : (
        <div class="emb-notice emb-notice-warn" role="status">
          <span class="emb-notice-mark" aria-hidden="true">◐</span>
          <div class="emb-notice-body">
            <strong>Grounded is using your processor (CPU) for search.</strong>
            <span>
              To find things by meaning, Grounded turns your notes into numbers called embeddings. Right now that work
              runs on the CPU instead of a graphics card (GPU). Everything still works, but adding lots of documents
              is slower and your computer may run warm and loud while it does. Embeddings are recommended on a
              computer with a GPU.
            </span>
          </div>
          <div class="emb-notice-actions">
            <button class="btn btn-ghost" onClick={onDetails}>
              Details
            </button>
            <button class="btn" onClick={dismiss}>
              Got it
            </button>
          </div>
        </div>
      )
    ) : null;

  return (
    <>
      {banner}
      {setupOpen && (
        <EmbeddingsSetup
          onClose={() => {
            setSetupOpen(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

const PHASE_LABEL: Record<string, string> = {
  probe: "Loading the model and checking for a graphics card…",
  config: "Saving the setting…",
  reload: "Switching search by meaning on…",
};

export function EmbeddingsSetup({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<EmbeddingsAddonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = () =>
    api.addons.embeddings
      .status()
      .then(setStatus)
      .catch((e) => setError(errMessage(e)));

  useEffect(() => {
    poll();
  }, []);

  const running = status?.job.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(poll, JOB_POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const start = () => {
    setError(null);
    api.addons.embeddings
      .start()
      .then(setStatus)
      .catch((e) => {
        setError(errMessage(e));
        poll();
      });
  };

  const job = status?.job;
  let body;
  if (!status) {
    body = <p class="emb-muted">{error ?? "Checking this computer…"}</p>;
  } else if (!status.runtimeInstalled) {
    body = (
      <p>
        This copy of Grounded was installed without the embeddings runtime, so the add-on cannot run here. Reinstall
        Grounded with the Embeddings add-on included.
      </p>
    );
  } else if (job?.state === "done") {
    body = (
      <div class="emb-steps">
        <p>
          <strong>Search by meaning is on.</strong>{" "}
          {job.device === "gpu"
            ? "It runs on your graphics card, so it stays fast and light."
            : "It runs on your processor (CPU) because no usable graphics card was found. It works, but adding lots of documents is slower and heavier on this computer."}
        </p>
        {job.embedded && (
          <p class="emb-muted">
            Added meaning to {job.embedded.facts} facts, {job.embedded.sessions} sessions and {job.embedded.docs} pieces
            of documents you already had.
          </p>
        )}
      </div>
    );
  } else if (running && job) {
    let label = PHASE_LABEL[job.phase ?? ""] ?? "Starting…";
    let pct: number | null = null;
    if (job.phase === "download" && job.download) {
      label = `Downloading the model… ${mb(job.download.bytes)}${job.download.totalBytes ? ` of ${mb(job.download.totalBytes)}` : ""}`;
      pct = job.download.totalBytes ? job.download.bytes / job.download.totalBytes : null;
    } else if (job.phase === "backfill" && job.backfill) {
      label = `Adding meaning to your ${job.backfill.lane}… ${job.backfill.done} of ${job.backfill.total}`;
      pct = job.backfill.total ? job.backfill.done / job.backfill.total : null;
    }
    body = (
      <div class="emb-steps">
        <p>{label}</p>
        <div class={`emb-bar${pct === null ? " emb-bar-busy" : ""}`}>
          <span style={{ width: pct === null ? undefined : `${Math.round(pct * 100)}%` }} />
        </div>
        <p class="emb-muted">You can close this window. Grounded keeps working while this finishes.</p>
      </div>
    );
  } else {
    body = (
      <div class="emb-steps">
        <p>Grounded will:</p>
        <ol>
          <li>
            Download the language model once ({status.modelPresent ? "already downloaded" : mb(status.downloadBytes)}).
            It stays in your Grounded folder; nothing you save is sent anywhere.
          </li>
          <li>
            {status.gpuBackend
              ? "Use your graphics card (GPU) if it supports it. Without one it runs on the processor (CPU), which is slower and heavier."
              : "Run it on your processor (CPU). That works, but it is slower and heavier than on a graphics card."}
          </li>
          <li>Add meaning to everything you have already saved.</li>
        </ol>
        <p class="emb-muted">Grounded keeps working the whole time.</p>
        {job?.state === "error" && <p class="emb-error">The last attempt failed: {job.error}</p>}
      </div>
    );
  }

  const canStart = status && status.runtimeInstalled && !running && job?.state !== "done";
  return (
    <Modal
      title="Turn on search by meaning"
      onClose={onClose}
      footer={
        <>
          <button class="btn btn-ghost" onClick={onClose}>
            {job?.state === "done" ? "Done" : running ? "Close" : "Not now"}
          </button>
          {canStart && (
            <button class="btn btn-primary" onClick={start}>
              {job?.state === "error" ? "Try again" : status.modelPresent ? "Turn on" : "Download and turn on"}
            </button>
          )}
        </>
      }
    >
      {body}
      {error && status && <p class="emb-error">{error}</p>}
    </Modal>
  );
}
