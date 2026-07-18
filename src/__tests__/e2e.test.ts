import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { getDiff, getDiffSummary, getUntrackedFiles, synthesizeUntrackedDiff } from "../git.js";
import { parseFileDiffs } from "../diff-parser.js";
import { loadFilterConfig, filterFiles } from "../filter.js";
import { bundleFiles } from "../bundler.js";
import { matchRules } from "../rules.js";
import { positionComment } from "../position.js";
import { reflectComment } from "../reflect.js";
import { searchCode } from "../search-code.js";
import { readFileContext } from "../read-file-context.js";

/**
 * End-to-end integration test: create a test repo with known bugs,
 * exercise all 5 tools in the correct pipeline order, and verify the
 * deterministic layer produces correct results.
 *
 * Bug types planted:
 * - Null handling omission (user.ts) — validates match_rules TS rule + host detection
 * - SQL injection (auth.ts) — validates security rule match
 * - Test + source changed together (user.ts + user.test.ts) — validates bundler pairing
 * - i18n files changed together (messages_en.ts + messages_zh.ts) — validates i18n bundling
 * - One clean file (utils.ts) — validates reflect_comment line_in_hunk prevents false positives
 */

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-e2e-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");

  // Create directory structure.
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "i18n"), { recursive: true });

  // Initial commit: clean files.
  await writeFile(join(repoDir, "src", "user.ts"), "export function getUser(id: number): any {\n  return fetch(`/api/users/${id}`);\n}\n");
  await writeFile(join(repoDir, "src", "user.test.ts"), "import { getUser } from './user';\ntest('getUser', () => {\n  expect(getUser(1)).toBeDefined();\n});\n");
  await writeFile(join(repoDir, "src", "auth.ts"), "export function login(user: string, pass: string): boolean {\n  return user.length > 0 && pass.length > 0;\n}\n");
  await writeFile(join(repoDir, "src", "utils.ts"), "export function clamp(v: number, min: number, max: number): number {\n  return Math.max(min, Math.min(max, v));\n}\n");
  await writeFile(join(repoDir, "i18n", "messages_en.ts"), "export const messages = {\n  hello: 'Hello',\n  goodbye: 'Goodbye',\n};\n");
  await writeFile(join(repoDir, "i18n", "messages_zh.ts"), "export const messages = {\n  hello: '你好',\n  goodbye: '再见',\n};\n");
  await writeFile(join(repoDir, "package.json"), '{"name": "test-repo", "version": "1.0.0"}\n');
  await git.add(".");
  await git.commit("init");

  // Second commit: introduce bugs and changes.
  // user.ts: null handling bug (returns any, no null check)
  await writeFile(join(repoDir, "src", "user.ts"), "export function getUser(id: number): any {\n  const data = fetch(`/api/users/${id}`);\n  return data.json();\n}\n\nexport function getUserSafe(id: number | null): unknown {\n  if (id === null) return null;\n  return fetch(`/api/users/${id}`).then(r => r.json());\n}\n");
  // user.test.ts: add test for new function
  await writeFile(join(repoDir, "src", "user.test.ts"), "import { getUser, getUserSafe } from './user';\ntest('getUser', () => {\n  expect(getUser(1)).toBeDefined();\n});\ntest('getUserSafe handles null', () => {\n  expect(getUserSafe(null)).toBeNull();\n});\n");
  // auth.ts: SQL injection risk
  await writeFile(join(repoDir, "src", "auth.ts"), "export function login(user: string, pass: string): boolean {\n  const query = `SELECT * FROM users WHERE name='${user}' AND pass='${pass}'`;\n  return db.query(query).length > 0;\n}\n");
  // utils.ts: clean change (just formatting)
  await writeFile(join(repoDir, "src", "utils.ts"), "export function clamp(v: number, min: number, max: number): number {\n  return Math.max(min, Math.min(max, v));\n}\n\nexport function wrap(v: number, max: number): number {\n  return v % max;\n}\n");
  // i18n: add new keys
  await writeFile(join(repoDir, "i18n", "messages_en.ts"), "export const messages = {\n  hello: 'Hello',\n  goodbye: 'Goodbye',\n  welcome: 'Welcome',\n};\n");
  await writeFile(join(repoDir, "i18n", "messages_zh.ts"), "export const messages = {\n  hello: '你好',\n  goodbye: '再见',\n  welcome: '欢迎',\n};\n");
  await git.add(".");
  await git.commit("introduce bugs and changes");
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("end-to-end pipeline", () => {
  const diffRef = "HEAD~1..HEAD";

  it("step 1: get_review_targets returns all changed files with diff_ref", async () => {
    const diff = await getDiff(repoDir, diffRef);
    const fileDiffs = parseFileDiffs(diff);
    const allPaths = fileDiffs.map((d) => d.newPath || d.oldPath).filter(Boolean);
    expect(allPaths).toContain("src/user.ts");
    expect(allPaths).toContain("src/user.test.ts");
    expect(allPaths).toContain("src/auth.ts");
    expect(allPaths).toContain("src/utils.ts");
    expect(allPaths).toContain("i18n/messages_en.ts");
    expect(allPaths).toContain("i18n/messages_zh.ts");
  });

  it("step 2: get_file_bundle pairs test/source and i18n variants", async () => {
    const files = ["src/user.ts", "src/user.test.ts", "src/auth.ts", "src/utils.ts", "i18n/messages_en.ts", "i18n/messages_zh.ts"];
    const bundles = await bundleFiles(repoDir, files, diffRef);
    // user.ts + user.test.ts should be paired
    const userBundle = bundles.find((b) => b.files.some((f) => f.path === "src/user.ts"));
    expect(userBundle?.bundleReason).toBe("test_source_pair");
    expect(userBundle?.files.map((f) => f.path)).toContain("src/user.test.ts");
    // i18n files should be paired
    const i18nBundle = bundles.find((b) => b.files.some((f) => f.path === "i18n/messages_en.ts"));
    expect(i18nBundle?.bundleReason).toBe("i18n_variants");
    expect(i18nBundle?.files.map((f) => f.path)).toContain("i18n/messages_zh.ts");
    // auth.ts and utils.ts should be singletons
    const authBundle = bundles.find((b) => b.files.some((f) => f.path === "src/auth.ts"));
    expect(authBundle?.bundleReason).toBe("single_file");
  });

  it("step 3a: match_rules returns TS rule for .ts files", async () => {
    const result = await matchRules(repoDir, "src/user.ts");
    // No rules.json in test repo → built-in language-specific TS/JS rule
    expect(result.usedDefault).toBe(true);
    expect(result.promptSection).toContain("TypeScript / JavaScript");
  });

  it("step 3b: position_comment locates a comment on the SQL injection", async () => {
    const result = await positionComment(repoDir, {
      path: "src/auth.ts",
      content: "SQL injection risk: user input concatenated into query",
      existingCode: "const query = `SELECT * FROM users WHERE name='${user}' AND pass='${pass}'`;",
      diffRef,
    });
    expect(result.locatedBy).toBe("text_match");
    expect(result.startLine).toBeGreaterThan(0);
  });

  it("step 3c: reflect_comment keeps a comment on changed lines", async () => {
    const positioned = await positionComment(repoDir, {
      path: "src/auth.ts",
      content: "SQL injection risk",
      existingCode: "const query = `SELECT * FROM users WHERE name='${user}' AND pass='${pass}'`;",
      diffRef,
    });
    const reflected = await reflectComment(repoDir, {
      path: "src/auth.ts",
      content: "SQL injection risk",
      startLine: positioned.startLine,
      endLine: positioned.endLine,
      existingCode: "const query = `SELECT * FROM users WHERE name='${user}' AND pass='${pass}'`;",
      diffRef,
    });
    expect(reflected.verdict).toBe("keep");
  });

  it("step 3d: reflect_comment drops a comment on unchanged lines (clean file)", async () => {
    // utils.ts had a clean change (added wrap function), but comment references clamp (unchanged).
    const positioned = await positionComment(repoDir, {
      path: "src/utils.ts",
      content: "clamp function could be simplified",
      existingCode: "export function clamp(v: number, min: number, max: number): number {",
      diffRef,
    });
    // Even if positioning succeeds, reflect should drop if the line isn't in the hunk.
    const reflected = await reflectComment(repoDir, {
      path: "src/utils.ts",
      content: "clamp function could be simplified",
      startLine: positioned.startLine,
      endLine: positioned.endLine,
      existingCode: "export function clamp(v: number, min: number, max: number): number {",
      diffRef,
    });
    // The clamp function is unchanged context — line_in_hunk should fail.
    expect(reflected.verdict).toBe("drop");
  });

  it("step 3e: reflect_comment handles new-file scenario (vacuous line_in_hunk)", async () => {
    // Create a new untracked file.
    await writeFile(join(repoDir, "src", "new.ts"), "export const x: any = null;\n");
    const synthDiff = await synthesizeUntrackedDiff(repoDir, "src/new.ts");
    expect(synthDiff).toContain("new file mode");
    // Reflect on the new file: all lines are "changed", so line_in_hunk passes.
    const reflected = await reflectComment(repoDir, {
      path: "src/new.ts",
      content: "x should not be any",
      startLine: 1,
      endLine: 1,
      existingCode: "export const x: any = null;",
      diffRef: "HEAD", // workspace mode
    });
    expect(reflected.verdict).toBe("keep");
  });

  // --- New tools: search_code and read_file_context ---

  it("step 4a: search_code finds cross-file matches in range mode", async () => {
    const result = await searchCode(repoDir, {
      query: "getUser",
      diffRef,
    });
    // getUser is defined in user.ts and used in user.test.ts.
    expect(result.matches.some((m) => m.path === "src/user.ts")).toBe(true);
    expect(result.matches.some((m) => m.path === "src/user.test.ts")).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("step 4b: search_code respects filters.exclude", async () => {
    // package.json is in the repo and matches "name" but should be excluded by
    // DEFAULT_EXCLUDE? Actually package.json is NOT in DEFAULT_EXCLUDE. Let's
    // verify search finds it, then exclude it explicitly.
    const before = await searchCode(repoDir, {
      query: "test-repo",
      diffRef,
    });
    expect(before.matches.some((m) => m.path === "package.json")).toBe(true);

    // Now add an exclude rule and verify it's filtered out.
    await mkdir(join(repoDir, ".code-review"), { recursive: true });
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({ filters: { exclude: ["**/package.json"] } })
    );
    try {
      const after = await searchCode(repoDir, {
        query: "test-repo",
        diffRef,
      });
      expect(after.matches.every((m) => m.path !== "package.json")).toBe(true);
    } finally {
      await rm(join(repoDir, ".code-review"), { recursive: true, force: true });
    }
  });

  it("step 4c: read_file_context returns anchored context for evidence gathering", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/user.ts",
      diffRef,
      anchorLine: 1,
      before: 0,
      after: 2,
    });
    expect(result.startLine).toBe(1);
    expect(result.content).toContain("getUser");
    expect(result.truncated).toBe(false);
  });

  it("step 4d: read_file_context returns explicit range", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/auth.ts",
      diffRef,
      startLine: 1,
      endLine: 3,
    });
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.content).toContain("login");
  });

  it("step 4e: reflect_comment with evidence keeps a comment when evidence exists", async () => {
    // Comment on user.ts referencing auth.ts's login function as evidence.
    // Use the changed line (const data = ...) as existingCode so line_in_hunk passes.
    const positioned = await positionComment(repoDir, {
      path: "src/user.ts",
      content: "getUser should check auth via login()",
      existingCode: "const data = fetch(`/api/users/${id}`);",
      diffRef,
    });
    const reflected = await reflectComment(repoDir, {
      path: "src/user.ts",
      content: "getUser should check auth via login()",
      startLine: positioned.startLine,
      endLine: positioned.endLine,
      existingCode: "const data = fetch(`/api/users/${id}`);",
      diffRef,
      evidence: [
        {
          path: "src/auth.ts",
          snippet: "export function login(user: string, pass: string): boolean {",
        },
      ],
    });
    expect(reflected.verdict).toBe("keep");
    const evidenceCheck = reflected.checks.find((c) => c.name === "evidence_valid");
    expect(evidenceCheck?.passed).toBe(true);
  });

  it("step 4f: reflect_comment with evidence drops a comment when evidence snippet is fabricated", async () => {
    const positioned = await positionComment(repoDir, {
      path: "src/user.ts",
      content: "getUser should check auth via login()",
      existingCode: "const data = fetch(`/api/users/${id}`);",
      diffRef,
    });
    const reflected = await reflectComment(repoDir, {
      path: "src/user.ts",
      content: "getUser should check auth via login()",
      startLine: positioned.startLine,
      endLine: positioned.endLine,
      existingCode: "const data = fetch(`/api/users/${id}`);",
      diffRef,
      evidence: [
        {
          path: "src/auth.ts",
          snippet: "this function does not exist in auth.ts",
        },
      ],
    });
    expect(reflected.verdict).toBe("drop");
    const evidenceCheck = reflected.checks.find((c) => c.name === "evidence_valid");
    expect(evidenceCheck?.passed).toBe(false);
  });
});
