// Fixture backend — lets every surface render + verify without a live gateway
// (no Postgres / better-auth / ollama needed for the design loop). Enabled by
// VITE_MOCK=1 or a `?mock` query flag. Scenarios via the flag value:
//   ?mock        → signed in, cabinet provisioned (Dashboard/Connect/Tokens/Settings)
//   ?mock=fresh  → signed in, NO cabinet yet (Onboarding "you're live" moment)
//   ?mock=out    → signed out (Auth)
import type {
  ApiToken,
  Cabinet,
  CabinetStatus,
  ConnectPayload,
  ConnectSnippets,
  IssuedToken,
  Me,
} from "./types.js";

export const MOCK =
  import.meta.env.VITE_MOCK === "1" ||
  (typeof location !== "undefined" && new URLSearchParams(location.search).has("mock"));

function scenario(): string {
  if (typeof location === "undefined") return "";
  return new URLSearchParams(location.search).get("mock") ?? "";
}

const ENDPOINT = "https://cloud.grounded.dev/api";

function snippets(token: string): ConnectSnippets {
  return {
    hook: [
      "# SessionStart hook — startup brief from your hosted Grounded cabinet",
      `export GROUNDED_URL="${ENDPOINT}"`,
      `export GROUNDED_TOKEN="${token}"`,
      'curl -s -H "Authorization: Bearer $GROUNDED_TOKEN" \\',
      '  -X POST "$GROUNDED_URL/brief" -H \'content-type: application/json\' \\',
      `  -d '{"format":"markdown"}' | jq -r '.text'`,
    ].join("\n"),
    curl: [
      "# Recall from your cabinet",
      `curl -s -H "Authorization: Bearer ${token}" \\`,
      `  -X POST "${ENDPOINT}/recall" -H 'content-type: application/json' \\`,
      `  -d '{"query":"what did we decide about auth"}'`,
    ].join("\n"),
    client: [
      'import { createClient } from "@grounded/client";',
      "const grounded = createClient({",
      `  baseUrl: "${ENDPOINT}",`,
      `  token: "${token}",`,
      "});",
      "await grounded.brief({ format: \"markdown\" });",
    ].join("\n"),
  };
}

const CABINET: Cabinet = { id: "cab_7f3a91", plan: "free", status: "active", shard: "ovh-gra-1" };

let tokens: ApiToken[] = [
  {
    id: "tok_a1b2c3d4",
    cabinetId: CABINET.id,
    name: "claude-code · arch1",
    prefix: "5e9c1a7b",
    scopes: ["read", "write"],
    lastUsedAt: "2026-07-13T14:22:00.000Z",
    createdAt: "2026-06-28T09:14:00.000Z",
    revokedAt: null,
  },
  {
    id: "tok_e5f6a7b8",
    cabinetId: CABINET.id,
    name: "codex · gpuserv1",
    prefix: "b2d40f19",
    scopes: ["read", "write"],
    lastUsedAt: "2026-07-11T03:40:00.000Z",
    createdAt: "2026-07-02T18:02:00.000Z",
    revokedAt: null,
  },
];

let counter = 42;
function rid(p: string): string {
  counter += 1;
  return `${p}_${counter.toString(16)}${(counter * 7).toString(16)}`;
}

const wait = <T>(v: T, ms = 260): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

export const fixtures = {
  hasCabinet(): boolean {
    return scenario() !== "fresh";
  },
  signedIn(): boolean {
    return scenario() !== "out";
  },
  me(): Promise<Me> {
    return wait({
      user: { id: "usr_1", email: "operator@stuntlabs.dev", name: "Operator" },
      cabinet: this.hasCabinet() ? CABINET : null,
    });
  },
  cabinet(): Promise<CabinetStatus> {
    return wait({
      cabinet: CABINET,
      endpoint: ENDPOINT,
      health: {
        ok: true,
        storage: { adapter: "postgres", ok: true, location: "grounded_7f3a91" },
        embeddings: { provider: "ollama", ok: true, dims: 768, model: "nomic-embed-text" },
        counts: { facts: 128, sessions: 341, docs: 2874, documents: 96 },
      },
    });
  },
  tokens(): Promise<ApiToken[]> {
    return wait(tokens.filter((t) => !t.revokedAt));
  },
  createToken(name: string): Promise<IssuedToken> {
    const prefix = rid("").slice(-8).padStart(8, "0");
    const secret = `grnd_${prefix}_${rid("s")}${rid("s")}`.replace(/_s/g, "");
    const token: ApiToken = {
      id: rid("tok"),
      cabinetId: CABINET.id,
      name: name || "default",
      prefix,
      scopes: ["read", "write"],
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    tokens = [token, ...tokens];
    return wait({ token, secret, connect: snippets(secret) });
  },
  revokeToken(id: string): Promise<{ revoked: boolean }> {
    tokens = tokens.map((t) => (t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t));
    return wait({ revoked: true });
  },
  connect(): Promise<ConnectPayload> {
    return wait({ endpoint: ENDPOINT, snippets: snippets("grnd_<your-token>") });
  },
};
