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

export function parseTypedId(value: string): import("@grounded/core").TypedId {
  const m = /^(fact|session|doc):(\d+)$/.exec(value);
  if (!m) throw new Error(`invalid typed id "${value}" (expected e.g. doc:12)`);
  return value as import("@grounded/core").TypedId;
}
