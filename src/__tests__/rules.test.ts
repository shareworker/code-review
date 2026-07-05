import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchRules, BUILT_IN_DEFAULT_RULE } from "../rules.js";

describe("matchRules", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ocr-rules-"));
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns built-in default when no rules.json exists", async () => {
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(true);
    expect(result.matchedRules).toEqual([]);
    expect(result.promptSection).toBe(BUILT_IN_DEFAULT_RULE);
  });

  it("matches a user rule by glob pattern", async () => {
    await mkdir(join(repoDir, ".code-review"), { recursive: true });
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [
          { path: "**/*.ts", rule: "Check for any types and proper null handling" },
          { path: "**/*.xml", rule: "Check SQL for injection risks" },
        ],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(false);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].pattern).toBe("**/*.ts");
    expect(result.promptSection).toContain("Check for any types");
  });

  it("uses first match wins when multiple patterns match", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [
          { path: "**/*.ts", rule: "First rule" },
          { path: "**/foo.ts", rule: "Second rule" },
        ],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.matchedRules[0].rule).toBe("First rule");
  });

  it("falls back to default when no rule matches", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.go", rule: "Go rule" }],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(true);
    expect(result.promptSection).toBe(BUILT_IN_DEFAULT_RULE);
  });

  it("falls back to default when rules.json is unparseable", async () => {
    await writeFile(join(repoDir, ".code-review", "rules.json"), "{ invalid json }");
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(true);
    expect(result.promptSection).toBe(BUILT_IN_DEFAULT_RULE);
  });

  it("normalizes backslashes in path", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.ts", rule: "TS rule" }],
      })
    );
    const result = await matchRules(repoDir, "src\\foo.ts");
    expect(result.path).toBe("src/foo.ts");
    expect(result.usedDefault).toBe(false);
  });

  it("matches case-insensitively", async () => {
    await writeFile(
      join(repoDir, ".code-review", "rules.json"),
      JSON.stringify({
        rules: [{ path: "**/*.TS", rule: "Upper rule" }],
      })
    );
    const result = await matchRules(repoDir, "src/foo.ts");
    expect(result.usedDefault).toBe(false);
  });
});

describe("BUILT_IN_DEFAULT_RULE", () => {
  it("covers the five review dimensions", () => {
    expect(BUILT_IN_DEFAULT_RULE).toContain("Correctness");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Security");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Performance");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Maintainability");
    expect(BUILT_IN_DEFAULT_RULE).toContain("Test Coverage");
  });
});
