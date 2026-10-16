# Databox examples

A **box** is a folder. An extractor (any language) writes `items/**.json`, one JSON object per item.
Grounded indexes it and answers read-only SQL. Grounded never decodes your formats: the extractor does.

## npm-packages — a box you can build on any machine

Catalogues every npm package under a `node_modules` folder (Grounded's own install has ~300).

```bash
node examples/databox/npm-packages/extract.mjs node_modules ~/boxes/npm
grounded addon add databox --box npm=~/boxes/npm --description "npm packages installed with Grounded"
```

Tables: `packages.items` (one row per package), `packages.dependencies`, `packages.files`.

```sql
-- which packages pull in a native install script?
select name, version from packages.items where has_install_script order by name;

-- most-depended-on packages
select d.name, count(*) dependents from packages.dependencies d where kind = 'prod'
group by 1 order by 2 desc limit 10;

-- licence mix
select license, count(*) n from packages.items group by 1 order by 2 desc;
```

## Writing your own extractor

- One object per file. Folder under `items/` = table schema (`items/cars/*.json` -> `cars.items`, `cars.<array>`).
- Use arrays of objects for repeated things, not objects keyed by id: arrays become tables,
  keyed objects become one wide struct.
- Write only what the source states. A missing value is a finding; don't fill it with a default.
- Rewrite a file only when its content changes: any size/mtime change re-reads that item.
  Builds are incremental: only changed items are re-read (FH6 catalogue: 1 car 0.5 s vs 36 s full).
  A changed item that adds a key or widens a type (BIGINT -> DOUBLE) triggers a full build,
  and so do >25% of items changing or the index growing 25% past its last full build.
  A column only removed items used stays (all NULL) until the next full build (`force`).
- Items over 16 MB are refused; split them.
- Optional `manifest.json` at the box root: its top-level scalars (e.g. a source build number)
  show in the console, the schema card and `GET /databox`. Cite them with your conclusions.
- Declare types JSON cannot carry in `manifest.json` -> `"databox": {"types": {"<table>.<column>": "<DuckDB type>"}}`,
  `<table>` as `/schema` names it. The case it exists for: float32 source values. JSON numbers infer
  DOUBLE; `"cars.parts_meshes_uv.transform": "FLOAT[4]"` stores them at their real precision
  (FH6 catalogue 291 -> 251 MB, no build-time cost) and queries print them as written
  (`0.011410641`). Only for values that WERE float32: a computed double loses digits.
  A hint naming no column fails the build; changing hints forces a full build.
