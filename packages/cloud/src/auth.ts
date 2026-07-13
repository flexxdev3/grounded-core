import { betterAuth } from "better-auth";
import type pg from "pg";
import type { CloudConfig } from "./config.js";

/**
 * better-auth instance, backed by the control-plane pool (pinned to the accounts
 * schema via search_path in db.ts). Owns user/session/account/verification tables.
 *
 * Table creation: run `npx @better-auth/cli migrate` once at deploy (baked into the
 * compose entrypoint) — better-auth does not DDL at runtime. Our own control-plane
 * tables are handled by migrateControlPlane().
 */
export function createAuth(pool: pg.Pool, cfg: CloudConfig) {
  return betterAuth({
    database: pool,
    secret: cfg.authSecret,
    baseURL: cfg.baseUrl,
    basePath: "/auth",
    emailAndPassword: {
      enabled: true,
      // Email verification/reset callbacks are wired by the cloud UI; keep signups
      // usable in dev without an SMTP dependency (tighten before public launch).
      requireEmailVerification: false,
    },
    socialProviders: cfg.github
      ? { github: { clientId: cfg.github.clientId, clientSecret: cfg.github.clientSecret } }
      : undefined,
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      expiresIn: 60 * 60 * 24 * 30,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Read the current browser session from request headers, or null. */
export async function sessionFromHeaders(
  auth: Auth,
  headers: Headers,
): Promise<{ userId: string; email: string } | null> {
  const res = await auth.api.getSession({ headers });
  if (!res?.user) return null;
  return { userId: res.user.id, email: res.user.email };
}
