import { useState } from "preact/hooks";
import type { SessionInput } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { bumpData, toast } from "../hooks.js";
import { Modal } from "./Modal.js";

/** Log a session by hand. Summary + project are the gate; the rest is
 * optional and folded behind "More". */
export function SessionModal({ onClose, defaultProject }: { onClose: () => void; defaultProject: string }) {
  const [summary, setSummary] = useState("");
  const [project, setProject] = useState(defaultProject);
  const [details, setDetails] = useState("");
  const [tags, setTags] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!summary.trim() || busy) return;
    setBusy(true);
    const input: SessionInput = { summary: summary.trim(), source: "manual" };
    if (project.trim()) input.project = project.trim();
    if (details.trim()) input.details = details.trim();
    const t = tags.split(",").map((x) => x.trim()).filter(Boolean);
    if (t.length) input.tags = t;
    try {
      await api.sessions.add(input);
      toast("Session logged");
      bumpData();
      onClose();
    } catch (err) {
      toast(errMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Log session" onClose={onClose}>
      <form class="stack" style={{ gap: "0.9rem" }} onSubmit={submit}>
        <div>
          <label class="field-label">Summary</label>
          <input class="input" value={summary} placeholder="One line — what happened"
            onInput={(e) => setSummary((e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <label class="field-label">Project</label>
          <input class="input" value={project}
            onInput={(e) => setProject((e.target as HTMLInputElement).value)} />
        </div>
        {!more && (
          <button type="button" class="more-toggle" onClick={() => setMore(true)}>
            More — details, tags
          </button>
        )}
        {more && (
          <>
            <div>
              <label class="field-label">Details</label>
              <textarea class="textarea" value={details}
                onInput={(e) => setDetails((e.target as HTMLTextAreaElement).value)} />
            </div>
            <div>
              <label class="field-label">Tags (comma-separated)</label>
              <input class="input" value={tags}
                onInput={(e) => setTags((e.target as HTMLInputElement).value)} />
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "0.4rem" }}>
          <button type="button" class="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
            {busy ? <span class="spinner" /> : "Log session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
