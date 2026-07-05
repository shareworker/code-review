import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { reflectComment } from "../reflect.js";

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-reflect-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(
    join(repoDir, "src", "foo.ts"),
    ["export const a = 1;", "export const b = 2;", "export const c = 3;", ""].join("\n")
  );
  await git.add(".");
  await git.commit("init");
  // Modify line 2.
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

describe("reflectComment", () => {
  const diffRef = "HEAD~1..HEAD";

  it("returns keep when all checks pass", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "b should be 20",
      startLine: 2,
      endLine: 2,
      existingCode: "export const b = 20;",
      diffRef,
    });
    expect(result.verdict).toBe("keep");
    expect(result.reason).toBe("passed all checks");
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("finds existing_code that spans a blank line", async () => {
    // Isolated repo so we don't disturb the shared HEAD~1..HEAD tests.
    const spacedRepo = await mkdtemp(join(tmpdir(), "ocr-reflect-spaced-"));
    const git = simpleGit(spacedRepo);
    await git.init();
    await git.addConfig("user.email", "test@test.com");
    await git.addConfig("user.name", "Test");
    await writeFile(join(spacedRepo, "spaced.ts"), "export const z = 0;\n");
    await git.add(".");
    await git.commit("init");
    // Add two changed lines separated by a blank line.
    await writeFile(
      join(spacedRepo, "spaced.ts"),
      ["export const z = 0;", "export const x = 1;", "", "export const y = 2;", ""].join("\n")
    );
    await git.add(".");
    await git.commit("add spaced");
    const result = await reflectComment(spacedRepo, {
      path: "spaced.ts",
      content: "x and y block",
      startLine: 2,
      endLine: 4,
      // existing_code contains a blank line between the two code lines.
      existingCode: "export const x = 1;\n\nexport const y = 2;",
      diffRef: "HEAD~1..HEAD",
    });
    expect(result.checks[1].passed).toBe(true); // existing_code_found despite blank line
    await rm(spacedRepo, { recursive: true, force: true });
  });

  it("returns drop when line not in hunk (comment on unchanged line)", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "a is fine",
      startLine: 1,
      endLine: 1,
      existingCode: "export const a = 1;",
      diffRef,
    });
    expect(result.verdict).toBe("drop");
    expect(result.checks[0].passed).toBe(false); // line_in_hunk
  });

  it("returns drop when existing_code not found in file", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "comment",
      startLine: 2,
      endLine: 2,
      existingCode: "this code does not exist",
      diffRef,
    });
    expect(result.verdict).toBe("drop");
    expect(result.checks[1].passed).toBe(false); // existing_code_found
  });

  it("returns drop when existing_code not in diff (references unchanged context)", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "comment on a",
      startLine: 2,
      endLine: 2,
      existingCode: "export const a = 1;", // line 1, unchanged
      diffRef,
    });
    expect(result.verdict).toBe("drop");
    expect(result.checks[2].passed).toBe(false); // existing_code_in_diff
  });

  it("only checks line_in_hunk when existing_code is absent", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "comment without code",
      startLine: 2,
      endLine: 2,
      diffRef,
    });
    expect(result.verdict).toBe("keep");
    expect(result.checks[1].passed).toBe(true); // not applicable → passes
    expect(result.checks[2].passed).toBe(true); // not applicable → passes
  });

  it("returns drop when positioning failed (0,0)", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "comment",
      startLine: 0,
      endLine: 0,
      existingCode: "export const b = 20;",
      diffRef,
    });
    expect(result.verdict).toBe("drop");
    expect(result.checks[0].passed).toBe(false); // line_in_hunk
  });

  it("returns drop when file does not exist", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/nonexistent.ts",
      content: "comment",
      startLine: 1,
      endLine: 1,
      existingCode: "some code",
      diffRef,
    });
    expect(result.verdict).toBe("drop");
    expect(result.reason).toBe("file not found");
    expect(result.checks.every((c) => !c.passed)).toBe(true);
  });

  it("returns drop when diff_ref is invalid", async () => {
    const result = await reflectComment(repoDir, {
      path: "src/foo.ts",
      content: "comment",
      startLine: 2,
      endLine: 2,
      existingCode: "export const b = 20;",
      diffRef: "invalidref..alsogone",
    });
    expect(result.verdict).toBe("drop");
    expect(result.checks[0].passed).toBe(false); // line_in_hunk (no diff)
  });

  it("passes vacuously for new files (all lines changed)", async () => {
    // Create a new file scenario.
    await writeFile(join(repoDir, "src", "new.ts"), "export const x = 1;\n");
    await git_add(repoDir);
    const result = await reflectComment(repoDir, {
      path: "src/new.ts",
      content: "comment on new file",
      startLine: 1,
      endLine: 1,
      existingCode: "export const x = 1;",
      diffRef: "HEAD", // workspace mode: staged new file
    });
    expect(result.verdict).toBe("keep");
  });
});

// Helper to stage a file in the test repo.
async function git_add(repoDir: string) {
  const git = simpleGit(repoDir);
  await git.add(".");
}
