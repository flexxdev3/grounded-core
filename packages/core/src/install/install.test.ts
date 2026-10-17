import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { bootstrap, CABINET_DIRS } from "./bootstrap.js";
import { cabinetDir, cabinetLayout, defaultConfig, defaultHome, hasCabinetData, visibleRoot } from "../config.js";
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
    const first = await bootstrap({ home, migrate: false, probeEmbedder: async () => true });
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
    const second = await bootstrap({ home, migrate: false, probeEmbedder: async () => true });
    expect(second.wroteConfig).toBe(false);
  });

  it("runs migrations when migrate is not disabled", async () => {
    const res = await bootstrap({ home, probeEmbedder: async () => false });
    expect(res.migrated).toBe(true);
    // the sqlite cabinet db should now exist
    expect(existsSync(join(home, "cabinet", "grounded.db"))).toBe(true);
  });
});

describe("bootstrap embeddings default", () => {
  it("keeps ollama when it answers", async () => {
    const res = await bootstrap({ home, migrate: false, probeEmbedder: async () => true });
    expect(res.embeddings?.provider).toBe("ollama");
    expect(readFileSync(res.configPath, "utf8")).toContain('provider = "ollama"');
  });

  it("starts lexical-only when no ollama answers, and says why", async () => {
    const res = await bootstrap({ home, migrate: false, probeEmbedder: async () => false });
    expect(res.embeddings?.provider).toBe("none");
    expect(res.embeddings?.reason).toMatch(/no ollama at http:\/\/localhost:11434/);
    const toml = readFileSync(res.configPath, "utf8");
    expect(toml).toMatch(/\[embeddings\]\nprovider = "none"\n/);
    expect(toml).not.toContain("nomic-embed-text");
  });

  it("never probes or rewrites an existing config", async () => {
    await bootstrap({ home, migrate: false, probeEmbedder: async () => true });
    let probed = false;
    const res = await bootstrap({ home, migrate: false, probeEmbedder: async () => ((probed = true), false) });
    expect(probed).toBe(false);
    expect(res.embeddings).toBeUndefined();
    expect(readFileSync(res.configPath, "utf8")).toContain('provider = "ollama"');
  });
});

describe("defaultHome", () => {
  it("is ~/.grounded off Windows", () => {
    expect(defaultHome("linux", home)).toBe(join(home, ".grounded"));
    expect(defaultHome("darwin", home)).toBe(join(home, ".grounded"));
  });

  it("uses ~/.grounded for Windows system state and a separate visible Cabinet", () => {
    const h = defaultHome("win32", home);
    expect(h).toBe(join(home, ".grounded"));
    expect(cabinetDir(h, "win32")).toBe(join(home, "Grounded", "Cabinet"));
    expect(visibleRoot(h, "win32")).toBe(join(home, "Grounded"));
  });

  for (const platform of ["win32", "linux", "darwin"] as const) {
    it(`puts a default .grounded home's data in ~/Grounded/Cabinet on ${platform}`, () => {
      const h = join(home, ".grounded");
      expect(cabinetDir(h, platform)).toBe(join(home, "Grounded", "Cabinet"));
      expect(visibleRoot(h, platform)).toBe(join(home, "Grounded"));
      expect(defaultConfig(h, platform).storage.path).toBe(join(home, "Grounded", "Cabinet", "grounded.db"));
      expect(cabinetLayout(h)).toMatchObject({ kind: "visible", leftover: null });
    });

    it(`keeps the cabinet inside an explicit custom home on ${platform}`, () => {
      const h = join(home, "custom");
      expect(cabinetDir(h, platform)).toBe(join(h, "cabinet"));
      expect(visibleRoot(h, platform)).toBe(h);
      expect(defaultConfig(h, platform).storage.path).toBe(join(h, "cabinet", "grounded.db"));
      expect(cabinetLayout(h).kind).toBe("custom");
    });
  }

  it("keeps the legacy .core layout's Cabinet beside it", () => {
    const h = join(home, "Grounded", ".core");
    expect(cabinetDir(h)).toBe(join(home, "Grounded", "Cabinet"));
    expect(visibleRoot(h)).toBe(join(home, "Grounded"));
  });

  it("keeps an existing legacy .core install until explicit migration", () => {
    const legacy = join(home, "Grounded", ".core");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.toml"), "[storage]\n");
    expect(defaultHome("win32", home)).toBe(legacy);
    mkdirSync(join(home, ".grounded"));
    writeFileSync(join(home, ".grounded", "config.toml"), "[storage]\n");
    expect(defaultHome("win32", home)).toBe(join(home, ".grounded"));
  });
});

describe("legacy ~/.grounded/cabinet", () => {
  const sys = () => join(home, ".grounded");
  const legacy = () => join(home, ".grounded", "cabinet");
  const target = () => join(home, "Grounded", "Cabinet");

  it("only files count as data, not bootstrap's empty skeleton", () => {
    mkdirSync(join(legacy(), "docs"), { recursive: true });
    expect(hasCabinetData(legacy())).toBe(false);
    expect(cabinetDir(sys())).toBe(target());
    writeFileSync(join(legacy(), "docs", "a.md"), "x");
    expect(hasCabinetData(legacy())).toBe(true);
  });

  for (const platform of ["win32", "linux", "darwin"] as const) {
    it(`keeps using an existing legacy cabinet on ${platform} (never a new empty one)`, () => {
      mkdirSync(legacy(), { recursive: true });
      writeFileSync(join(legacy(), "grounded.db"), "db");
      mkdirSync(join(target(), "docs"), { recursive: true }); // empty skeleton does not win
      expect(cabinetDir(sys(), platform)).toBe(legacy());
      expect(visibleRoot(sys(), platform)).toBe(sys());
      expect(defaultConfig(sys(), platform).storage.path).toBe(join(legacy(), "grounded.db"));
      expect(cabinetLayout(sys())).toEqual({ dir: legacy(), kind: "legacy", target: target(), leftover: legacy() });
    });
  }

  it("prefers a populated visible cabinet and reports a leftover legacy one", () => {
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), "grounded.db"), "old");
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "grounded.db"), "new");
    expect(cabinetLayout(sys())).toEqual({ dir: target(), kind: "visible", target: target(), leftover: legacy() });
  });

  it("bootstrap of a legacy home keeps writing to the legacy cabinet", async () => {
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), "keep.txt"), "x");
    await bootstrap({ home: sys(), probeEmbedder: async () => false });
    expect(existsSync(join(legacy(), "grounded.db"))).toBe(true);
    expect(existsSync(target())).toBe(false);
  });

  it("bootstrap of a fresh default home creates ~/Grounded/Cabinet, nothing inside .grounded", async () => {
    await bootstrap({ home: sys(), probeEmbedder: async () => false });
    expect(existsSync(join(target(), "grounded.db"))).toBe(true);
    for (const dir of CABINET_DIRS) expect(existsSync(join(target(), dir))).toBe(true);
    expect(existsSync(legacy())).toBe(false);
    expect(existsSync(join(sys(), "config.toml"))).toBe(true);
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

  it("docker run args are labelled, mount config and cabinet separately, loopback-published", () => {
    const h = join(home, ".grounded");
    const args = renderDockerRunArgs({ home: h, port: 7000 });
    expect(args).toContain("--label");
    expect(args).toContain("com.grounded.managed=true");
    expect(args).toContain("-v");
    expect(args).toContain("GROUNDED_HOME=/grounded/.grounded");
    expect(args).toContain(`${h}:/grounded/.grounded`);
    expect(args).toContain(`${join(home, "Grounded", "Cabinet")}:/grounded/Grounded/Cabinet`);
    expect(args).toContain("127.0.0.1:7000:7000");
    expect(args.at(-1)).toBe("grounded:latest");
    // the in-container home resolves the in-container cabinet by the same rule
    expect(cabinetDir("/grounded/.grounded")).toBe(join("/grounded", "Grounded", "Cabinet"));
    const compose = renderComposeYaml({ home: h });
    expect(compose).toContain(`- ${h}:/grounded/.grounded`);
    expect(compose).toContain(`- ${join(home, "Grounded", "Cabinet")}:/grounded/Grounded/Cabinet`);
    expect(compose).toContain("GROUNDED_HOME: /grounded/.grounded");
  });

  it("docker keeps the old single mount for a legacy or custom home (reinstall keeps its data)", () => {
    const h = join(home, ".grounded");
    mkdirSync(join(h, "cabinet"), { recursive: true });
    writeFileSync(join(h, "cabinet", "grounded.db"), "db");
    const args = renderDockerRunArgs({ home: h });
    expect(args).toContain(`${h}:/cabinet`);
    expect(args.some((a) => a.startsWith("GROUNDED_HOME="))).toBe(false);
    expect(renderComposeYaml({ home: h })).toContain(`- ${h}:/cabinet`);
    expect(renderDockerRunArgs({ home: join(home, "custom") })).toContain(`${join(home, "custom")}:/cabinet`);
    // image default GROUNDED_HOME=/cabinet resolves /cabinet/cabinet = host <home>/cabinet
    expect(cabinetDir("/cabinet")).toBe(join("/cabinet", "cabinet"));
  });

  it("docker mounts the whole Grounded folder for a Windows .core home", () => {
    const h = join(home, "Grounded", ".core");
    const args = renderDockerRunArgs({ home: h });
    expect(args).toContain("GROUNDED_HOME=/grounded/Grounded/.core");
    expect(args).toContain(`${join(home, "Grounded")}:/grounded/Grounded`);
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
