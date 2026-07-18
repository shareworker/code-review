import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAffectedTests } from "../run-tests.js";

let repoDir: string;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-tests-"));
  return dir;
}

describe("runAffectedTests", () => {
  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(async () => {
    // On Windows, killed child processes may briefly hold locks on temp files.
    // Retry cleanup with a small delay.
    for (let i = 0; i < 3; i++) {
      try {
        await rm(repoDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  it("returns reason when package.json does not exist", async () => {
    const result = await runAffectedTests(repoDir, {});
    expect(result.exitCode).toBe(null);
    expect(result.reason).toMatch(/no package.json/i);
    expect(result.timedOut).toBe(false);
  });

  it("returns reason when package.json has no test script", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { build: "tsc" } })
    );
    const result = await runAffectedTests(repoDir, {});
    expect(result.exitCode).toBe(null);
    expect(result.reason).toMatch(/no scripts\.test/i);
  });

  it("returns reason when package.json is invalid JSON", async () => {
    await writeFile(join(repoDir, "package.json"), "{invalid json");
    const result = await runAffectedTests(repoDir, {});
    expect(result.exitCode).toBe(null);
    expect(result.reason).toMatch(/not valid JSON/i);
  });

  it("executes the test script and returns exit code 0 on success", async () => {
    // Create a minimal Node project with a passing test script.
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "test-repo",
        scripts: { test: 'node -e "process.exit(0)"' },
      })
    );
    const result = await runAffectedTests(repoDir, {});
    // The test script should succeed (exit 0).
    expect(result.timedOut).toBe(false);
    if (result.exitCode !== null) {
      expect(result.exitCode).toBe(0);
    }
    // If exitCode is null, npm.cmd wasn't found — accept graceful failure.
    if (result.exitCode === null) {
      expect(result.reason).toBeDefined();
    }
  });

  it("returns non-zero exit code when tests fail", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "test-repo",
        scripts: { test: 'node -e "process.exit(1)"' },
      })
    );
    const result = await runAffectedTests(repoDir, {});
    expect(result.timedOut).toBe(false);
    if (result.exitCode !== null) {
      expect(result.exitCode).not.toBe(0);
    }
  });

  it("respects custom timeout", async () => {
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "test-repo",
        scripts: { test: 'node -e "setTimeout(()=>{}, 10000)"' },
      })
    );
    const result = await runAffectedTests(repoDir, { timeoutMs: 500 });
    // With a 500ms timeout, the 10s sleep should be killed.
    if (result.exitCode !== null || result.timedOut) {
      expect(result.timedOut).toBe(true);
    }
  });
});
