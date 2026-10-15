import { IconDatabox } from "../icons.js";

/** Databox — preview card. The add-on itself ships later. */
export function DataboxView() {
  return (
    <div class="view-max">
      <h1 class="h-serif display">
        Databox <span class="preview-pill">Preview</span>
      </h1>
      <p class="lede">Structured data your tools collect — catalogs, inventories, extracts — queryable by your agents next to everything else they remember.</p>

      <div class="card" style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        <span style={{ color: "var(--sage)", marginTop: "0.1rem" }}>
          <IconDatabox size="1.6rem" />
        </span>
        <div style={{ lineHeight: 1.55 }}>
          <div style={{ fontWeight: 500, marginBottom: "0.3rem" }}>Coming soon</div>
          <div style={{ color: "var(--ink-soft)" }}>
            Point Grounded at a folder of structured items. It builds an index, hands your agents a
            schema card, and answers their queries directly — search stays in one place.
          </div>
        </div>
      </div>
    </div>
  );
}
