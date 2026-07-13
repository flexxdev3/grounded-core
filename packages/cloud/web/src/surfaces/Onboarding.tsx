import { useEffect, useState } from "preact/hooks";
import { account } from "../lib/api.js";
import { errMessage } from "../lib/api.js";
import type { IssuedToken } from "../lib/types.js";
import { BriefPanel, CopyButton, Term } from "../components/ui.js";
import { Logo, IconArrow, IconCheck } from "../components/icons.js";

type Phase = "provisioning" | "live" | "error";

export function Onboarding({ onDone, email }: { onDone: () => void | Promise<void>; email: string }) {
  const [phase, setPhase] = useState<Phase>("provisioning");
  const [endpoint, setEndpoint] = useState("");
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const status = await account.cabinet(); // provisions on first call
        const token = await account.tokens.create("first token");
        if (!live) return;
        setEndpoint(status.endpoint);
        setIssued(token);
        setPhase("live");
      } catch (e) {
        if (!live) return;
        setError(errMessage(e));
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div class="scroll" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div class="view" style={{ maxWidth: "44rem", width: "100%" }}>
        <div class="brandmark" style={{ justifyContent: "center", marginBottom: "1.75rem" }}>
          <Logo />
          <span class="wordmark">Grounded</span>
          <span class="cloud">cloud</span>
        </div>

        {phase === "provisioning" && (
          <div class="card scanned" style={{ textAlign: "center" }}>
            <p class="eyebrow" style={{ justifyContent: "center", marginBottom: "1.25rem" }}>
              <span class="p">&gt;_</span> provisioning
            </p>
            <div class="center-note" style={{ minHeight: "auto" }}>
              <span class="spinner" />
              <span class="mono muted">creating your isolated cabinet…</span>
            </div>
            <p class="dim mono" style={{ fontSize: "var(--fs-mono-sm)", marginTop: "0.75rem" }}>
              schema-per-tenant · migrating · opening store
            </p>
          </div>
        )}

        {phase === "error" && (
          <div class="card">
            <div class="notice notice-error">{error}</div>
            <button class="btn mt-md" onClick={() => location.reload()}>Try again</button>
          </div>
        )}

        {phase === "live" && issued && (
          <>
            <div class="view-head" style={{ textAlign: "center" }}>
              <p class="eyebrow" style={{ justifyContent: "center", color: "var(--verdigris)", marginBottom: "0.8rem" }}>
                <IconCheck /> cabinet live
              </p>
              <h1 class="h1">You're live, {email.split("@")[0]}.</h1>
              <p class="lede" style={{ margin: "0.7rem auto 0" }}>
                Point any agent at your endpoint with the token below. It's shown once — save it now.
              </p>
            </div>

            <div class="card" style={{ marginBottom: "1.1rem" }}>
              <div class="field" style={{ marginBottom: "1.25rem" }}>
                <span class="field-label">Endpoint</span>
                <div class="row" style={{ gap: "0.6rem" }}>
                  <code class="input mono" style={{ display: "flex", alignItems: "center" }}>{endpoint}</code>
                  <CopyButton value={endpoint} label="Copy" toastMsg="Endpoint copied" />
                </div>
              </div>

              <div class="field" style={{ marginBottom: 0 }}>
                <span class="field-label">API token</span>
                <div class="row" style={{ gap: "0.6rem" }}>
                  <code class="input mono" style={{ display: "flex", alignItems: "center", color: "var(--verdigris-bright)", overflowX: "auto", whiteSpace: "nowrap" }}>
                    {issued.secret}
                  </code>
                  <CopyButton value={issued.secret} label="Copy" toastMsg="Token copied — store it safely" />
                </div>
                <div class="notice notice-warn mt-sm">
                  This secret won't be shown again. Store it in your secret manager — you can revoke and
                  reissue anytime from API tokens.
                </div>
              </div>
            </div>

            <p class="eyebrow" style={{ margin: "1.6rem 0 0.7rem" }}>
              <span class="p">&gt;_</span> connect your agent
            </p>
            <Term title="~/.claude · SessionStart hook" code={issued.connect.hook} />

            <div class="row-between mt-lg" style={{ justifyContent: "flex-end" }}>
              <button class="btn" onClick={onDone}>
                Go to dashboard <IconArrow />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
