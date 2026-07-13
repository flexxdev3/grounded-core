import { useEffect, useState } from "preact/hooks";
import { account, errMessage } from "../lib/api.js";
import type { ApiToken, IssuedToken } from "../lib/types.js";
import { CopyButton, Modal, Term, toast } from "../components/ui.js";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso).getTime();
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function on(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function Tokens() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const load = () => account.tokens.list().then(setTokens).catch((e) => setError(errMessage(e)));
  useEffect(() => {
    load();
  }, []);

  return (
    <div class="view view-wide">
      <div class="view-head row-between" style={{ alignItems: "flex-end" }}>
        <div>
          <p class="eyebrow"><span class="p">&gt;_</span> api tokens</p>
          <h1 class="h1">API tokens</h1>
          <p class="lede">How your agents authenticate to this cabinet. Secrets are shown once at creation.</p>
        </div>
        <button class="btn" onClick={() => setCreating(true)}>Create token</button>
      </div>

      {error && <div class="notice notice-error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {!tokens ? (
        <div class="center-note"><span class="spinner" /><span class="mono dim">loading tokens…</span></div>
      ) : tokens.length === 0 ? (
        <div class="card" style={{ textAlign: "center", padding: "3rem 2rem" }}>
          <h3 class="h3">No tokens yet.</h3>
          <p class="muted" style={{ margin: "0.6rem 0 1.4rem" }}>Create your first token to connect an agent.</p>
          <button class="btn" onClick={() => setCreating(true)}>Create token</button>
        </div>
      ) : (
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th class="mono">Prefix</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Created</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td class="mono">grnd_{t.prefix}…</td>
                  <td>
                    {t.scopes.map((s) => (
                      <span class="tag tag-muted" key={s} style={{ marginRight: "0.3rem" }}>{s}</span>
                    ))}
                  </td>
                  <td class="mono">{ago(t.lastUsedAt)}</td>
                  <td class="mono">{on(t.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button class="btn-danger btn btn-sm" onClick={() => setRevoking(t)}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={load} />}
      {revoking && (
        <RevokeModal
          token={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await account.tokens.create(name.trim() || "default");
      setIssued(res);
      onCreated();
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={issued ? "Token created" : "Create API token"} onClose={onClose}>
      {!issued ? (
        <form onSubmit={create}>
          <div class="field">
            <label class="field-label" for="tname">Name</label>
            <input id="tname" class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="claude-code · laptop" autoFocus />
            <span class="field-hint">A label to recognize this token later — e.g. the agent and machine.</span>
          </div>
          {error && <div class="notice notice-error">{error}</div>}
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" class="btn" disabled={busy}>{busy ? "Creating…" : "Create token"}</button>
          </div>
        </form>
      ) : (
        <div>
          <div class="field">
            <span class="field-label">Secret — shown once</span>
            <div class="row" style={{ gap: "0.6rem" }}>
              <code class="input mono" style={{ display: "flex", alignItems: "center", color: "var(--verdigris-bright)", overflowX: "auto", whiteSpace: "nowrap" }}>{issued.secret}</code>
              <CopyButton value={issued.secret} toastMsg="Token copied — store it safely" />
            </div>
            <div class="notice notice-warn mt-sm">Copy it now — you won't be able to see this secret again.</div>
          </div>
          <p class="eyebrow" style={{ margin: "1.2rem 0 0.6rem" }}><span class="p">&gt;_</span> ready to paste</p>
          <Term title="SessionStart hook" code={issued.connect.hook} />
          <div class="modal-actions">
            <button class="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RevokeModal({ token, onClose, onRevoked }: { token: ApiToken; onClose: () => void; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await account.tokens.revoke(token.id);
      toast("Token revoked");
      onRevoked();
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Revoke token" onClose={onClose}>
      <p class="muted">
        Revoke <b style={{ color: "var(--paper)" }}>{token.name}</b> (<span class="mono">grnd_{token.prefix}…</span>)? Any agent
        using it will lose access immediately. This can't be undone.
      </p>
      {error && <div class="notice notice-error mt-sm">{error}</div>}
      <div class="modal-actions">
        <button class="btn btn-ghost" onClick={onClose}>Keep it</button>
        <button class="btn btn-danger" onClick={revoke} disabled={busy}>{busy ? "Revoking…" : "Revoke token"}</button>
      </div>
    </Modal>
  );
}
