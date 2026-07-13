import { useState } from "preact/hooks";
import { account, errMessage } from "../lib/api.js";
import { Modal, toast } from "../components/ui.js";
import { useSession } from "../app.js";

export function Settings() {
  const { me } = useSession();
  const [name, setName] = useState(me.user.name ?? "");
  const [confirming, setConfirming] = useState(false);

  return (
    <div class="view">
      <div class="view-head">
        <p class="eyebrow"><span class="p">&gt;_</span> settings</p>
        <h1 class="h1">Settings</h1>
        <p class="lede">Your profile, security, and cabinet data.</p>
      </div>

      {/* Profile */}
      <div class="card" style={{ marginBottom: "1.25rem" }}>
        <h3 class="h3" style={{ marginBottom: "1.25rem" }}>Profile</h3>
        <form onSubmit={(e) => { e.preventDefault(); toast("Profile saved"); }}>
          <div class="field">
            <label class="field-label" for="pname">Name</label>
            <input id="pname" class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label class="field-label" for="pemail">Email</label>
            <input id="pemail" class="input" type="email" value={me.user.email} disabled />
            <span class="field-hint">Contact support to change the email on your account.</span>
          </div>
          <button class="btn btn-sm" type="submit">Save changes</button>
        </form>
      </div>

      {/* Password */}
      <div class="card" style={{ marginBottom: "1.25rem" }}>
        <h3 class="h3" style={{ marginBottom: "1.25rem" }}>Password</h3>
        <form onSubmit={(e) => { e.preventDefault(); toast("Password updated"); }}>
          <div class="grid-2">
            <div class="field">
              <label class="field-label" for="cur">Current password</label>
              <input id="cur" class="input" type="password" autoComplete="current-password" />
            </div>
            <div class="field">
              <label class="field-label" for="nw">New password</label>
              <input id="nw" class="input" type="password" minLength={8} autoComplete="new-password" />
            </div>
          </div>
          <button class="btn btn-sm" type="submit">Update password</button>
        </form>
      </div>

      {/* Export */}
      <div class="card" style={{ marginBottom: "1.25rem" }}>
        <div class="row-between" style={{ alignItems: "flex-start" }}>
          <div style={{ maxWidth: "42ch" }}>
            <h3 class="h3">Export cabinet</h3>
            <p class="muted" style={{ margin: "0.5rem 0 0" }}>
              A single dump of your whole cabinet — restorable anywhere, including a self-hosted install. No lock-in.
            </p>
          </div>
          <button class="btn btn-ghost btn-sm" onClick={() => toast("Export is coming soon")} title="Coming soon">
            Export <span class="tag tag-copper" style={{ marginLeft: "0.4rem" }}>soon</span>
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div class="card" style={{ borderColor: "var(--line-danger)" }}>
        <div class="row-between" style={{ alignItems: "flex-start" }}>
          <div style={{ maxWidth: "42ch" }}>
            <h3 class="h3" style={{ color: "var(--danger-bright)" }}>Delete account</h3>
            <p class="muted" style={{ margin: "0.5rem 0 0" }}>
              Permanently deletes your account and drops your cabinet schema. Export first — this can't be undone.
            </p>
          </div>
          <button class="btn btn-danger btn-sm" onClick={() => setConfirming(true)}>Delete account</button>
        </div>
      </div>

      {confirming && <DeleteModal onClose={() => setConfirming(false)} />}
    </div>
  );
}

function DeleteModal({ onClose }: { onClose: () => void }) {
  const { signOut } = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = text.trim().toUpperCase() === "DELETE";

  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await account.deleteAccount();
      await signOut();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete account" onClose={onClose}>
      <div class="notice notice-warn" style={{ marginBottom: "1rem" }}>
        This drops your cabinet schema and every fact, session, and doc in it. Consider exporting first.
      </div>
      <div class="field">
        <label class="field-label" for="confirm">Type DELETE to confirm</label>
        <input id="confirm" class="input mono" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="DELETE" autoFocus />
      </div>
      {error && <div class="notice notice-error">{error}</div>}
      <div class="modal-actions">
        <button class="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button class="btn btn-danger" onClick={del} disabled={!armed || busy}>{busy ? "Deleting…" : "Delete forever"}</button>
      </div>
    </Modal>
  );
}
