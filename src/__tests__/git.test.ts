import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import {
  getDiff,
  getDiffSummary,
  getFileContent,
  getStatus,
  getUntrackedFiles,
  synthesizeUntrackedDiff,
} from "../git.js";

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-git-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "a.ts"), "export const a = 1;\n");
  await git.add(".");
  await git.commit("init");
  // Second commit so HEAD~1 exists.
  await writeFile(join(repoDir, "README.md"), "# test\n");
  await git.add(".");
  await git.commit("add readme");
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("getDiff", () => {
  it("returns unified diff text for a range ref", async () => {
    const diff = await getDiff(repoDir, "HEAD~1..HEAD");
    expect(diff).toContain("diff --git");
    expect(diff).toContain("README.md");
  });

  it("returns empty string when no changes", async () => {
    const diff = await getDiff(repoDir, "HEAD..HEAD");
    expect(diff).toBe("");
  });
});

describe("getDiffSummary", () => {
  it("returns file-level metadata with insertions/deletions", async () => {
    const summary = await getDiffSummary(repoDir, "HEAD~1..HEAD");
    expect(summary.length).toBeGreaterThan(0);
    const file = summary.find((f) => f.file.includes("README.md"));
    expect(file).toBeDefined();
    expect(file!.insertions).toBeGreaterThan(0);
    expect(file!.binary).toBe(false);
  });
});

describe("getFileContent", () => {
  it("reads file content at a ref", async () => {
    const content = await getFileContent(repoDir, "HEAD", "src/a.ts");
    expect(content).toContain("export const a = 1");
  });

  it("reads file content from worktree when ref=WORKTREE", async () => {
    const content = await getFileContent(repoDir, "WORKTREE", "src/a.ts");
    expect(content).toContain("export const a = 1");
  });
});

describe("getStatus and getUntrackedFiles", () => {
  it("detects untracked files", async () => {
    await writeFile(join(repoDir, "src", "b.ts"), "export const b = 2;\n");
    const untracked = await getUntrackedFiles(repoDir);
    expect(untracked).toContain("src/b.ts");
    const status = await getStatus(repoDir);
    const bEntry = status.find((s) => s.path === "src/b.ts");
    expect(bEntry?.status).toBe("untracked");
  });
});

describe("synthesizeUntrackedDiff", () => {
  it("synthesizes a full-file-add diff for an untracked file", async () => {
    const diff = await synthesizeUntrackedDiff(repoDir, "src/b.ts");
    expect(diff).toContain("diff --git a/src/b.ts b/src/b.ts");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/src/b.ts");
    expect(diff).toContain("+export const b = 2;");
    expect(diff).toMatch(/@@ -0,0 \+1,\d+ @@/);
  });

  it("returns empty body diff for unreadable file", async () => {
    const diff = await synthesizeUntrackedDiff(repoDir, "nonexistent.ts");
    expect(diff).toBe("");
  });
});
