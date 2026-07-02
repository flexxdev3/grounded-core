import { createContext } from "preact";
import { useContext, useState } from "preact/hooks";
import type { TypedId, SourceType } from "@grounded/core/contract";
import {
  IconOverview,
  IconFacts,
  IconSessions,
  IconDocs,
  IconBrief,
  IconRecall,
  IconHealth,
  IconLogo,
} from "./icons.js";
import { useToastChannel } from "./hooks.js";
import { RecordDrawer } from "./components/RecordDrawer.js";
import { OverviewView } from "./views/Overview.js";
import { FactsView } from "./views/Facts.js";
import { SessionsView } from "./views/Sessions.js";
import { DocsView } from "./views/Docs.js";
import { BriefView } from "./views/Brief.js";
import { RecallView } from "./views/Recall.js";
import { HealthView } from "./views/Health.js";

export type View = "overview" | "facts" | "sessions" | "docs" | "brief" | "recall" | "health";

export interface Counts {
  facts: number;
  sessions: number;
  docs: number;
}

interface AppApi {
  navigate: (v: View, opts?: { query?: string }) => void;
  openRecord: (id: TypedId) => void;
  counts: Counts;
  setCounts: (c: Counts) => void;
  recallSeed: string;
  storageAdapter: string;
}

const AppContext = createContext<AppApi | null>(null);
export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

const NAV: { view: View; label: string; icon: typeof IconFacts; group: "workspace" | "tools"; count?: keyof Counts }[] = [
  { view: "overview", label: "Overview", icon: IconOverview, group: "workspace" },
  { view: "facts", label: "Facts", icon: IconFacts, group: "workspace", count: "facts" },
  { view: "sessions", label: "Sessions", icon: IconSessions, group: "workspace", count: "sessions" },
  { view: "docs", label: "Docs", icon: IconDocs, group: "workspace", count: "docs" },
  { view: "brief", label: "Brief", icon: IconBrief, group: "workspace" },
  { view: "recall", label: "Recall", icon: IconRecall, group: "tools" },
  { view: "health", label: "Health", icon: IconHealth, group: "tools" },
];

export function App() {
  const [view, setView] = useState<View>("overview");
  const [drawerId, setDrawerId] = useState<TypedId | null>(null);
  const [recallSeed, setRecallSeed] = useState("");
  const [search, setSearch] = useState("");
  const [counts, setCounts] = useState<Counts>({ facts: 0, sessions: 0, docs: 0 });
  const [storageAdapter, setStorageAdapter] = useState("sqlite");
  const toastMsg = useToastChannel();

  const navigate = (v: View, opts?: { query?: string }) => {
    if (opts?.query !== undefined) setRecallSeed(opts.query);
    setView(v);
  };
  const openRecord = (id: TypedId) => setDrawerId(id);

  const submitSearch = (e: Event) => {
    e.preventDefault();
    if (!search.trim()) return;
    navigate("recall", { query: search.trim() });
  };

  const appApi: AppApi = { navigate, openRecord, counts, setCounts, recallSeed, storageAdapter };

  return (
    <AppContext.Provider value={appApi}>
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <IconLogo />
            </span>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
              <span class="brand-name">Grounded</span>
              <span class="brand-sub">console</span>
            </div>
          </div>

          {(["workspace", "tools"] as const).map((group) => (
            <div key={group} style={{ display: "contents" }}>
              <div class={`nav-group${group === "tools" ? " spaced" : ""}`}>
                {group === "workspace" ? "Workspace" : "Tools"}
              </div>
              {NAV.filter((n) => n.group === group).map((n) => {
                const Icon = n.icon;
                return (
                  <button
                    key={n.view}
                    class={`nav-btn${view === n.view ? " active" : ""}`}
                    onClick={() => navigate(n.view)}
                  >
                    <Icon />
                    <span class="label">{n.label}</span>
                    {n.count && counts[n.count] > 0 ? (
                      <span class="nav-pill">{counts[n.count]}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}

          <div class="sidebar-foot">
            <div class="status-line">
              <span class="status-dot" />
              online · self-hosted
            </div>
            <div class="status-meta">~/.grounded · {storageAdapter}</div>
          </div>
        </aside>

        <main class="main">
          <header class="topbar">
            <form class="searchbox" onSubmit={submitSearch}>
              <span class="prompt">&gt;_</span>
              <input
                value={search}
                onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                placeholder="Search the cabinet — facts, sessions, docs…"
              />
              <span class="hint">↵ recall</span>
            </form>
          </header>

          <div class="scroll">
            {view === "overview" && <OverviewView onAdapter={setStorageAdapter} />}
            {view === "facts" && <FactsView />}
            {view === "sessions" && <SessionsView />}
            {view === "docs" && <DocsView />}
            {view === "brief" && <BriefView />}
            {view === "recall" && <RecallView />}
            {view === "health" && <HealthView onAdapter={setStorageAdapter} />}
          </div>
        </main>

        {drawerId && <RecordDrawer typedId={drawerId} onClose={() => setDrawerId(null)} />}
        {toastMsg && <div class="toast">{toastMsg}</div>}
      </div>
    </AppContext.Provider>
  );
}

/** Map a source type to the view that lists it. */
export function viewForType(t: SourceType): View {
  return t === "fact" ? "facts" : t === "session" ? "sessions" : "docs";
}
