import type { JSX } from "preact";

type P = { size?: number | string };
const base = (size: number | string = "1.05rem"): JSX.SVGAttributes<SVGSVGElement> => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.6,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  style: { width: size, height: size, flex: "none" },
});

export const IconOverview = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.3" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.3" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.3" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.3" />
  </svg>
);
export const IconFacts = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.4L6 20V5a1 1 0 0 1 1-1z" />
  </svg>
);
export const IconSessions = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);
export const IconDocs = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 3h7l4 4v14H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4M9 12h6M9 16h4" />
  </svg>
);
export const IconBrief = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H17l2 2v14.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
  </svg>
);
export const IconRecall = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="6.4" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);
export const IconVision = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);
export const IconHealth = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3.5 12h4l2-5 3 10 2-5h6" />
  </svg>
);
export const IconLogo = ({ size = "100%" }: P) => (
  <svg {...base(size)} stroke-width={1.5}>
    <path d="M12 3 21 8l-9 5-9-5 9-5z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 16 9 5 9-5" />
  </svg>
);
export const IconPlus = ({ size = "0.85rem" }: P) => (
  <svg {...base(size)} stroke-width={2.2}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconClose = ({ size = "1rem" }: P) => (
  <svg {...base(size)} stroke-width={2}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
