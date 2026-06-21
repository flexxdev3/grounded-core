# Welcome to Grounded

Grounded is self-hosted continuity for multi-agent workspaces. This file is a fixture used by tests
and the quick-start demo.

## What it remembers
- **facts** — durable hard rules, e.g. "never push without explicit instruction".
- **sessions** — what happened recently, a chronological work log.
- **docs** — indexed markdown and notes like this one.

## How recall works
Recall fuses a vector lane and a lexical lane with Reciprocal Rank Fusion, then boosts facts and recent
sessions. It works offline with lexical-only search when no embedding provider is configured.

<private>
This block should be stripped during ingest when stripPrivate is enabled. It must never appear in recall.
</private>
