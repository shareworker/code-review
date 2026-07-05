import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { positionComment } from "../position.js";

let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-pos-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(
    join(repoDir, "src", "foo.ts"),
    ["export const a = 1;", "export const b = 2;", "export const c = 3;", "export const d = 4;", ""].join("\n")
  );
  await git.add(".");
  await git.commit("init");
  // Modify: change line 2 and add a line after.
  await writeFile(
    join(repoDir, "src", "foo.ts"),
    ["export const a = 1;", "export const b = 20;", "export const c = 3;", "export const d = 4;", "export const e = 5;", ""].join("\n")
  );
  await git.add(".");
  await git.commit("change b and add e");
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("positionComment", () => {
  const diffRef = "HEAD~1..HEAD";

  it("matches on hunk new-side with existing_code", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "b should be 20",
      existingCode: "export const b = 20;",
      diffRef,
    });
    expect(result.locatedBy).toBe("text_match");
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(2);
  });

  it("matches multiple consecutive lines", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "block",
      existingCode: "export const b = 20;\nexport const c = 3;",
      diffRef,
    });
    expect(result.locatedBy).toBe("text_match");
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
  });

  it("matches on old-side when existing_code references deleted lines", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "old b value",
      existingCode: "export const b = 2;",
      diffRef,
    });
    expect(result.locatedBy).toBe("text_match");
    // old-side line numbers: line 2 in the old file
    expect(result.startLine).toBe(2);
  });

  it("falls back to full file content when not in hunk", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "a is fine",
      existingCode: "export const a = 1;",
      diffRef,
    });
    expect(result.locatedBy).toBe("text_match");
    expect(result.startLine).toBe(1);
  });

  it("uses hunk alignment when only hint_line is provided", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "change near line 2",
      hintLine: 2,
      diffRef,
    });
    expect(result.locatedBy).toBe("hunk_align");
    expect(result.startLine).toBe(2);
  });

  it("returns failed when no code and no hint_line", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "vague comment",
      diffRef,
    });
    expect(result.locatedBy).toBe("failed");
    expect(result.startLine).toBe(0);
    expect(result.endLine).toBe(0);
  });

  it("returns failed when file does not exist", async () => {
    const result = await positionComment(repoDir, {
      path: "src/nonexistent.ts",
      content: "comment",
      existingCode: "some code",
      diffRef,
    });
    expect(result.locatedBy).toBe("failed");
  });

  it("returns failed when existing_code not found anywhere", async () => {
    const result = await positionComment(repoDir, {
      path: "src/foo.ts",
      content: "comment",
      existingCode: "this code does not exist anywhere",
      diffRef,
    });
    expect(result.locatedBy).toBe("failed");
  });

  it("normalizes backslashes in path", async () => {
    const result = await positionComment(repoDir, {
      path: "src\\foo.ts",
      content: "b",
      existingCode: "export const b = 20;",
      diffRef,
    });
    expect(result.path).toBe("src/foo.ts");
    expect(result.locatedBy).toBe("text_match");
  });
});
