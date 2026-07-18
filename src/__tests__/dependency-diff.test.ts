import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import { checkDependencyDiff } from "../dependency-diff.js";

let repoDir: string;
let git: ReturnType<typeof simpleGit>;

async function makeRepo(): Promise<void> {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-dep-"));
  git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
}

describe("checkDependencyDiff", () => {
  beforeEach(makeRepo);

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("detects added unpinned npm dependency", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { "existing-pkg": "1.0.0" } })
    );
    await git.add(".");
    await git.commit("initial");
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { "existing-pkg": "1.0.0", "new-pkg": "*" } })
    );
    const result = await checkDependencyDiff(repoDir, { path: "package.json", diffRef: "HEAD" });
    expect(result.added.some((d) => d.name === "new-pkg")).toBe(true);
    expect(result.unpinned).toContain("new-pkg");
    expect(result.removed).toEqual([]);
  });

  it("detects added pinned npm dependency as not unpinned", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} })
    );
    await git.add(".");
    await git.commit("initial");
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { "new-pkg": "1.2.3" } })
    );
    const result = await checkDependencyDiff(repoDir, { path: "package.json", diffRef: "HEAD" });
    expect(result.added.some((d) => d.name === "new-pkg")).toBe(true);
    expect(result.unpinned).not.toContain("new-pkg");
  });

  it("detects removed dependency", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { "old-pkg": "1.0.0" } })
    );
    await git.add(".");
    await git.commit("initial");
    // Remove old-pkg in worktree (uncommitted).
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} })
    );
    const result = await checkDependencyDiff(repoDir, { path: "package.json", diffRef: "HEAD" });
    expect(result.removed).toContain("old-pkg");
  });

  it("handles requirements.txt", async () => {
    await writeFile(join(repoDir, "requirements.txt"), "existing==1.0\n");
    await git.add(".");
    await git.commit("initial");
    await writeFile(join(repoDir, "requirements.txt"), "existing==1.0\nnew-pkg\n");
    const result = await checkDependencyDiff(repoDir, { path: "requirements.txt", diffRef: "HEAD" });
    expect(result.added.some((d) => d.name === "new-pkg")).toBe(true);
    expect(result.unpinned).toContain("new-pkg");
  });

  it("handles go.mod", async () => {
    await writeFile(
      join(repoDir, "go.mod"),
      "module test\n\ngo 1.21\n\nrequire (\n\texisting v1.0.0\n)\n"
    );
    await git.add(".");
    await git.commit("initial");
    await writeFile(
      join(repoDir, "go.mod"),
      "module test\n\ngo 1.21\n\nrequire (\n\texisting v1.0.0\n\tnew/mod v0.1.0\n)\n"
    );
    const result = await checkDependencyDiff(repoDir, { path: "go.mod", diffRef: "HEAD" });
    expect(result.added.some((d) => d.name === "new/mod")).toBe(true);
  });

  it("skips // line comments in go.mod require block", async () => {
    await writeFile(
      join(repoDir, "go.mod"),
      "module test\n\ngo 1.21\n\nrequire (\n\texisting v1.0.0\n)\n"
    );
    await git.add(".");
    await git.commit("initial");
    // A commented-out require line must NOT be parsed as a dependency.
    await writeFile(
      join(repoDir, "go.mod"),
      "module test\n\ngo 1.21\n\nrequire (\n\texisting v1.0.0\n\t// new/mod v0.1.0\n)\n"
    );
    const result = await checkDependencyDiff(repoDir, { path: "go.mod", diffRef: "HEAD" });
    expect(result.added.some((d) => d.name === "new/mod")).toBe(false);
  });

  it("returns reason for unsupported manifest", async () => {
    const result = await checkDependencyDiff(repoDir, { path: "Cargo.toml", diffRef: "HEAD" });
    expect(result.added).toEqual([]);
    expect(result.reason).toMatch(/unsupported/i);
  });

  it("returns reason when file not found at ref", async () => {
    const result = await checkDependencyDiff(repoDir, { path: "package.json", diffRef: "HEAD" });
    expect(result.added).toEqual([]);
    expect(result.reason).toBeDefined();
  });
});
