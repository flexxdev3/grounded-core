import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { TypedId, SourceType, Session, ListResult, HealthReport } from "@grounded/core/contract";
import { api } from "./api.js";
import {
  IconHome,
  IconReview,
  IconBrief,
  IconRecall,
  IconAgents,
  IconMachines,
  IconDatabox,
  IconLogo,
} from "./icons.js";
import { useAsync, useDataVersion, useMedia, useToastChannel } from "./hooks.js";
import { navigate as routerNavigate, useRoute, type View } from "./router.js";
import { useTheme, nextTheme, type ThemePref } from "./theme.js";
import { useReview } from "./lib/useReview.js";
import { RecordDrawer } from "./components/RecordDrawer.js";
import { EmbeddingsNotice } from "./components/EmbeddingsNotice.js";
import { HomeView } from "./views/Home.js";
import { ReviewView } from "./views/Review.js";
import { BriefView } from "./views/Brief.js";
import { SearchView } from "./views/Search.js";
import { AgentsView } from "./views/Agents.js";
import { MachinesView } from "./views/Machines.js";
import { DataboxView } from "./views/Databox.js";
import { TrayView } from "./views/Tray.js";

export type { View };

interface AppApi {
  navigate: (v: View, params?: Record<string, string>) => void;
  openRecord: (id: TypedId) => void;
  /** current route params (e.g. search `q`). */
  params: URLSearchParams;
  health: HealthReport | null;
  reloadHealth: () => void;
  /** current project scope; null = all projects. */
  project: string | null;
  setProject: (p: string | null) => void;
  /** known projects, most-recent first. */
  projects: string[];
  /** new-since-review counts for the badge + Home queue. */
  review: ReturnType<typeof useReview>;
}

const PROJECT_KEY = "grounded.project";
const ALL = "__all__";

function loadStoredProject(): { value: string | null; explicit: boolean } {
  try {
    const v = localStorage.getItem(PROJECT_KEY);
    if (v === null) return { value: null, explicit: false };
    return { value: v === ALL ? null : v, explicit: true };
  } catch {
    return { value: null, explicit: false };
  }
}

const AppContext = createContext<AppApi | null>(null);
export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

/** Map a source type to the screen that lists it. */
export function viewForType(t: SourceType): View {
  return t === "doc" ? "search" : "review";
}

const NAV: { view: View; label: string; icon: typeof IconHome }[] = [
  { view: "home", label: "Home", icon: IconHome },
  { view: "review", label: "Review", icon: IconReview },
  { view: "brief", label: "Brief", icon: IconBrief },
  { view: "search", label: "Search", icon: IconRecall },
  { view: "agents", label: "Agents", icon: IconAgents },
  { view: "machines", label: "Machines", icon: IconMachines },
  { view: "databox", label: "Databox", icon: IconDatabox },
];

const THEME_GLYPH: Record<ThemePref, string> = { system: "◐", light: "○", dark: "●" };

export function App() {
  const route = useRoute();
  const [drawerId, setDrawerId] = useState<TypedId | null>(null);
  const [search, setSearch] = useState("");
  const [project, setProjectState] = useState<string | null>(() => loadStoredProject().value);
  const [projects, setProjects] = useState<string[]>([]);
  const [theme, setTheme] = useTheme();
  const toastMsg = useToastChannel();
  const wide = useMedia("(min-width: 880px)");
  const version = useDataVersion();

  const healthQ = useAsync<HealthReport>(() => api.health(), [version]);
  const review = useReview(project);

  // Derive the known projects from recent sessions (recency-ordered). On first
  // ever load with no stored pick, auto-focus the most recent project.
  useEffect(() => {
    let live = true;
    api.sessions
      .list({ limit: 300 })
      .then((res: ListResult<Session>) => {
        if (!live) return;
        const seen: string[] = [];
        for (const s of res.data) {
          const p = s.project?.trim();
          if (p && !seen.includes(p)) seen.push(p);
        }
        setProjects(seen);
        const stored = loadStoredProject();
        if (!stored.explicit && seen[0]) setProject(seen[0]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setProject = (p: string | null) => {
    setProjectState(p);
    try {
      localStorage.setItem(PROJECT_KEY, p ?? ALL);
    } catch {
      /* ignore */
    }
  };

  const openRecord = (id: TypedId) => setDrawerId(id);

  const submitSearch = (e: Event) => {
    e.preventDefault();
    if (!search.trim()) return;
    routerNavigate("search", { q: search.trim() });
    setSearch("");
  };

  // Ensure the active project is always selectable even if it fell off the recent list.
  const projectOptions = project && !projects.includes(project) ? [project, ...projects] : projects;

  const appApi: AppApi = {
    navigate: routerNavigate,
    openRecord,
    params: route.params,
    health: healthQ.data,
    reloadHealth: healthQ.reload,
    project,
    setProject,
    projects,
    review,
  };

  // The tray flyout is its own tiny surface — no shell around it.
  if (route.view === "tray") {
    return (
      <AppContext.Provider value={appApi}>
        <TrayView />
        {drawerId && <RecordDrawer typedId={drawerId} onClose={() => setDrawerId(null)} />}
      </AppContext.Provider>
    );
  }

  const health = healthQ.data;
  const online = health ? health.ok : healthQ.error ? false : true;
  const cabinetLabel = health
    ? `${health.storage.location ?? "cabinet"} · ${health.storage.adapter}`
    : healthQ.error
      ? "service unreachable"
      : "…";

  const themeBtn = (
    <button
      class="btn btn-ghost btn-sm theme-btn"
      title={`Theme: ${theme} — click to change`}
      aria-label={`Theme: ${theme}`}
      onClick={() => setTheme(nextTheme(theme))}
    >
      <span aria-hidden="true">{THEME_GLYPH[theme]}</span>
      {wide && <span>{theme}</span>}
    </button>
  );

  const projectSwitch = (
    <label class="proj-switch" title="Scope the console to one project">
      <span class="proj-label">project</span>
      <select
        value={project ?? ALL}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          setProject(v === ALL ? null : v);
        }}
      >
        <option value={ALL}>All projects</option>
        {projectOptions.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <span class="proj-caret" aria-hidden="true">▾</span>
    </label>
  );

  const navButtons = NAV.map((n) => {
    const Icon = n.icon;
    const active = route.view === n.view;
    const badge = n.view === "review" && review.total > 0 ? review.total : null;
    return (
      <button
        key={n.view}
        class={`nav-btn${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={() => routerNavigate(n.view)}
      >
        <Icon />
        <span class="label">{n.label}</span>
        {badge !== null && <span class="nav-pill">{badge}</span>}
      </button>
    );
  });

  return (
    <AppContext.Provider value={appApi}>
      <div class={`shell${wide ? "" : " narrow"}`}>
        {wide && (
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
            <nav aria-label="Sections" style={{ display: "contents" }}>
              {navButtons}
            </nav>
            <div class="sidebar-foot">
              <div class="status-line">
                <span class={`status-dot${online ? "" : " down"}`} />
                {online ? "online · self-hosted" : "offline"}
              </div>
              <div class="status-meta" title={cabinetLabel}>{cabinetLabel}</div>
              <div style={{ marginTop: "0.5rem" }}>{themeBtn}</div>
            </div>
          </aside>
        )}

        <main class="main">
          <header class="topbar">
            {!wide && (
              <span class="brand-mark" aria-hidden="true" style={{ color: "var(--sage)" }}>
                <IconLogo />
              </span>
            )}
            {projectSwitch}
            <form class="searchbox" onSubmit={submitSearch}>
              <span class="prompt" aria-hidden="true">⌕</span>
              <input
                value={search}
                onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                placeholder="Search memory"
                aria-label="Search memory"
              />
              {wide && <span class="hint">↵ search</span>}
            </form>
            {!wide && <div class="topbar-actions">{themeBtn}</div>}
          </header>

          {!wide && (
            <nav class="nav-rail" aria-label="Sections">
              {navButtons}
            </nav>
          )}

          <EmbeddingsNotice onDetails={() => routerNavigate("machines")} />

          <div class="scroll" key={route.view}>
            {route.view === "home" && <HomeView />}
            {route.view === "review" && <ReviewView />}
            {route.view === "brief" && <BriefView />}
            {route.view === "search" && <SearchView />}
            {route.view === "agents" && <AgentsView />}
            {route.view === "machines" && <MachinesView />}
            {route.view === "databox" && <DataboxView />}
          </div>
        </main>

        {drawerId && <RecordDrawer typedId={drawerId} onClose={() => setDrawerId(null)} />}
        {toastMsg && <div class="toast">{toastMsg}</div>}
      </div>
    </AppContext.Provider>
  );
}
