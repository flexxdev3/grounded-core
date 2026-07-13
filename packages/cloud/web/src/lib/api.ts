// The account API + auth surface the SPA talks to. All requests are same-origin
// (the gateway serves this UI) with the session cookie sent along. In MOCK mode
// every call is served from fixtures so the design loop needs no live backend.
import { MOCK, fixtures } from "./fixtures.js";
import type {
  ApiToken,
  CabinetStatus,
  ConnectPayload,
  IssuedToken,
  Me,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(data.error ?? data.message ?? res.statusText, res.status, data.code);
  }
  return data as T;
}

export function errMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return String(e);
}

// ---- Auth (better-auth at /auth/*) --------------------------------------
export const auth = {
  async session(): Promise<Me | null> {
    if (MOCK) return fixtures.signedIn() ? fixtures.me() : null;
    try {
      // better-auth get-session returns { user, session } or null-ish; then hydrate cabinet.
      const s = await req<{ user?: { id: string; email: string; name?: string } }>("/auth/get-session");
      if (!s?.user) return null;
      return await req<Me>("/account/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      return null;
    }
  },
  async signUp(email: string, password: string, name?: string): Promise<void> {
    if (MOCK) return;
    await req("/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, password, name: name || email.split("@")[0] }) });
  },
  async signIn(email: string, password: string): Promise<void> {
    if (MOCK) return;
    await req("/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
  },
  github(): void {
    if (MOCK) return;
    const callbackURL = `${location.origin}${location.pathname}`;
    location.href = `/auth/sign-in/social?provider=github&callbackURL=${encodeURIComponent(callbackURL)}`;
  },
  async signOut(): Promise<void> {
    if (MOCK) return;
    await req("/auth/sign-out", { method: "POST", body: "{}" });
  },
};

// ---- Account (/account/*, session-gated) --------------------------------
export const account = {
  me: (): Promise<Me> => (MOCK ? fixtures.me() : req<Me>("/account/me")),
  cabinet: (): Promise<CabinetStatus> => (MOCK ? fixtures.cabinet() : req<CabinetStatus>("/account/cabinet")),
  connect: (): Promise<ConnectPayload> => (MOCK ? fixtures.connect() : req<ConnectPayload>("/account/connect")),
  tokens: {
    list: (): Promise<ApiToken[]> =>
      MOCK ? fixtures.tokens() : req<{ tokens: ApiToken[] }>("/account/tokens").then((r) => r.tokens),
    create: (name: string): Promise<IssuedToken> =>
      MOCK ? fixtures.createToken(name) : req<IssuedToken>("/account/tokens", { method: "POST", body: JSON.stringify({ name }) }),
    revoke: (id: string): Promise<unknown> =>
      MOCK ? fixtures.revokeToken(id) : req(`/account/tokens/${id}`, { method: "DELETE" }),
  },
  deleteAccount: (): Promise<unknown> => (MOCK ? Promise.resolve({}) : req("/account", { method: "DELETE" })),
};
