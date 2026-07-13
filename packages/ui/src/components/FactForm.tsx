import { useState } from "preact/hooks";
import type { Fact, FactInput } from "@grounded/core/contract";

/** Shared add/edit form. Submitting produces a FactInput that the caller
 *  feeds to add() (new) or update() (edit in place). */
export function FactForm(props: {
  initial?: Fact;
  submitLabel: string;
  onSubmit: (input: FactInput) => Promise<void> | void;
  onCancel: () => void;
}) {
  const i = props.initial;
  const [fact, setFact] = useState(i?.fact ?? "");
  const [scope, setScope] = useState(i?.scope ?? "global");
  const [category, setCategory] = useState(i?.category ?? "");
  const [detail, setDetail] = useState(i?.detail ?? "");
  const [topicKey, setTopicKey] = useState(i?.topicKey ?? "");
  const [pinned, setPinned] = useState(i?.pinned ?? false);
  const [importance, setImportance] = useState(i?.importance ?? 0);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!fact.trim() || busy) return;
    setBusy(true);
    const input: FactInput = {
      fact: fact.trim(),
      scope: scope.trim() || "global",
      pinned,
      importance,
    };
    if (category.trim()) input.category = category.trim();
    if (detail.trim()) input.detail = detail.trim();
    if (topicKey.trim()) input.topicKey = topicKey.trim();
    try {
      await props.onSubmit(input);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack" style={{ gap: "0.9rem" }} onSubmit={submit}>
      <div>
        <label class="field-label">Fact</label>
        <textarea
          class="textarea"
          value={fact}
          placeholder="The sharp one-liner — the rule itself"
          onInput={(e) => setFact((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.9rem" }}>
        <div>
          <label class="field-label">Scope</label>
          <input class="input" value={scope} placeholder="global | project:x | agent:y"
            onInput={(e) => setScope((e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <label class="field-label">Category</label>
          <input class="input" value={category} placeholder="commit-rule, homelab…"
            onInput={(e) => setCategory((e.target as HTMLInputElement).value)} />
        </div>
      </div>
      <div>
        <label class="field-label">Detail (when to apply)</label>
        <textarea class="textarea" style={{ minHeight: "4rem" }} value={detail}
          onInput={(e) => setDetail((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.9rem", alignItems: "end" }}>
        <div>
          <label class="field-label">Topic key (dedupe)</label>
          <input class="input" value={topicKey} placeholder="commit-no-ai-trailer"
            onInput={(e) => setTopicKey((e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <label class="field-label">Importance · {importance.toFixed(2)}</label>
          <input type="range" min="0" max="1" step="0.05" value={importance} style={{ width: "100%" }}
            onInput={(e) => setImportance(Number((e.target as HTMLInputElement).value))} />
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned((e.target as HTMLInputElement).checked)} />
        <span class="mono" style={{ fontSize: "0.7rem", letterSpacing: "0.06em", color: "var(--copper-bright)" }}>
          ★ Pinned — ranks above session lore
        </span>
      </label>
      <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "0.4rem" }}>
        <button type="button" class="btn btn-ghost btn-sm" onClick={props.onCancel}>Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? <span class="spinner" /> : props.submitLabel}
        </button>
      </div>
    </form>
  );
}
