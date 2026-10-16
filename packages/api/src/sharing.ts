import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { serve, type ServerType } from "@hono/node-server";

export const DEFAULT_SHARE_MINUTES = 3;
export const MAX_SHARE_MINUTES = 60;

export interface SharingStatus {
  active: boolean;
  pairingOpen: boolean;
  pairedClients: number;
  port: number;
  code?: string;
  startedAt?: string;
  expiresAt?: string;
  addresses: string[];
}

export interface SharingController {
  status(includeCode?: boolean): SharingStatus;
  initialize(): Promise<void>;
  start(minutes?: number): Promise<SharingStatus>;
  stop(): Promise<SharingStatus>;
  close(): Promise<void>;
}

type SharingState = { enabled: boolean; clientHashes: string[] };

function privateIpv4Addresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a = 0, b = 0] = entry.address.split(".").map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) addresses.add(entry.address);
    }
  }
  const rank = (address: string) => address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : 2;
  return [...addresses].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function sameSecret(actual: string, supplied: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A persistent, opt-in LAN surface with short-lived enrollment. The six-digit
 * code is valid only long enough to register a client; successful pairing
 * returns a durable random credential. Expiring the code never disconnects an
 * already paired client. Host-administration routes are never forwarded.
 */
export function createSharingController(opts: {
  fetch: (request: Request) => Response | Promise<Response>;
  port: number;
  host?: string;
  internalHeader?: string;
  stateFile?: string;
}): SharingController {
  const host = opts.host ?? "0.0.0.0";
  const internalHeader = opts.internalHeader ?? randomUUID();
  let server: ServerType | undefined;
  let code: string | undefined;
  let startedAt: number | undefined;
  let expiresAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;
  let lockedUntil = 0;
  let state: SharingState = { enabled: false, clientHashes: [] };

  if (opts.stateFile && existsSync(opts.stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(opts.stateFile, "utf8")) as Partial<SharingState>;
      state = {
        enabled: saved.enabled === true,
        clientHashes: Array.isArray(saved.clientHashes) ? saved.clientHashes.filter(v => typeof v === "string") : [],
      };
    } catch { /* invalid state stays safely disabled */ }
  }

  const persist = () => {
    if (!opts.stateFile) return;
    mkdirSync(dirname(opts.stateFile), { recursive: true });
    writeFileSync(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  const clearPairing = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    code = undefined;
    startedAt = undefined;
    expiresAt = undefined;
    failures = 0;
    lockedUntil = 0;
  };

  const closeListener = async () => {
    clearPairing();
    const current = server;
    server = undefined;
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  };

  const pairingOpen = () => Boolean(code && expiresAt && expiresAt > Date.now());
  const status = (includeCode = true): SharingStatus => ({
    active: Boolean(server),
    pairingOpen: pairingOpen(),
    pairedClients: state.clientHashes.length,
    port: opts.port,
    ...(includeCode && pairingOpen() && code ? { code } : {}),
    ...(pairingOpen() && startedAt ? { startedAt: new Date(startedAt).toISOString() } : {}),
    ...(pairingOpen() && expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    addresses: privateIpv4Addresses().map((address) => `http://${address}:${opts.port}`),
  });

  const handle = async (request: Request): Promise<Response> => {
    const now = Date.now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/pair" && method === "POST") {
      if (!pairingOpen()) return Response.json({ error: "pairing window closed", code: "PAIRING_CLOSED" }, { status: 410 });
      if (lockedUntil > now) return Response.json({ error: "too many incorrect codes; try again shortly", code: "PAIRING_LOCKED" }, { status: 429 });
      const supplied = request.headers.get("x-grounded-share-code") ?? "";
      if (!code || !sameSecret(code, supplied)) {
        failures += 1;
        if (failures >= 10) { failures = 0; lockedUntil = now + 30_000; }
        return Response.json({ error: "incorrect or expired sharing code", code: "PAIRING_REJECTED" }, { status: 401 });
      }
      failures = 0;
      const token = randomBytes(32).toString("base64url");
      state.clientHashes.push(tokenHash(token));
      persist();
      return Response.json({ token });
    }

    if (url.pathname === "/pair" || url.pathname.startsWith("/pair/") || url.pathname === "/sharing" || url.pathname.startsWith("/sharing/") || url.pathname.startsWith("/addons/") || (method !== "GET" && /^\/databox\/[^/]+\/index$/.test(url.pathname))) {
      return Response.json({ error: "host administration is local only", code: "LOCAL_ONLY" }, { status: 403 });
    }

    const supplied = request.headers.get("x-grounded-client-token") ?? "";
    const suppliedHash = tokenHash(supplied);
    if (!supplied || !state.clientHashes.some(hash => sameSecret(hash, suppliedHash))) {
      return Response.json({ error: "paired cabinet credential required", code: "PAIRING_REQUIRED" }, { status: 401 });
    }
    const headers = new Headers(request.headers);
    headers.delete("x-grounded-client-token");
    headers.set("x-grounded-internal-share", internalHeader);
    return opts.fetch(new Request(request, { headers }));
  };

  const openListener = async () => {
    if (server) return;
    await new Promise<void>((resolve, reject) => {
      const next = serve({ fetch: handle, port: opts.port, hostname: host }, () => { server = next; resolve(); });
      next.once("error", reject);
    });
  };

  return {
    status,
    async initialize() { if (state.enabled) await openListener(); },
    async start(minutes = DEFAULT_SHARE_MINUTES) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SHARE_MINUTES) throw new Error(`pairing duration must be an integer from 1 to ${MAX_SHARE_MINUTES} minutes`);
      state.enabled = true;
      persist();
      await openListener();
      clearPairing();
      code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      startedAt = Date.now();
      expiresAt = startedAt + minutes * 60_000;
      timer = setTimeout(clearPairing, minutes * 60_000);
      timer.unref();
      return status(true);
    },
    async stop() {
      state.enabled = false;
      persist();
      await closeListener();
      return status(false);
    },
    close: closeListener,
  };
}

export function sharingInternalHeader(): string { return randomUUID(); }
