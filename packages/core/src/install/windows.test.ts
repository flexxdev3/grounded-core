import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  renderTaskXml,
  renderServiceLauncher,
  windowsServicePaths,
  renderDesktopIni,
  decorateWindowsFolder,
  WINDOWS_TASK,
} from "./windows.js";
import { GROUNDED_ICO_BASE64 } from "./windows-icon.js";

const SID = "S-1-5-21-1-2-3-1001";
const base = {
  sid: SID,
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  launcherPath: "C:\\Users\\A&B\\.grounded\\service\\grounded-service.mjs",
  workDir: "C:\\Users\\A&B\\.grounded",
};

describe("renderTaskXml", () => {
  it("S4U runs node directly as the user's SID, never by domain name", () => {
    const xml = renderTaskXml({ ...base, logonType: "S4U" });
    expect(xml).toContain(`<UserId>${SID}</UserId>`);
    expect(xml).toContain("<LogonType>S4U</LogonType>");
    expect(xml).toContain("<Command>C:\\Program Files\\nodejs\\node.exe</Command>");
    expect(xml).not.toContain("conhost");
  });

  it("the logon-session fallback wraps node in a headless conhost", () => {
    const xml = renderTaskXml({ ...base, logonType: "InteractiveToken" });
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toMatch(/<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot; /);
  });

  it("survives a laptop: runs on battery, never times out, one instance", () => {
    const xml = renderTaskXml({ ...base, logonType: "S4U" });
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = renderTaskXml({ ...base, logonType: "S4U" });
    expect(xml).toContain("C:\\Users\\A&amp;B\\.grounded");
    expect(xml).not.toMatch(/A&B/);
  });

  it("declares UTF-16 and uses CRLF line endings", () => {
    const xml = renderTaskXml({ ...base, logonType: "S4U" });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
  });
});

describe("renderServiceLauncher", () => {
  it("embeds the api env, and the token only when given", () => {
    const js = renderServiceLauncher({ home: "C:\\h", apiBin: "C:\\api.mjs", port: 9999 });
    expect(js).toContain('"GROUNDED_HOME":"C:\\\\h"');
    expect(js).toContain('"GROUNDED_API_PORT":"9999"');
    expect(js).toContain('"GROUNDED_API_HOST":"127.0.0.1"');
    expect(js).not.toContain("GROUNDED_API_TOKEN");
    expect(renderServiceLauncher({ home: "C:\\h", apiBin: "C:\\api.mjs", token: "sekret" })).toContain(
      '"GROUNDED_API_TOKEN":"sekret"',
    );
  });

  it("treats only ESRCH as a dead parent — the S4U parent is a SYSTEM svchost that answers EPERM", () => {
    const js = renderServiceLauncher({ home: "C:\\h", apiBin: "C:\\api.mjs" });
    expect(js).toMatch(/process\.kill\(parent, 0\); \} catch \(e\) \{ if \(e\.code === "ESRCH"\)/);
  });

  it("keeps every artifact inside the cabinet", () => {
    const p = windowsServicePaths("/cab");
    expect(p.launcher).toBe(join("/cab", "service", "grounded-service.mjs"));
    expect(p.log).toBe(join("/cab", "logs", "grounded.log"));
    expect(p.pid).toBe(join("/cab", "service", "grounded.pid"));
    expect(WINDOWS_TASK).toBe("Grounded");
  });
});

describe("the rendered supervisor, run for real", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "grounded-winsvc-"));
    mkdirSync(join(home, "service"), { recursive: true });
    mkdirSync(join(home, "logs"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("logs the api's output, records pids, and restarts it when it exits", async () => {
    // a fake api that prints its env and dies at once
    const api = join(home, "fake-api.mjs");
    writeFileSync(api, `console.log("api up port=" + process.env.GROUNDED_API_PORT); process.exit(3);\n`);
    const p = windowsServicePaths(home);
    writeFileSync(p.launcher, renderServiceLauncher({ home, apiBin: api, port: 7777 }));

    const sup = spawn(process.execPath, [p.launcher], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 2500)); // first run + one 1 s restart
      const log = readFileSync(p.log, "utf8");
      expect(log.match(/api up port=7777/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(log).toContain("grounded-api exited (3), restarting in 1000 ms");
      expect(existsSync(p.pid)).toBe(true);
      const pids = JSON.parse(readFileSync(p.pid, "utf8"));
      expect(pids.supervisor).toBe(sup.pid);
    } finally {
      sup.kill();
    }
  }, 10000);
});

describe("the cabinet folder icon", () => {
  it("desktop.ini points Explorer at the icon beside it, CRLF like Windows writes it", () => {
    const ini = renderDesktopIni();
    expect(ini.startsWith("[.ShellClassInfo]\r\nIconResource=grounded.ico,0\r\n")).toBe(true);
  });

  it("the embedded icon is a real multi-size .ico", () => {
    const ico = Buffer.from(GROUNDED_ICO_BASE64, "base64");
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type 1 = icon
    expect(ico.readUInt16LE(4)).toBe(5); // 16, 24, 32, 48, 256
  });

  it("does nothing off Windows", async () => {
    const home = mkdtempSync(join(tmpdir(), "grounded-ico-"));
    try {
      expect(await decorateWindowsFolder(home)).toBe(false);
      expect(existsSync(join(home, "desktop.ini"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
