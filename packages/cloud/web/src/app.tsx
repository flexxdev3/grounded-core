import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { account, auth } from "./lib/api.js";
import type { Me } from "./lib/types.js";
import { ToastHost } from "./components/ui.js";
import {
  Logo,
  IconBilling,
  IconCabinet,
  IconConnect,
  IconDashboard,
  IconMenu,
  IconSettings,
  IconTokens,
} from "./components/icons.js";
import { Auth } from "./surfaces/Auth.js";
import { Onboarding } from "./surfaces/Onboarding.js";
import { Dashboard } from "./surfaces/Dashboard.js";
import { Connect } from "./surfaces/Connect.js";
import { Tokens } from "./surfaces/Tokens.js";
import { Cabinet } from "./surfaces/Cabinet.js";
import { Settings } from "./surfaces/Settings.js";
import { Billing } from "./surfaces/Billing.js";

export type Route = "dashboard" | "connect" | "tokens" | "cabinet" | "settings" | "billing";

interface SessionCtx {
  me: Me;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<SessionCtx | null>(null);
export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside provider");
  return c;
}

const NAV: { route: Route; label: string; icon: typeof IconDashboard; group: "cabinet" | "account" }[] = [
  { route: "dashboard", label: "Dashboard", icon: IconDashboard, group: "cabinet" },
  { route: "connect", label: "Connect", icon: IconConnect, group: "cabinet" },
  { route: "cabinet", label: "Cabinet", icon: IconCabinet, group: "cabinet" },
  { route: "tokens", label: "API tokens", icon: IconTokens, group: "account" },
  { route: "settings", label: "Settings", icon: IconSettings, group: "account" },
  { route: "billing", label: "Billing", icon: IconBilling, group: "account" },
];

function routeFromHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const known = NAV.map((n) => n.route);
  return (known.includes(h as Route) ? h : "dashboard") as Route;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const s = await auth.session();
    setMe(s);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div class="center-note">
        <span class="spinner" />
        <span class="mono dim">connecting…</span>
      </div>
    );
  }

  if (!me) return <Auth onAuthed={load} />;
  if (!me.cabinet) return <Onboarding onDone={load} email={me.user.email} />;

  const ctx: SessionCtx = {
    me,
    refresh: load,
    signOut: async () => {
      await auth.signOut();
      location.hash = "";
      await load();
    },
  };
  return (
    <Ctx.Provider value={ctx}>
      <Shell />
    </Ctx.Provider>
  );
}

function Shell() {
  const { me, signOut } = useSession();
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (r: Route) => {
    location.hash = `/${r}`;
    setNavOpen(false);
  };

  const active = NAV.find((n) => n.route === route)!;
  const initial = (me.user.name ?? me.user.email)[0]?.toUpperCase() ?? "•";

  return (
    <div class="shell">
      {navOpen && <div class="scrim" onClick={() => setNavOpen(false)} />}
      <aside class={`sidebar${navOpen ? " open" : ""}`}>
        <div class="brandmark">
          <Logo />
          <span class="wordmark">Grounded</span>
          <span class="cloud">cloud</span>
        </div>
        {(["cabinet", "account"] as const).map((group) => (
          <div key={group} style={{ display: "contents" }}>
            <div class={`nav-group${group === "account" ? " spaced" : ""}`}>{group === "cabinet" ? "Cabinet" : "Account"}</div>
            {NAV.filter((n) => n.group === group).map((n) => {
              const Icon = n.icon;
              return (
                <button key={n.route} class={`nav-btn${route === n.route ? " active" : ""}`} onClick={() => go(n.route)}>
                  <Icon />
                  <span class="label">{n.label}</span>
                </button>
              );
            })}
          </div>
        ))}
        <div class="sidebar-foot">
          <div class="status-strip">
            <span class="status-dot" />
            online · ovh-gra
          </div>
          <div class="status-meta">{me.user.email}</div>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button class="menu-btn" onClick={() => setNavOpen(true)} aria-label="Menu">
            <IconMenu />
          </button>
          <span class="crumb">
            <span class="prompt">&gt;_</span> grounded / {active.label.toLowerCase()}
          </span>
          <span class="spacer" />
          <button class="usermenu" onClick={signOut} title="Sign out">
            <span class="avatar">{initial}</span>
            <span>sign out</span>
          </button>
        </header>
        <div class="scroll">
          {route === "dashboard" && <Dashboard onGo={go} />}
          {route === "connect" && <Connect />}
          {route === "tokens" && <Tokens />}
          {route === "cabinet" && <Cabinet />}
          {route === "settings" && <Settings />}
          {route === "billing" && <Billing />}
        </div>
      </div>
      <ToastHost />
    </div>
  );
}
