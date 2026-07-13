import { useState } from "preact/hooks";
import { auth } from "../lib/api.js";
import { errMessage } from "../lib/api.js";
import { HERO_BRIEF } from "../lib/brief.js";
import { BriefPanel } from "../components/ui.js";
import { Logo, IconGithub } from "../components/icons.js";

type Mode = "signin" | "signup";

export function Auth({ onAuthed }: { onAuthed: () => void | Promise<void> }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") await auth.signUp(email, password, name);
      else await auth.signIn(email, password);
      await onAuthed();
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  };

  return (
    <div class="auth">
      <section class="auth-hero">
        <div class="brandmark">
          <Logo />
          <span class="wordmark">Grounded</span>
          <span class="cloud">cloud</span>
        </div>

        <div style={{ marginTop: "auto" }}>
          <p class="eyebrow" style={{ marginBottom: "1rem" }}>
            <span class="p">&gt;_</span> hosted continuity
          </p>
          <h1 class="display" style={{ maxWidth: "12ch" }}>
            Your agents forget.
          </h1>
          <h1 class="display" style={{ color: "var(--verdigris)", textShadow: "var(--phos)", maxWidth: "12ch" }}>
            Grounded doesn't.
          </h1>
          <p class="lede mt-md" style={{ maxWidth: "42ch" }}>
            A hosted cabinet your agents point at — facts, work history, a shared vision, and a startup
            brief, cited and inspectable. Start any agent already sharing your vision.
          </p>
        </div>

        <div style={{ marginTop: "1.75rem" }}>
          <BriefPanel lines={HERO_BRIEF} title="a cold agent, woken up oriented" />
        </div>
      </section>

      <section class="auth-form-col">
        <div class="auth-form">
          <div class="seg" role="tablist" aria-label="Sign in or sign up">
            <button role="tab" aria-selected={mode === "signin"} class={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>
              Log in
            </button>
            <button role="tab" aria-selected={mode === "signup"} class={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
              Sign up
            </button>
          </div>

          <h2 class="h2">{mode === "signin" ? "Welcome back." : "Create your cabinet."}</h2>
          <p class="muted" style={{ marginTop: "0.5rem", marginBottom: "1.6rem" }}>
            {mode === "signin" ? "Pick up exactly where the work left off." : "One account, one isolated cabinet. Live in about a minute."}
          </p>

          <button type="button" class="btn btn-ghost btn-block" onClick={() => auth.github()} style={{ marginBottom: "0.4rem" }}>
            <IconGithub width={16} height={16} />
            Continue with GitHub
          </button>
          <div class="divider-or">or with email</div>

          <form onSubmit={submit}>
            {mode === "signup" && (
              <div class="field">
                <label class="field-label" for="name">Name</label>
                <input id="name" class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Ada Lovelace" autoComplete="name" />
              </div>
            )}
            <div class="field">
              <label class="field-label" for="email">Email</label>
              <input id="email" class="input" type="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="you@studio.dev" autoComplete="email" />
            </div>
            <div class="field">
              <label class="field-label" for="password">Password</label>
              <input id="password" class="input" type="password" required minLength={8} value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} placeholder="At least 8 characters" autoComplete={mode === "signin" ? "current-password" : "new-password"} />
            </div>

            {error && <div class="notice notice-error" style={{ marginBottom: "1rem" }}>{error}</div>}

            <button class="btn btn-block" type="submit" disabled={busy}>
              {busy ? "Working…" : mode === "signin" ? "Log in" : "Create cabinet"}
            </button>
          </form>

          <p class="mono dim" style={{ fontSize: "var(--fs-mono-sm)", marginTop: "1.4rem", lineHeight: 1.6 }}>
            {mode === "signin" ? "New here? " : "Already have a cabinet? "}
            <button
              class="tlink"
              style={{ textTransform: "none", letterSpacing: "0.02em" }}
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? "Create one" : "Log in"}
            </button>
          </p>
        </div>
      </section>
    </div>
  );
}
