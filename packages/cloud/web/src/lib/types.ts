// Shapes mirrored from @grounded/cloud backend (src/account.ts, src/tokens.ts) and
// @grounded/core HealthReport. Kept local so the UI has no build-time coupling to
// the private cloud package internals — only the wire contract.

export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface Cabinet {
  id: string;
  plan: string;
  status: string;
  shard: string | null;
}

export interface HealthReport {
  ok: boolean;
  storage: { adapter: string; ok: boolean; detail?: string; location?: string };
  embeddings: { provider: string; ok: boolean; dims: number; detail?: string; model?: string };
  counts: { facts: number; sessions: number; docs: number; documents: number };
}

export interface CabinetStatus {
  cabinet: Cabinet;
  endpoint: string;
  health: HealthReport;
}

export interface ApiToken {
  id: string;
  cabinetId: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export type ConnectSnippets = Record<"hook" | "curl" | "client", string>;

export interface IssuedToken {
  token: ApiToken;
  secret: string;
  connect: ConnectSnippets;
}

export interface ConnectPayload {
  endpoint: string;
  snippets: ConnectSnippets;
}

export interface Me {
  user: User;
  cabinet: Cabinet | null;
}
