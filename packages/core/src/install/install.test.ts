import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { bootstrap, CABINET_DIRS } from "./bootstrap.js";
import {
  readManifest,
  writeManifest,
  manifestPath,
  probeHealth,
  type InstallManifest,
} from "./detect.js";
import { renderSystemdUnit, renderDockerRunArgs, renderComposeYaml } from "./unit.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "grounded-install-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("bootstrap", () => {
  it("creates the cabinet tree and writes config once (idempotent)", async () => {
    const first = await bootstrap({ home, migrate: false });
    expect(first.home).toBe(home);
    expect(first.wroteConfig).toBe(true);
    expect(existsSync(first.configPath)).toBe(true);
    for (const dir of CABINET_DIRS) {
      expect(existsSync(join(home, "cabinet", dir))).toBe(true);
    }
    // config content is valid TOML-ish with the storage block
    const toml = readFileSync(first.configPath, "utf8");
    expect(toml).toContain("[storage]");
    // portability: no environment-pinned absolute paths persisted
    expect(toml).not.toMatch(/^home\s*=/m);
    expect(toml).not.toContain(join(home, "cabinet", "grounded.db"));

    // second run must not clobber the existing config
    const second = await bootstrap({ home, migrate: false });
    expect(second.wroteConfig).toBe(false);
  });

  it("runs migrations when migrate is not disabled", async () => {
    const res = await bootstrap({ home });
    expect(res.migrated).toBe(true);
    // the sqlite cabinet db should now exist
    expect(existsSync(join(home, "cabinet", "grounded.db"))).toBe(true);
  });
});

describe("install manifest", () => {
  it("returns undefined when absent, round-trips when written", () => {
    expect(readManifest(home)).toBeUndefined();
    const m: InstallManifest = { method: "docker", port: 7437, ref: "abc123", version: "0.1.0" };
    writeManifest(m, home);
    expect(existsSync(manifestPath(home))).toBe(true);
    expect(readManifest(home)).toEqual(m);
  });

  it("tolerates a corrupt manifest file", () => {
    writeManifest({ method: "systemd-user", port: 1 }, home);
    // clobber with junk
    writeFileSync(manifestPath(home), "{not json", "utf8");
    expect(readManifest(home)).toBeUndefined();
  });
});

describe("unit rendering", () => {
  it("systemd user unit targets default.target and sets the cabinet env", () => {
    const unit = renderSystemdUnit("user", { home: "/h/.grounded", execPath: "/usr/bin/grounded-api", port: 9999 });
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Environment=GROUNDED_HOME=/h/.grounded");
    expect(unit).toContain("Environment=GROUNDED_API_PORT=9999");
    expect(unit).toContain("ExecStart=/usr/bin/grounded-api");
    expect(unit).toContain("Restart=always");
  });

  it("systemd system unit targets multi-user.target", () => {
    const unit = renderSystemdUnit("system");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("docker run args are labelled, cabinet-mounted, loopback-published", () => {
    const args = renderDockerRunArgs({ home: "/h/.grounded", port: 7000 });
    expect(args).toContain("--label");
    expect(args).toContain("com.grounded.managed=true");
    expect(args).toContain("-v");
    expect(args).toContain("/h/.grounded:/cabinet");
    expect(args).toContain("127.0.0.1:7000:7000");
    expect(args.at(-1)).toBe("grounded:latest");
  });

  it("token is threaded into both systemd and docker when present", () => {
    expect(renderSystemdUnit("user", { token: "sekret" })).toContain("GROUNDED_API_TOKEN=sekret");
    expect(renderDockerRunArgs({ token: "sekret" })).toContain("GROUNDED_API_TOKEN=sekret");
    expect(renderComposeYaml({ token: "sekret" })).toContain("GROUNDED_API_TOKEN: sekret");
  });
});

describe("probeHealth fingerprint", () => {
  let server: Server;
  let port: number;

  async function serve(body: unknown, status = 200): Promise<void> {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("accepts a genuine Grounded health shape", async () => {
    await serve({
      ok: true,
      storage: { adapter: "sqlite" },
      embeddings: { provider: "ollama", dims: 768 },
      counts: { facts: 1, sessions: 2, docs: 3, documents: 3 },
    });
    const probe = await probeHealth(port, 1500);
    expect(probe).not.toBeNull();
    expect(probe?.adapter).toBe("sqlite");
    expect(probe?.counts?.documents).toBe(3);
  });

  it("rejects a non-Grounded service squatting the port", async () => {
    await serve({ status: "ok", service: "something-else" });
    expect(await probeHealth(port, 1500)).toBeNull();
  });

  it("returns null when nothing is listening", async () => {
    // an unlikely-free port; connection refused => null, no throw
    expect(await probeHealth(59_123, 800)).toBeNull();
  });
});
