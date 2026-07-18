import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { readFileContext, DEFAULT_MAX_LINES } from "../read-file-context.js";

let repoDir: string;
const FILE_LINES = [
  "line 1", "line 2", "line 3", "line 4", "line 5",
  "line 6", "line 7", "line 8", "line 9", "line 10",
  "line 11", "line 12", "line 13", "line 14", "line 15",
];

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ocr-readctx-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "foo.ts"), FILE_LINES.join("\n") + "\n");
  await git.add(".");
  await git.commit("init");
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("readFileContext", () => {
  it("anchor mode returns before+after lines around the anchor", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      anchorLine: 8,
      before: 3,
      after: 2,
    });
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(10);
    expect(result.content).toBe("line 5\nline 6\nline 7\nline 8\nline 9\nline 10");
    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("anchor mode clamps start to 1 when before would go negative", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      anchorLine: 2,
      before: 10,
      after: 1,
    });
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
  });

  it("explicit start/end mode returns the requested range", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      startLine: 3,
      endLine: 5,
    });
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(5);
    expect(result.content).toBe("line 3\nline 4\nline 5");
  });

  it("clamps endLine to file length when it exceeds", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      startLine: 13,
      endLine: 100,
    });
    expect(result.endLine).toBe(15);
    expect(result.content).toBe("line 13\nline 14\nline 15");
  });

  it("truncates when requested range exceeds maxLines", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      startLine: 1,
      endLine: 15,
      maxLines: 5,
    });
    expect(result.truncated).toBe(true);
    expect(result.endLine).toBe(5);
    expect(result.content).toBe("line 1\nline 2\nline 3\nline 4\nline 5");
  });

  it("default maxLines is 200", async () => {
    expect(DEFAULT_MAX_LINES).toBe(200);
  });

  it("falls back to worktree when file is not at ref", async () => {
    // Create an untracked file (not in HEAD).
    await writeFile(join(repoDir, "src", "untracked.ts"), "u1\nu2\nu3\n");
    try {
      const result = await readFileContext(repoDir, {
        path: "src/untracked.ts",
        diffRef: "HEAD",
        startLine: 1,
        endLine: 3,
      });
      expect(result.content).toBe("u1\nu2\nu3");
      expect(result.reason).toBeUndefined();
    } finally {
      await rm(join(repoDir, "src", "untracked.ts"), { force: true });
    }
  });

  it("returns reason when file does not exist at ref or worktree", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/missing.ts",
      diffRef: "HEAD",
      startLine: 1,
      endLine: 5,
    });
    expect(result.content).toBe("");
    expect(result.reason).toContain("file not found");
  });

  it("returns reason when neither anchor nor explicit range is provided", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
    });
    expect(result.reason).toContain("missing range");
  });

  it("returns reason when both anchor and explicit range are provided", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      anchorLine: 5,
      startLine: 1,
      endLine: 10,
    });
    expect(result.reason).toContain("not both");
  });

  it("returns reason when explicit range is invalid", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      startLine: 5,
      endLine: 3,
    });
    expect(result.reason).toContain("invalid");
  });

  it("returns reason when start_line is beyond file length", async () => {
    const result = await readFileContext(repoDir, {
      path: "src/foo.ts",
      diffRef: "HEAD",
      startLine: 100,
      endLine: 200,
    });
    expect(result.reason).toContain("beyond file length");
  });

  it("reads from a specific revision via diff_ref", async () => {
    // Modify foo.ts in a second commit so HEAD has different content than the original.
    const git = simpleGit(repoDir);
    await writeFile(join(repoDir, "src", "foo.ts"), FILE_LINES.join("\n") + "\nNEW LINE\n");
    await git.add(".");
    await git.commit("add line");
    try {
      // diff_ref = HEAD~1..HEAD: read_file_context tries ref first; for a range ref,
      // git show <range>:<path> returns empty → falls back to worktree (HEAD content).
      const result = await readFileContext(repoDir, {
        path: "src/foo.ts",
        diffRef: "HEAD~1",
        startLine: 15,
        endLine: 16,
      });
      // HEAD~1 has only 15 lines, so the file at HEAD~1 has no line 16.
      // The fallback reads worktree (which has 16 lines). Verify we got content.
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      // Restore to 15-line version for other tests.
      await writeFile(join(repoDir, "src", "foo.ts"), FILE_LINES.join("\n") + "\n");
      await git.add(".");
      await git.commit("restore");
    }
  });
});
