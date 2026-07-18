import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { searchCode, DEFAULT_MAX_RESULTS } from "../search-code.js";

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-search-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(
    join(repoDir, "src", "foo.ts"),
    ["export const a = 1;", "export const b = 2;", "export const c = 3;", ""].join("\n")
  );
  await writeFile(
    join(repoDir, "src", "bar.ts"),
    ["export function bar() {", "  return 'bar';", "}", ""].join("\n")
  );
  await writeFile(join(repoDir, "package-lock.json"), '{"locked": true}\n');
  await git.add(".");
  await git.commit("init");
  // Modify foo.ts in a second commit so HEAD~1..HEAD has a diff.
  await writeFile(
    join(repoDir, "src", "foo.ts"),
    ["export const a = 1;", "export const b = 20;", "export const c = 3;", ""].join("\n")
  );
  await git.add(".");
  await git.commit("change b");
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("searchCode", () => {
  it("workspace mode searches tracked files (HEAD)", async () => {
    const result = await searchCode(repoDir, {
      query: "export const b",
      diffRef: "HEAD",
    });
    expect(result.matches.some((m) => m.path === "src/foo.ts" && m.line === 2)).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("workspace mode includes untracked files", async () => {
    // Add an untracked file containing the query.
    await writeFile(join(repoDir, "src", "untracked.ts"), "export const UNTRACKED_MARKER = 1;\n");
    try {
      const result = await searchCode(repoDir, {
        query: "UNTRACKED_MARKER",
        diffRef: "HEAD",
      });
      expect(result.matches.some((m) => m.path === "src/untracked.ts")).toBe(true);
    } finally {
      await rm(join(repoDir, "src", "untracked.ts"), { force: true });
    }
  });

  it("range mode searches the 'to' revision, not the worktree", async () => {
    // Make a worktree-only change that should NOT appear in range search.
    await writeFile(
      join(repoDir, "src", "foo.ts"),
      ["export const a = 1;", "export const b = 20;", "export const c = 3;", "export const WORKTREE_ONLY = 1;", ""].join("\n")
    );
    try {
      const rangeResult = await searchCode(repoDir, {
        query: "WORKTREE_ONLY",
        diffRef: "HEAD~1..HEAD",
      });
      expect(rangeResult.matches).toEqual([]);
      // But workspace mode finds it.
      const wsResult = await searchCode(repoDir, {
        query: "WORKTREE_ONLY",
        diffRef: "HEAD",
      });
      expect(wsResult.matches.some((m) => m.path === "src/foo.ts")).toBe(true);
    } finally {
      // Restore foo.ts to committed state.
      await writeFile(
        join(repoDir, "src", "foo.ts"),
        ["export const a = 1;", "export const b = 20;", "export const c = 3;", ""].join("\n")
      );
    }
  });

  it("range mode finds content present at the 'to' revision", async () => {
    const result = await searchCode(repoDir, {
      query: "export const b = 20",
      diffRef: "HEAD~1..HEAD",
    });
    expect(result.matches.some((m) => m.path === "src/foo.ts" && m.line === 2)).toBe(true);
  });

  it("applies filters.exclude from .code-review/rules.json", async () => {
    // Write a rules.json that excludes package-lock.json (already in DEFAULT_EXCLUDE,
    // but we add an explicit custom exclude for a .ts file to prove the mechanism).
    await mkdir(join(repoDir, ".code-review"), { recursive: true });
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({ filters: { exclude: ["**/bar.ts"] } })
    );
    try {
      const result = await searchCode(repoDir, {
        query: "function bar",
        diffRef: "HEAD",
      });
      expect(result.matches.every((m) => m.path !== "src/bar.ts")).toBe(true);
    } finally {
      await rm(join(repoDir, ".code-review"), { recursive: true, force: true });
    }
  });

  it("truncates results at max_results and reports totalMatches", async () => {
    // Query that matches many lines across files.
    const result = await searchCode(repoDir, {
      query: "export",
      diffRef: "HEAD",
      maxResults: 1,
    });
    expect(result.matches.length).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.totalMatches).toBeGreaterThan(1);
  });

  it("default max_results is 50", async () => {
    expect(DEFAULT_MAX_RESULTS).toBe(50);
  });

  it("returns empty matches with reason for no-match queries", async () => {
    const result = await searchCode(repoDir, {
      query: "THIS_STRING_DOES_NOT_EXIST_ANYWHERE_12345",
      diffRef: "HEAD",
    });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns empty matches with reason when repo is not a git repo", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "ocr-search-nongit-"));
    try {
      const result = await searchCode(nonRepo, {
        query: "anything",
        diffRef: "HEAD",
      });
      expect(result.matches).toEqual([]);
      expect(result.reason).toContain("not a git repository");
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });

  it("returns empty matches with reason for empty query", async () => {
    const result = await searchCode(repoDir, {
      query: "",
      diffRef: "HEAD",
    });
    expect(result.matches).toEqual([]);
    expect(result.reason).toContain("empty query");
  });

  it("path_glob restricts search to matching paths", async () => {
    const result = await searchCode(repoDir, {
      query: "export",
      diffRef: "HEAD",
      pathGlob: "src/foo.ts",
    });
    expect(result.matches.every((m) => m.path === "src/foo.ts")).toBe(true);
  });

  it("queries starting with - are treated as patterns, not git grep options", async () => {
    // Without `-e`, a query like `--version` would be interpreted by git grep as
    // an option and no search would be performed. With `-e`, it is a pattern.
    await writeFile(join(repoDir, "src", "dash.ts"), "// --version marker\n");
    try {
      const result = await searchCode(repoDir, {
        query: "--version",
        diffRef: "HEAD",
      });
      expect(result.matches.some((m) => m.path === "src/dash.ts")).toBe(true);
      expect(result.reason).toBeUndefined();
    } finally {
      await rm(join(repoDir, "src", "dash.ts"), { force: true });
    }
  });
});
