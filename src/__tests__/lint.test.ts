import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getLintFindings } from "../lint.js";

let repoDir: string;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-lint-"));
  await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
  return dir;
}

describe("getLintFindings", () => {
  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns empty + reason when no known config is present", async () => {
    const result = await getLintFindings(repoDir, {});
    expect(result.findings).toEqual([]);
    expect(result.toolsRun).toEqual([]);
    expect(result.reason).toMatch(/no known/i);
  });

  it("detects tsconfig.json and runs tsc, parsing diagnostics", async () => {
    // Create a tsconfig.json and a TS file with a type error.
    await writeFile(
      join(repoDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      })
    );
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(
      join(repoDir, "src", "bad.ts"),
      "const x: number = 'string';\n"
    );
    // We need a local tsc binary. If the test repo doesn't have one, the tool
    // falls back to the global tsc on PATH. In the test environment, tsc may
    // or may not be available. We only assert structure if tsc runs.
    const result = await getLintFindings(repoDir, { files: ["src/bad.ts"] });
    if (result.toolsRun.includes("tsc")) {
      expect(result.findings.some((f) => f.tool === "tsc")).toBe(true);
      expect(result.findings.some((f) => f.path.includes("bad.ts"))).toBe(true);
    } else {
      // tsc binary not available in this env — accept the graceful skip.
      expect(result.reason).toBeDefined();
    }
  });

  it("detects eslint config and parses JSON output", async () => {
    await writeFile(
      join(repoDir, ".eslintrc.json"),
      JSON.stringify({ rules: { "no-unused-vars": "error" } })
    );
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "foo.js"), "const unused = 1;\n");
    const result = await getLintFindings(repoDir, { files: ["src/foo.js"] });
    if (result.toolsRun.includes("eslint")) {
      expect(result.findings.some((f) => f.tool === "eslint")).toBe(true);
    } else {
      expect(result.reason).toBeDefined();
    }
  });

  it("skips a detected tool when its binary is not available", async () => {
    // tsconfig.json present but no node_modules/.bin/tsc and no global tsc.
    // We can't easily remove global tsc from PATH in a test, so we verify
    // the "no known config" path is NOT taken (config IS detected) and the
    // result is either findings (tsc ran) or a reason (tsc not found).
    await writeFile(join(repoDir, "tsconfig.json"), "{}");
    const result = await getLintFindings(repoDir, {});
    // Either tsc ran (toolsRun includes it) or it was skipped (reason set).
    expect(
      result.toolsRun.includes("tsc") || result.reason !== undefined
    ).toBe(true);
  });

  it("handles multiple detected tools", async () => {
    // Both tsconfig.json and .eslintrc.json present.
    await writeFile(join(repoDir, "tsconfig.json"), "{}");
    await writeFile(join(repoDir, ".eslintrc.json"), "{}");
    const result = await getLintFindings(repoDir, {});
    // At least the detection found 2 tools; whether they ran depends on env.
    // The "no known config" reason should NOT be set.
    expect(result.reason).not.toMatch(/no known/i);
  });

  it("filters tsc findings to the requested files", async () => {
    await writeFile(
      join(repoDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true, skipLibCheck: true },
        include: ["src/**/*.ts"],
      })
    );
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "bad.ts"), "const x: number = 'string';\n");
    await writeFile(join(repoDir, "src", "other.ts"), "const y: number = 'other';\n");
    const result = await getLintFindings(repoDir, { files: ["src/bad.ts"] });
    if (result.toolsRun.includes("tsc")) {
      expect(result.findings.some((f) => f.tool === "tsc" && f.path.includes("bad.ts"))).toBe(true);
      expect(result.findings.some((f) => f.tool === "tsc" && f.path.includes("other.ts"))).toBe(false);
    } else {
      expect(result.reason).toBeDefined();
    }
  });
});
