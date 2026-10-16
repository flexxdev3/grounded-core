import { DataboxError } from "./types.js";

/**
 * DuckDB is an optional payload (`grounded addon add databox`), loaded on first
 * use so a cabinet that never turns Databox on never loads a native module.
 */
export type Duck = typeof import("@duckdb/node-api");

let loading: Promise<Duck | null> | undefined;
let reason: string | undefined;

export function loadDuck(): Promise<Duck | null> {
  loading ??= import("@duckdb/node-api").then(
    (m) => m as Duck,
    (err: unknown) => {
      reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return null;
    },
  );
  return loading;
}

export async function requireDuck(): Promise<Duck> {
  const duck = await loadDuck();
  if (!duck) {
    throw new DataboxError(
      `Databox needs DuckDB, which is not installed (${reason ?? "@duckdb/node-api missing"}). Run \`grounded addon add databox\`.`,
      "DATABOX_UNAVAILABLE",
      503,
    );
  }
  return duck;
}

export async function duckHealth(): Promise<{ ok: boolean; detail: string }> {
  const duck = await loadDuck();
  if (!duck) return { ok: false, detail: "unavailable (duckdb not installed)" };
  return { ok: true, detail: `duckdb ${duck.version()}` };
}

/** A string literal for SQL: single quotes doubled. */
export function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** A quoted identifier. */
export function ident(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

/** Forward slashes: DuckDB globs and the prefix arithmetic in plan.ts both want them. */
export function slash(p: string): string {
  return p.replaceAll("\\", "/");
}
