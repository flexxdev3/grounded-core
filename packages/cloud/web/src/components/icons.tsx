// Line icons — 1.6 stroke, currentColor, no emoji. Brand mark is the sage
// hexagonal stacked-layers glyph shared with the site + console.
import type { JSX } from "preact";

type P = JSX.SVGAttributes<SVGSVGElement>;
const base = (p: P) => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.6,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  ...p,
});

export function Logo(p: P) {
  return (
    <svg {...base({ viewBox: "0 0 32 32", ...p })} fill="none">
      <circle cx="16" cy="12.5" r="5" stroke="var(--verdigris)" stroke-width="2.2" />
      <path d="M8.5 21.5h15" stroke="var(--verdigris)" stroke-width="2.2" stroke-linecap="round" />
      <path d="M10.5 25.5h11" stroke="var(--copper)" stroke-width="2.2" stroke-linecap="round" opacity="0.75" />
    </svg>
  );
}

export const IconDashboard = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);
export const IconConnect = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 8 4 12l4 4" />
    <path d="M16 8l4 4-4 4" />
    <path d="M13 6l-2 12" />
  </svg>
);
export const IconTokens = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h9" />
    <path d="M18 12v3" />
    <path d="M15 12v2" />
  </svg>
);
export const IconCabinet = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M9 13h6" />
    <path d="M9 17h3" />
  </svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
  </svg>
);
export const IconBilling = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M2.5 9.5h19" />
    <path d="M6 15h4" />
  </svg>
);
export const IconCopy = (p: P) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base({ width: 16, height: 16, ...p })}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
export const IconArrow = (p: P) => (
  <svg {...base({ width: 14, height: 14, ...p })}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconMenu = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
export const IconGithub = (p: P) => (
  <svg {...base({ ...p })} fill="currentColor" stroke="none">
    <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.85.09-.66.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
  </svg>
);
