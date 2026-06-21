import { Command } from "commander";
import type { Fact, FactInput, ListOptions } from "@grounded/core";
import type { GlobalOpts } from "../util/store.js";
import { withStore } from "../util/store.js";
import { c, line, printJson, header, truncate } from "../util/output.js";
import { parseFloatOpt, parseInteger } from "../util/parse.js";

interface AddOpts {
  scope?: string;
  category?: string;
  detail?: string;
  topicKey?: string;
  pin?: boolean;
  importance?: number;
}

function buildInput(text: string, opts: AddOpts): FactInput {
  const input: FactInput = { fact: text };
  if (opts.scope) input.scope = opts.scope;
  if (opts.category) input.category = opts.category;
  if (opts.detail) input.detail = opts.detail;
  if (opts.topicKey) input.topicKey = opts.topicKey;
  if (opts.pin) input.pinned = true;
  if (opts.importance !== undefined) input.importance = opts.importance;
  return input;
}

function printFact(f: Fact): void {
  const pin = f.pinned ? c.yellow("★ ") : "";
  const meta = c.dim(
    `fact:${f.id} · ${f.scope} · ${f.category}${f.importance ? ` · imp ${f.importance}` : ""}${
      f.status !== "active" ? ` · ${f.status}` : ""
    }`,
  );
  line(`${pin}${f.fact}`);
  line(`  ${meta}`);
  if (f.detail) line(`  ${c.dim(truncate(f.detail, 100))}`);
}

export function factsCommand(global: () => GlobalOpts): Command {
  const cmd = new Command("facts").description("durable hard rules / operator truths");

  cmd
    .command("add")
    .description("add a fact")
    .argument("<text>", "the rule (sharp one-liner)")
    .option("--scope <scope>", "global | project:<name> | agent:<name>")
    .option("--category <category>", "free-form bucket")
    .option("--detail <detail>", "elaboration / when-to-apply")
    .option("--topic-key <key>", "stable dedupe/supersede key")
    .option("--pin", "pin this fact")
    .option("--importance <n>", "ranking boost 0..1", parseFloatOpt)
    .action(async (text: string, opts: AddOpts) => {
      const g = global();
      await withStore(g, async (store) => {
        const f = await store.factsAdd(buildInput(text, opts));
        if (g.json) return printJson(f);
        line(c.green(`added fact:${f.id}`));
        printFact(f);
      });
    });

  cmd
    .command("list")
    .description("list facts")
    .option("--scope <scope>", "filter by scope")
    .option("--limit <n>", "max results", parseInteger)
    .action(async (opts: { scope?: string; limit?: number }) => {
      const g = global();
      await withStore(g, async (store) => {
        const lo: ListOptions = {};
        if (opts.scope) lo.scope = opts.scope;
        if (opts.limit !== undefined) lo.limit = opts.limit;
        const facts = await store.factsList(lo);
        if (g.json) return printJson(facts);
        if (facts.length === 0) return line(c.dim("no facts"));
        header(`${facts.length} fact(s)`);
        for (const f of facts) printFact(f);
      });
    });

  cmd
    .command("delete")
    .description("delete a fact")
    .argument("<id>", "fact id", parseInteger)
    .action(async (id: number) => {
      const g = global();
      await withStore(g, async (store) => {
        const removed = await store.factsDelete(id);
        if (g.json) return printJson({ id, removed });
        line(removed ? c.green(`deleted fact:${id}`) : c.yellow(`no fact:${id}`));
      });
    });

  cmd
    .command("supersede")
    .description("supersede an old fact with a new one")
    .argument("<oldId>", "fact id to supersede", parseInteger)
    .argument("<text>", "replacement rule")
    .option("--scope <scope>")
    .option("--category <category>")
    .option("--detail <detail>")
    .option("--topic-key <key>")
    .option("--pin")
    .option("--importance <n>", "0..1", parseFloatOpt)
    .action(async (oldId: number, text: string, opts: AddOpts) => {
      const g = global();
      await withStore(g, async (store) => {
        const f = await store.factsSupersede(oldId, buildInput(text, opts));
        if (g.json) return printJson(f);
        line(c.green(`fact:${oldId} → fact:${f.id}`));
        printFact(f);
      });
    });

  return cmd;
}
