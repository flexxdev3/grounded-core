/**
 * The add-on catalog: what Companion's Add-ons page and `GET /addons` list.
 * Runtime packages are pinned to the versions the workspace builds and tests
 * against (core/databox optionalDependencies) — bump them together.
 */
export type AddonId = "embeddings" | "databox";

export interface AddonRuntimePackage {
  name: string;
  version: string;
}

export interface AddonDefinition {
  id: AddonId;
  name: string;
  /** one line for the card. */
  summary: string;
  /** a short paragraph for the detail view. */
  description: string;
  /** npm packages installed into `<home>/addons/<id>/` (natives, not bundled with Core). */
  runtime: AddonRuntimePackage[];
  /** approximate runtime download, bytes (a model download is reported separately). */
  runtimeBytes: number;
  /** `${process.platform}-${process.arch}` values the runtime ships prebuilt binaries for. */
  platforms: string[];
}

export const ADDON_CATALOG: readonly AddonDefinition[] = [
  {
    id: "embeddings",
    name: "Search by meaning",
    summary: "Find memories by what they mean, not only the words they use.",
    description:
      "Downloads a small local embedding model and turns on semantic recall. Runs on this computer: on the graphics card " +
      "when one is usable (Windows), otherwise on the CPU. Existing memories are embedded in the background.",
    runtime: [
      { name: "onnxruntime-node", version: "1.30.0" },
      { name: "@huggingface/tokenizers", version: "0.2.0" },
    ],
    runtimeBytes: 75_000_000,
    platforms: ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"],
  },
  {
    id: "databox",
    name: "Databox",
    summary: "Structured data handling and recall.",
    description:
      "Point Grounded at folders of structured items (JSON) and agents can query them with SQL. Rows stay in their box; " +
      "recall finds the right box through its schema card. Uses DuckDB on this computer.",
    runtime: [{ name: "@duckdb/node-api", version: "1.5.6-r.1" }],
    runtimeBytes: 40_000_000,
    platforms: ["win32-x64", "linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"],
  },
];

export function addonDefinition(id: string): AddonDefinition | undefined {
  return ADDON_CATALOG.find((a) => a.id === id);
}

export function addonSupported(def: AddonDefinition, platform: string = process.platform, arch: string = process.arch): boolean {
  return def.platforms.includes(`${platform}-${arch}`);
}
