import { useEffect, useState } from "preact/hooks";

/** The console's screens. One screen = one job; no sub-navigation. */
export const VIEWS = ["home", "review", "brief", "search", "agents", "machines", "databox", "tray"] as const;
export type View = (typeof VIEWS)[number];

export interface Route {
  view: View;
  params: URLSearchParams;
}

/** Parse a location hash like "#/review?tab=sessions". Unknown or empty → home. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const name = (q === -1 ? raw : raw.slice(0, q)).toLowerCase();
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  const view = (VIEWS as readonly string[]).includes(name) ? (name as View) : "home";
  return { view, params };
}

/** Build the hash for a route. */
export function routeHash(view: View, params?: Record<string, string>): string {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "")).toString() : "";
  return `#/${view}${qs ? `?${qs}` : ""}`;
}

export function navigate(view: View, params?: Record<string, string>): void {
  location.hash = routeHash(view, params);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
