import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cabinetDir } from "@grounded/core";
import type { GroundedConfig, Store } from "@grounded/core/contract";
import { Databox, renderSchemaCard } from "@grounded/databox";

/**
 * The service's Databox: the ONE writer (builds indexes, refreshes stale boxes)
 * and the only process that delivers schema cards. Each card is a markdown file
 * in `<cabinet>/databox/<box>.md`, ingested into the docs lane, so recall can
 * route "which cars use X" to the box. Rows never leave the box.
 */
export function createServiceDatabox(config: GroundedConfig, store: Store): Databox | undefined {
  if (!config.databox?.enabled) return undefined;
  const cardsDir = join(cabinetDir(config.home), "databox");
  const db = new Databox({
    boxes: config.databox.box,
    writer: true,
    log: (m) => console.log(m),
    onIndexed: async (box, schema, pointer) => {
      mkdirSync(cardsDir, { recursive: true });
      const path = join(cardsDir, `${box.name}.md`);
      const card = renderSchemaCard(schema, { files: pointer.files });
      if (!existsSync(path) || readFileSync(path, "utf8") !== card) writeFileSync(path, card, "utf8");
      // always ingest: unchanged chunks are skipped, and a cabinet that lost the doc gets it back.
      await store.docsIngest([path], { source: "databox", kind: "databox-schema", scope: "global" });
    },
  });
  db.start();
  return db;
}
