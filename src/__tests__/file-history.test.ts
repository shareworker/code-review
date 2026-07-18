import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import { getFileHistoryStats } from "../file-history.js";

let repoDir: string;
let git: ReturnType<typeof simpleGit>;

async function makeRepo(): Promise<void> {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-history-"));
  git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
}

describe("getFileHistoryStats", () => {
  beforeEach(makeRepo);

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns stats for a file with commit history", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "export const a = 1;\n");
    await git.add(".");
    await git.commit("initial commit");
    await writeFile(join(repoDir, "src", "a.ts"), "export const a = 2;\n");
    await git.add(".");
    await git.commit("fix: handle edge case");
    await writeFile(join(repoDir, "src", "a.ts"), "export const a = 3;\n");
    await git.add(".");
    await git.commit("refactor: cleanup");

    const result = await getFileHistoryStats(repoDir, { path: "src/a.ts" });
    expect(result.totalCommits).toBe(3);
    expect(result.lastModified).toBeDefined();
    expect(result.fixCommitRatio).toBeCloseTo(1 / 3, 5);
  });

  it("returns zero stats for a new file with no history", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "new.ts"), "export const x = 1;\n");
    // Don't commit — file is untracked, no history.
    const result = await getFileHistoryStats(repoDir, { path: "src/new.ts" });
    expect(result.totalCommits).toBe(0);
    expect(result.fixCommitRatio).toBe(0);
  });

  it("returns reason for a path that never existed", async () => {
    const result = await getFileHistoryStats(repoDir, { path: "nonexistent.ts" });
    expect(result.totalCommits).toBe(0);
    expect(result.reason).toBeDefined();
  });

  it("returns reason for non-git directory", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "ocr-history-nongit-"));
    try {
      const result = await getFileHistoryStats(nonRepo, { path: "any.ts" });
      expect(result.totalCommits).toBe(0);
      expect(result.reason).toMatch(/not a git/i);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});
