/**
 * Minimal interactive prompts over node:readline/promises — zero deps.
 * Non-TTY / piped input auto-selects the default so scripted installs don't hang.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { c, line } from "./output.js";

export const interactive = Boolean(stdin.isTTY && stdout.isTTY);

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  /** disabled choices are shown greyed and cannot be picked. */
  disabled?: string;
}

/** Single-select menu. Returns the chosen value; defaults to `defaultIndex` when non-interactive. */
export async function select<T>(
  title: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  const enabled = choices.filter((ch) => !ch.disabled);
  if (enabled.length === 0) throw new Error("no available options");

  line(c.bold(title));
  choices.forEach((ch, i) => {
    const n = c.cyan(`${i + 1}`);
    if (ch.disabled) {
      line(`  ${c.dim(`${i + 1}. ${ch.label} — ${ch.disabled}`)}`);
    } else {
      const hint = ch.hint ? c.dim(`  — ${ch.hint}`) : "";
      const def = i === defaultIndex ? c.dim(" (default)") : "";
      line(`  ${n}. ${ch.label}${def}${hint}`);
    }
  });

  const def = choices[defaultIndex];
  const fallback = def && !def.disabled ? def.value : enabled[0]!.value;
  if (!interactive) return fallback;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question(c.dim(`> choose 1-${choices.length} [${defaultIndex + 1}]: `))).trim();
      if (answer === "") return fallback;
      const idx = Number(answer) - 1;
      const ch = choices[idx];
      if (!ch) {
        line(c.yellow(`  enter a number 1-${choices.length}`));
        continue;
      }
      if (ch.disabled) {
        line(c.yellow(`  that option is unavailable: ${ch.disabled}`));
        continue;
      }
      return ch.value;
    }
  } finally {
    rl.close();
  }
}

/** Yes/no. Non-interactive returns `def`. */
export async function confirm(question: string, def = true): Promise<boolean> {
  if (!interactive) return def;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await rl.question(`${question} ${c.dim(`[${hint}]`)} `)).trim().toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
