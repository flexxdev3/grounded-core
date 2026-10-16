import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSharingController, type SharingController } from "./sharing.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("no test port"));
      probe.close(() => resolve(address.port));
    });
  });
}

describe("paired network sharing", () => {
  let sharing: SharingController | undefined;
  afterEach(async () => sharing?.close());

  it("exchanges a temporary code for durable client access and blocks host administration", async () => {
    const port = await freePort();
    sharing = createSharingController({
      port,
      host: "127.0.0.1",
      internalHeader: "fixture-internal",
      fetch: (request) =>
        Response.json({
          ok: true,
          shared: request.headers.get("x-grounded-internal-share"),
          leakedCode: request.headers.has("x-grounded-share-code"),
        }),
    });
    const state = await sharing.start(1);
    expect(state.active).toBe(true);
    expect(state.pairingOpen).toBe(true);
    expect(state.code).toMatch(/^\d{6}$/);

    const endpoint = `http://127.0.0.1:${port}`;
    expect((await fetch(`${endpoint}/health`)).status).toBe(401);
    expect((await fetch(`${endpoint}/pair`, { method: "POST", headers: { "x-grounded-share-code": "000000" } })).status).toBe(401);

    const paired = await fetch(`${endpoint}/pair`, { method: "POST", headers: { "x-grounded-share-code": state.code! } });
    expect(paired.status).toBe(200);
    const token = String((await paired.json() as { token: string }).token);
    expect(token.length).toBeGreaterThan(32);

    const allowed = await fetch(`${endpoint}/health`, { headers: { "x-grounded-client-token": token } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, shared: "fixture-internal", leakedCode: false });

    const admin = await fetch(`${endpoint}/sharing`, { headers: { "x-grounded-client-token": token } });
    expect(admin.status).toBe(403);
    const addon = await fetch(`${endpoint}/addons/embeddings`, { headers: { "x-grounded-client-token": token } });
    expect(addon.status).toBe(403);

    const stopped = await sharing.stop();
    expect(stopped.active).toBe(false);
    expect(stopped.pairingOpen).toBe(false);
    expect(stopped.code).toBeUndefined();
  });
});
