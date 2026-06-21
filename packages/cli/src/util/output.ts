import pc from "picocolors";

export const isTTY = Boolean(process.stdout.isTTY);

function plain(s: string): string {
  return s;
}

const color = isTTY
  ? {
      bold: pc.bold,
      dim: pc.dim,
      green: pc.green,
      red: pc.red,
      yellow: pc.yellow,
      cyan: pc.cyan,
      magenta: pc.magenta,
    }
  : {
      bold: plain,
      dim: plain,
      green: plain,
      red: plain,
      yellow: plain,
      cyan: plain,
      magenta: plain,
    };

export const c = color;

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

export function header(s: string): void {
  line(c.bold(s));
}

export function field(label: string, value: string): void {
  line(`${c.dim(label.padEnd(12))} ${value}`);
}

export function ok(b: boolean): string {
  return b ? c.green("ok") : c.red("fail");
}

export function fail(message: string): never {
  process.stderr.write(c.red(`error: ${message}`) + "\n");
  process.exit(1);
}

export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}
