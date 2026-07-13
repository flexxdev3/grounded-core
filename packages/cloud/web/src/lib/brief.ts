// The brief-as-hero content — a real SessionStart brief, in the Grounded voice
// (MESSAGING.md: "premium with dry wit"). Shown as the auth hero, the onboarding
// "you're live" proof, and echoed on the dashboard. This is the product's whole
// pitch in one panel: a cold agent that wakes up already oriented.
import type { BriefLine } from "../components/ui.js";

export const HERO_BRIEF: BriefLine[] = [
  { kind: "rule", text: "=== STARTUP CONTEXT ===" },
  { kind: "blank" },
  { kind: "head", text: "MOST RECENT WORK" },
  { kind: "kv", key: "2 days ago", value: "shipped hosted cabinets — schema-per-tenant isolation" },
  { kind: "kv", key: "5 days ago", value: "vision lane: Global + Project direction, injected into every brief" },
  { kind: "blank" },
  { kind: "head", text: "WHERE THINGS STAND" },
  { kind: "text", text: "128 facts · 341 sessions · 96 docs indexed · cited, inspectable" },
  { kind: "blank" },
  { kind: "head", text: "WHAT'S NEXT" },
  { kind: "text", text: "wire the account UI to the live gateway; verify at 375 + 1440" },
];

export function cabinetBrief(counts: { facts: number; sessions: number; documents: number }): BriefLine[] {
  return [
    { kind: "rule", text: "=== STARTUP CONTEXT ===" },
    { kind: "blank" },
    { kind: "head", text: "YOUR CABINET" },
    { kind: "kv", key: "facts", value: `${counts.facts} · explicit, pinned, scoped` },
    { kind: "kv", key: "sessions", value: `${counts.sessions} · what shipped, what broke, what you decided` },
    { kind: "kv", key: "docs", value: `${counts.documents} indexed · every result cited` },
    { kind: "blank" },
    { kind: "text", text: "Any agent, any repo, any machine — already knowing the work." },
  ];
}
