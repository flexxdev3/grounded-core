export function parseInteger(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got "${value}"`);
  return n;
}

export function parseFloatOpt(value: string): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) throw new Error(`expected a number, got "${value}"`);
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
