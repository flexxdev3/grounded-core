import type { SourceType, TypedId } from "@grounded/core/contract";

/** "2026-06-24T01:04:…" -> "2026-06-24 01:04" */
export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

export function typeLabel(t: SourceType): string {
  return t === "fact" ? "fact" : t === "session" ? "sess" : "doc";
}

export function parseTypedId(id: TypedId): { type: SourceType; num: number } {
  const [type, num] = id.split(":") as [SourceType, string];
  return { type, num: Number(num) };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
