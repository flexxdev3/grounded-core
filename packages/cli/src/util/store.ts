import { loadConfig, openStore } from "@grounded/core";
import type { GroundedConfig, Store } from "@grounded/core";
import { GroundedError } from "@grounded/core";
import { fail } from "./output.js";

export interface GlobalOpts {
  home?: string;
  json?: boolean;
}

export function resolveConfig(opts: GlobalOpts): GroundedConfig {
  try {
    return loadConfig(opts.home ? { home: opts.home } : undefined);
  } catch (err) {
    return reportAndExit(err);
  }
}

export async function withStore<T>(
  opts: GlobalOpts,
  run: (store: Store, config: GroundedConfig) => Promise<T>,
): Promise<T> {
  const config = resolveConfig(opts);
  let store: Store;
  try {
    store = await openStore(config);
  } catch (err) {
    return reportAndExit(err);
  }
  try {
    return await run(store, config);
  } catch (err) {
    return reportAndExit(err);
  } finally {
    try {
      await store.close();
    } catch {
      // closing should never mask the primary result
    }
  }
}

function reportAndExit(err: unknown): never {
  if (err instanceof GroundedError) {
    return fail(`[${err.code}] ${err.message}`);
  }
  if (err instanceof Error) {
    return fail(err.message);
  }
  return fail(String(err));
}
