/**
 * @grounded/databox — the optional Databox addition.
 *
 * A box is a folder: an extractor (any language, outside Grounded) writes
 * `items/**.json`, the canonical data. Databox derives a DuckDB index beside
 * it and answers read-only SQL; with no index it reads the JSON directly.
 * Rows never enter Grounded's memory lanes; a box reaches recall only through
 * its schema card (renderSchemaCard), ingested into the docs lane.
 */
export { Databox, validateBoxes, type DataboxOptions } from "./databox.js";
export { renderSchemaCard } from "./card.js";
export { writeDataboxConfig } from "./config.js";
export { duckHealth } from "./duck.js";
export { scanItems } from "./items.js";
export {
  DataboxError,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MAX_MS,
  type BoxConfig,
  type BoxSchema,
  type BoxState,
  type BoxStatus,
  type ColumnInfo,
  type IndexPointer,
  type QueryMeta,
  type QueryOptions,
  type QueryResult,
  type TableInfo,
} from "./types.js";
