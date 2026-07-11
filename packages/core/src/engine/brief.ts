import type {
  BriefOptions,
  BriefResult,
  Fact,
  RecallResult,
  Session,
} from "../contract.js";

const STARTUP_NOTE =
  "Lead from MOST RECENT WORK below. The FACTS BRAIN under it is curated standing knowledge — treat as authoritative.";

export function startupNote(): string {
  return STARTUP_NOTE;
}

/**
 * The scope set a brief loads facts from: an explicit `factScopes` override, or
 * the default `global` + `agent:<agent>` + `project:<project>` derivation. This
 * is what keeps off-agent scopes (e.g. another project's facts) out of startup.
 */
export function deriveFactScopes(opts: BriefOptions): string[] {
  if (opts.factScopes && opts.factScopes.length > 0) {
    return [...new Set(opts.factScopes)];
  }
  const scopes = ["global"];
  if (opts.agent) scopes.push(`agent:${opts.agent}`);
  if (opts.project) scopes.push(`project:${opts.project}`);
  return [...new Set(scopes)];
}

export interface BriefParts {
  recentSessions: Session[];
  facts: Fact[];
  relatedDocs: RecallResult[];
}

export function assembleBrief(parts: BriefParts, opts: BriefOptions): BriefResult {
  const result: BriefResult = {
    startupNote: STARTUP_NOTE,
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
