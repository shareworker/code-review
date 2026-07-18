import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "index.js");
let testDir: string;

async function runCli(
  cwd: string,
  args: string[],
  env?: Record<string, string>
) {
  return execFileAsync(process.execPath, [cliPath, ...args], { cwd, timeout: 10000, env });
}

async function exists(path: string) {
  return access(path, constants.F_OK).then(() => true, () => false);
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ocr-cli-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("uninstall", () => {
  it("removes only the selected agent's code-review JSON entry and skill", async () => {
    const cwd = join(testDir, "devin");
    const configPath = join(cwd, ".devin", "config.json");
    const skillPath = join(cwd, ".devin", "skills", "code-review", "SKILL.md");
    await mkdir(join(cwd, ".devin", "skills", "code-review"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "code-review": { command: "npx", args: ["-y", "@shareworker/code-review-mcp"] },
        keep: { command: "node", args: ["server.js"] },
      },
      setting: true,
    }, null, 2));
    await writeFile(skillPath, "installed skill");

    await runCli(cwd, ["uninstall", "--agent", "devin"]);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      mcpServers: { keep: { command: "node", args: ["server.js"] } },
      setting: true,
    });
    expect(await exists(skillPath)).toBe(false);
    expect(await exists(join(cwd, ".devin", "skills", "code-review"))).toBe(false);
    expect(await exists(join(cwd, ".devin"))).toBe(true);
  });

  it("leaves other agents untouched when --agent is supplied", async () => {
    const cwd = join(testDir, "scoped");
    const claudeConfig = join(cwd, ".claude", "mcp.json");
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(claudeConfig, JSON.stringify({ mcpServers: { "code-review": { command: "npx" } } }));

    await runCli(cwd, ["uninstall", "--agent", "devin"]);

    expect(JSON.parse(await readFile(claudeConfig, "utf8")).mcpServers["code-review"]).toEqual({ command: "npx" });
  });

  it("removes only the code-review TOML section and keeps a nonempty skill directory", async () => {
    const cwd = join(testDir, "codex");
    const configPath = join(cwd, ".codex", "config.toml");
    const skillDir = join(cwd, ".codex", "skills", "code-review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(configPath, [
      "[mcp_servers.keep]",
      'command = "node"',
      "",
      "[mcp_servers.code-review]",
      'command = "npx"',
      'args = ["-y", "@shareworker/code-review-mcp"]',
      "",
      "[feature]",
      "enabled = true",
      "",
    ].join("\n"));
    await writeFile(join(skillDir, "SKILL.md"), "installed skill");
    await writeFile(join(skillDir, "LOCAL.md"), "keep this file");

    await runCli(cwd, ["uninstall", "--agent", "codex"]);

    const config = await readFile(configPath, "utf8");
    expect(config).toContain("[mcp_servers.keep]");
    expect(config).toContain('command = "node"');
    expect(config).toContain("[feature]");
    expect(config).not.toContain("[mcp_servers.code-review]");
    expect(await exists(join(skillDir, "SKILL.md"))).toBe(false);
    expect(await exists(join(skillDir, "LOCAL.md"))).toBe(true);
  });

  it("is a successful no-op when no agent directory exists", async () => {
    const cwd = join(testDir, "empty");
    await mkdir(cwd, { recursive: true });

    const { stderr } = await runCli(cwd, ["uninstall"]);

    expect(stderr).toBe("");
  });

  it("leaves the skill intact when its JSON configuration is unparseable", async () => {
    const cwd = join(testDir, "invalid-json");
    const configPath = join(cwd, ".devin", "config.json");
    const skillPath = join(cwd, ".devin", "skills", "code-review", "SKILL.md");
    await mkdir(join(cwd, ".devin", "skills", "code-review"), { recursive: true });
    await writeFile(configPath, "{ invalid json");
    await writeFile(skillPath, "installed skill");

    const { stderr } = await runCli(cwd, ["uninstall", "--agent", "devin"]);

    expect(await readFile(configPath, "utf8")).toBe("{ invalid json");
    expect(await exists(skillPath)).toBe(true);
    expect(stderr).toContain("unparseable");
  });

  it("rejects an unknown agent", async () => {
    const cwd = join(testDir, "unknown");
    await mkdir(cwd, { recursive: true });

    await expect(runCli(cwd, ["uninstall", "--agent", "unknown"])).rejects.toMatchObject({ code: 1 });
  });
});

describe("setup", () => {
  it("installs to user home when --global is passed", async () => {
    const cwd = join(testDir, "global-setup");
    const fakeHome = join(testDir, "global-home");
    await mkdir(cwd, { recursive: true });
    const env = { USERPROFILE: fakeHome, HOME: fakeHome };

    await runCli(cwd, ["setup", "--global", "--agent", "claude"], env);

    const configPath = join(fakeHome, ".claude", "mcp.json");
    const skillPath = join(fakeHome, ".claude", "skills", "code-review", "SKILL.md");
    expect(await exists(configPath)).toBe(true);
    expect(await exists(skillPath)).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8")).mcpServers["code-review"]).toEqual({
      command: "npx",
      args: ["-y", "@shareworker/code-review-mcp"],
    });
  });
});

describe("uninstall --global", () => {
  it("removes the selected agent's config and skill from user home", async () => {
    const cwd = join(testDir, "global-uninstall");
    const fakeHome = join(testDir, "global-uninstall-home");
    const configPath = join(fakeHome, ".devin", "config.json");
    const skillPath = join(fakeHome, ".devin", "skills", "code-review", "SKILL.md");
    await mkdir(join(fakeHome, ".devin", "skills", "code-review"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "code-review": { command: "npx", args: ["-y", "@shareworker/code-review-mcp"] },
        keep: { command: "node", args: ["server.js"] },
      },
    }, null, 2));
    await writeFile(skillPath, "installed skill");
    await mkdir(cwd, { recursive: true });
    const env = { USERPROFILE: fakeHome, HOME: fakeHome };

    await runCli(cwd, ["uninstall", "--global", "--agent", "devin"], env);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      mcpServers: { keep: { command: "node", args: ["server.js"] } },
    });
    expect(await exists(skillPath)).toBe(false);
    expect(await exists(join(fakeHome, ".devin", "skills", "code-review"))).toBe(false);
  });
});
