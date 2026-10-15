import { useEffect, useState } from "preact/hooks";

/** Theme preference: follow the OS, or force light/dark. Persisted per browser. */
export type ThemePref = "system" | "light" | "dark";

const KEY = "grounded.theme";

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

/** Reflect the preference onto <html data-theme>; "system" removes the attribute
 * so the prefers-color-scheme block in tokens.css decides. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadTheme);
  useEffect(() => {
    applyTheme(pref);
  }, [pref]);
  const set = (p: ThemePref) => {
    setPref(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  };
  return [pref, set];
}

/** The next preference in the footer toggle cycle. */
export function nextTheme(pref: ThemePref): ThemePref {
  return pref === "system" ? "light" : pref === "light" ? "dark" : "system";
}
