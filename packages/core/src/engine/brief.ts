import type {
  BriefOptions,
  BriefResult,
  Fact,
  RecallResult,
  Session,
  Vision,
} from "../contract.js";

const STARTUP_NOTE =
  "Lead from MOST RECENT WORK below. The FACTS BRAIN under it is curated standing knowledge — treat as authoritative.";

export function startupNote(): string {
  return STARTUP_NOTE;
}

/**
 * The scope set a brief loads facts from: an explicit `factScopes` override, or
 * the default `global` + `agent:<agent>` + `project:<project>` + `machine:<machine>`
 * derivation. This is what keeps off-agent/off-machine scopes (e.g. another project's
 * or another box's facts) out of startup — a fact scoped `machine:arch1` only surfaces
 * on arch1.
 */
export function deriveFactScopes(opts: BriefOptions): string[] {
  if (opts.factScopes && opts.factScopes.length > 0) {
    return [...new Set(opts.factScopes)];
  }
  const scopes = ["global"];
  if (opts.agent) scopes.push(`agent:${opts.agent}`);
  if (opts.project) scopes.push(`project:${opts.project}`);
  if (opts.machine) scopes.push(`machine:${opts.machine}`);
  return [...new Set(scopes)];
}

/** The fixed line that makes vision applied, not just present. */
const VISION_APPLY_NOTE =
  "Apply this: flag any plan, play, or design that conflicts with the vision before executing it.";

export interface BriefParts {
  vision?: { global: Vision | null; project: Vision | null };
  recentSessions: Session[];
  facts: Fact[];
  relatedDocs: RecallResult[];
}

export function assembleBrief(parts: BriefParts, opts: BriefOptions): BriefResult {
  const result: BriefResult = {
    startupNote: STARTUP_NOTE,
    vision: parts.vision ?? { global: null, project: null },
    recentSessions: parts.recentSessions,
    facts: parts.facts,
    relatedDocs: parts.relatedDocs,
  };
  if (opts.format !== "json") {
    result.text = renderMarkdown(result, opts);
  }
  return result;
}

function factsScopeLabel(opts: BriefOptions): string {
  return deriveFactScopes(opts).join(" + ");
}

export function renderMarkdown(brief: BriefResult, opts: BriefOptions): string {
  const lines: string[] = [];
  lines.push("=== STARTUP CONTEXT ===");
  lines.push(brief.startupNote);
  lines.push("");

  // Vision: always injected when set, omitted entirely when empty.
  const gv = brief.vision?.global ?? null;
  const pv = brief.vision?.project ?? null;
  if (gv || pv) {
    const scopeBits = [gv ? "global" : null, pv ? pv.scope : null].filter(Boolean);
    lines.push(`=== VISION (${scopeBits.join(" · ")}) ===`);
    if (gv) lines.push(gv.content.trim());
    if (pv) {
      if (gv) lines.push(`--- ${pv.scope} ---`);
      lines.push(pv.content.trim());
    }
    lines.push(VISION_APPLY_NOTE);
    lines.push("");
  }

  lines.push("=== MOST RECENT WORK (newest first) ===");
  if (brief.recentSessions.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of brief.recentSessions) {
      const when = s.createdAt ? s.createdAt.slice(0, 10) : "";
      const proj = s.project ? ` [${s.project}]` : "";
      lines.push(`- ${when}${proj} ${s.summary} (session:${s.id})`);
    }
  }
  lines.push("");

  lines.push(`=== FACTS BRAIN (curated · scope: ${factsScopeLabel(opts)}) ===`);
  if (brief.facts.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of brief.facts) {
      const pin = f.pinned ? "* " : "- ";
      lines.push(`${pin}${f.fact} (fact:${f.id})`);
    }
  }

  if (brief.relatedDocs.length > 0) {
    lines.push("");
    lines.push("=== RELATED DOCS ===");
    for (const d of brief.relatedDocs) {
      lines.push(`- ${d.title} (${d.citation})`);
    }
  }

  return lines.join("\n");
}
