import type { VNode } from "preact";

/**
 * Light, dependency-free markdown renderer. Parses a useful subset to Preact
 * vnodes (never raw HTML), so it's XSS-safe by construction and adds ~0 weight.
 * Supported: headings, bold/italic, inline code, fenced code, blockquotes,
 * unordered/ordered lists, horizontal rules, links, paragraphs.
 */
export function Markdown({ source }: { source: string }): VNode {
  return <div class="md">{parseBlocks(source ?? "")}</div>;
}

type Child = VNode | string;

/** Safe capture-group read (regex groups are string|undefined under strict TS). */
const g = (m: RegExpExecArray, i: number): string => m[i] ?? "";

// ── inline ────────────────────────────────────────────────────────────────
const INLINE: { re: RegExp; render: (m: RegExpExecArray, k: number) => VNode }[] = [
  { re: /`([^`]+)`/, render: (m, k) => <code key={k} class="md-code">{g(m, 1)}</code> },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    render: (m, k) => (
      <a key={k} href={g(m, 2)} target="_blank" rel="noreferrer noopener">{renderInline(g(m, 1))}</a>
    ),
  },
  { re: /\*\*([^*]+)\*\*/, render: (m, k) => <strong key={k}>{renderInline(g(m, 1))}</strong> },
  { re: /__([^_]+)__/, render: (m, k) => <strong key={k}>{renderInline(g(m, 1))}</strong> },
  { re: /\*([^*]+)\*/, render: (m, k) => <em key={k}>{renderInline(g(m, 1))}</em> },
  { re: /_([^_]+)_/, render: (m, k) => <em key={k}>{renderInline(g(m, 1))}</em> },
];

function renderInline(text: string): Child[] {
  const out: Child[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    let best: { p: (typeof INLINE)[number]; m: RegExpExecArray } | null = null;
    for (const p of INLINE) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { p, m };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(best.p.render(best.m, key++));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

// ── blocks ────────────────────────────────────────────────────────────────
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(?:---|\*\*\*|___)\s*$/;
const QUOTE = /^>\s?(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+\.\s+(.*)$/;
const FENCE = /^```/;

function parseBlocks(src: string): VNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: VNode[] = [];
  let i = 0;
  let key = 0;
  const at = (n: number): string => lines[n] ?? "";

  while (i < lines.length) {
    const line = at(i);

    if (line.trim() === "") { i++; continue; }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(at(i))) body.push(at(i++));
      i++; // closing fence
      blocks.push(<pre key={key++} class="md-pre"><code>{body.join("\n")}</code></pre>);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = g(h, 1).length;
      // heading level demoted by one so page <h1> stays unique; drawer bodies start at h2
      const Tag = `h${Math.min(level + 1, 6)}` as unknown as "h2";
      blocks.push(<Tag key={key++} class="md-h">{renderInline(g(h, 2))}</Tag>);
      i++;
      continue;
    }

    if (HR.test(line)) { blocks.push(<hr key={key++} class="md-hr" />); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) {
        const m = QUOTE.exec(at(i));
        if (m) body.push(g(m, 1));
        i++;
      }
      blocks.push(<blockquote key={key++} class="md-quote">{renderInline(body.join(" "))}</blockquote>);
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line) && !UL.test(line);
      const items: Child[][] = [];
      while (i < lines.length && (UL.test(at(i)) || OL.test(at(i)))) {
        const m = UL.exec(at(i)) ?? OL.exec(at(i));
        if (m) items.push(renderInline(g(m, 1)));
        i++;
      }
      const lis = items.map((it, k) => <li key={k}>{it}</li>);
      blocks.push(ordered
        ? <ol key={key++} class="md-list">{lis}</ol>
        : <ul key={key++} class="md-list">{lis}</ul>);
      continue;
    }

    // paragraph: gather until blank line or a block-starting line
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() !== "" &&
      !FENCE.test(at(i)) &&
      !HEADING.test(at(i)) &&
      !HR.test(at(i)) &&
      !QUOTE.test(at(i)) &&
      !UL.test(at(i)) &&
      !OL.test(at(i))
    ) {
      para.push(at(i++));
    }
    blocks.push(<p key={key++} class="md-p">{renderInline(para.join(" "))}</p>);
  }

  return blocks;
}
