/**
 * Strict integer parser for commander `.option(..., parseInteger)`.
 *
 * `Number.parseInt` TRUNCATES rather than rejecting: it reads "7437abc" as 7437
 * and "1.9" as 1. For a flag like `--port` that means the installer binds a port
 * the operator never typed, and says nothing. So the whole string must be a
 * complete, optionally-signed decimal integer — no trailing characters, no
 * decimal point, no whitespace padding — and the error names the likely typo.
 */
export function parseInteger(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    // If parseInt WOULD have silently accepted this, say what it would have
    // become — that is exactly the value the operator did not mean to type.
    const truncated = Number.parseInt(value, 10);
    const hint = Number.isNaN(truncated)
      ? " (expected a whole number, e.g. 7437)"
      : ` — Number.parseInt would silently read this as ${truncated}. ` +
        `Pass a whole number, with no trailing characters, decimal point or padding.`;
    throw new Error(`expected an integer, got "${value}"${hint}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `expected an integer, got "${value}" — out of range (max ${Number.MAX_SAFE_INTEGER})`,
    );
  }
  return n;
}

/**
 * Strict float parser. Same defect class as parseInteger: `Number.parseFloat`
 * reads "0.75xyz" as 0.75. `Number()` requires the whole string to be numeric,
 * but maps "" and whitespace to 0, so those are rejected explicitly. Infinity
 * and NaN are not usable option values either.
 */
export function parseFloatOpt(value: string): number {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`expected a number, got "${value}" (expected a decimal number, e.g. 0.75)`);
  }
  return n;
}

export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** commander reducer for repeatable `--env KEY=VAL` flags. */
export function parseEnvPair(
  value: string,
  acc: Record<string, string> = {},
): Record<string, string> {
  const i = value.indexOf("=");
  const key = i > 0 ? value.slice(0, i).trim() : "";
  if (!key) throw new Error(`expected KEY=VAL, got "${value}"`);
  return { ...acc, [key]: value.slice(i + 1) };
}

export function parseTypedId(value: string): import("@grounded/core").TypedId {
  const m = /^(fact|session|doc):(\d+)$/.exec(value);
  if (!m) throw new Error(`invalid typed id "${value}" (expected e.g. doc:12)`);
  return value as import("@grounded/core").TypedId;
}
