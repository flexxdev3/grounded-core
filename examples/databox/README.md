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
- Rewrite a file only when its content changes: the index rebuilds on any size/mtime change.
- Items over 16 MB are refused; split them.
- Optional `manifest.json` at the box root: its top-level scalars (e.g. a source build number)
  show in the console, the schema card and `GET /databox`. Cite them with your conclusions.
