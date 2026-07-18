import simpleGit from "simple-git";
import type { SimpleGit } from "simple-git";

/** File-level metadata from `git diff --summary`. */
export interface DiffFileSummary {
  file: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/** Porcelain status entry for a file. */
export interface StatusEntry {
  path: string;
  /** "untracked" | "modified" | "added" | "deleted" | "renamed" | "staged" */
  status: string;
}

/**
 * Open a simple-git instance for a repo path.
 * Falls back to cwd when repo is empty.
 */
export function openRepo(repo?: string): SimpleGit {
  return simpleGit(repo || process.cwd());
}

/**
 * Get the unified diff text for a ref.
 * `ref` may be a range like "main..feature" or a single ref like "HEAD".
 */
export async function getDiff(repo: string, ref: string): Promise<string> {
  const git = openRepo(repo);
  return git.diff([ref]);
}

/**
 * Get the unified diff text for a single file at a ref.
 * Uses `git diff <ref> -- <path>` to scope to one file.
 */
export async function getDiffForFile(
  repo: string,
  ref: string,
  path: string
): Promise<string> {
  const git = openRepo(repo);
  return git.diff([ref, "--", path]);
}

/**
 * Get file-level diff metadata (insertions/deletions/binary) for a ref.
 */
export async function getDiffSummary(
  repo: string,
  ref: string
): Promise<DiffFileSummary[]> {
  const git = openRepo(repo);
  const summary = await git.diffSummary([ref]);
  return summary.files.map((f) => ({
    file: f.file,
    insertions: "insertions" in f ? f.insertions : 0,
    deletions: "deletions" in f ? f.deletions : 0,
    binary: f.binary,
  }));
}

/**
 * Resolve a diff_ref to the ref that contains the "after" (post-change)
 * file content. This is the side of the diff where new/added lines live.
 * - "HEAD" or any single ref (workspace / git-diff <ref> mode) → "WORKTREE"
 * - "from..to" (range mode) → "to"
 * - "commit^..commit" (commit mode) → "commit"
 */
export function resolvePostRef(diffRef: string): string {
  if (diffRef === "HEAD") return "WORKTREE";
  const rangeMatch = diffRef.match(/^(.+?)\.\.(.+)$/);
  if (rangeMatch) return rangeMatch[2];
  return "WORKTREE";
}

/**
 * Resolve a diff_ref to the ref that contains the "before" (pre-change)
 * file content.
 * - "HEAD" or any single ref (workspace / git-diff <ref> mode) → the ref itself
 * - "from..to" (range mode) → "from"
 * - "commit^..commit" (commit mode) → "commit^"
 */
export function resolvePreRef(diffRef: string): string {
  if (diffRef === "HEAD") return "HEAD";
  const rangeMatch = diffRef.match(/^(.+?)\.\.(.+)$/);
  if (rangeMatch) return rangeMatch[1];
  return diffRef;
}

/**
 * Get the content of a file at a given ref (e.g. "HEAD", "main", "WORKTREE").
 * For untracked files or the current worktree, pass ref="WORKTREE".
 */
export async function getFileContent(
  repo: string,
  ref: string,
  path: string
): Promise<string> {
  if (ref === "WORKTREE") {
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const abs = nodePath.isAbsolute(path)
      ? path
      : nodePath.join(repo || process.cwd(), path);
    return fs.readFile(abs, "utf8");
  }
  const git = openRepo(repo);
  return git.show([`${ref}:${path}`]);
}

/**
 * Get porcelain status for untracked file detection.
 * Returns entries with status "untracked" for files git doesn't track.
 */
export async function getStatus(repo: string): Promise<StatusEntry[]> {
  const git = openRepo(repo);
  const status = await git.status();
  const entries: StatusEntry[] = [];
  for (const f of status.files) {
    // status.files entries have `path` and `index`/`working_dir` status codes.
    // Untracked files have working_dir == "?".
    const isUntracked = f.working_dir === "?" || f.index === "?";
    entries.push({
      path: f.path,
      status: isUntracked ? "untracked" : "modified",
    });
  }
  return entries;
}

/**
 * List untracked files (not yet `git add`-ed).
 */
export async function getUntrackedFiles(repo: string): Promise<string[]> {
  const git = openRepo(repo);
  const status = await git.status();
  return status.not_added;
}

/**
 * Heuristic binary-content detector for files that have no diff to summarize
 * (e.g. untracked files, where `diffSummary`'s binary flag isn't available).
 * Mirrors git's own "NUL byte in the first 8000 bytes" heuristic.
 */
export function isLikelyBinaryContent(content: string): boolean {
  const sample = content.slice(0, 8000);
  return sample.includes("\u0000");
}

/**
 * Synthesize a full-file-add diff for an untracked file,
 * equivalent to `git diff --no-index /dev/null <file>`.
 * Reads the file content and wraps it in a unified diff with all lines added.
 * Returns an empty string for binary content (nothing meaningful to diff).
 */
export async function synthesizeUntrackedDiff(
  repo: string,
  path: string
): Promise<string> {
  let content: string;
  try {
    content = await getFileContent(repo, "WORKTREE", path);
  } catch {
    // File unreadable: return empty diff.
    return "";
  }
  if (isLikelyBinaryContent(content)) return "";
  const lines = content.split("\n");
  // Drop trailing empty line from the final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const body = lines.map((l) => `+${l}`).join("\n");
  const header = [
    `diff --git a/${path} b/${path}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join("\n");
  const diff = lines.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
  return diff;
}

/**
 * Get the diff for a single file at a ref, falling back to a synthesized
 * full-file-add diff when the file is untracked.
 *
 * `git diff <ref> -- <path>` returns an empty string both for "file untracked"
 * and for "file unchanged in this ref range" — those are different situations
 * and must not be conflated. This helper disambiguates by explicitly checking
 * `git status` rather than assuming emptiness means "untracked".
 */
export async function getDiffForFileOrSynthesize(
  repo: string,
  ref: string,
  path: string
): Promise<string> {
  const diff = await getDiffForFile(repo, ref, path);
  if (diff) return diff;
  const untracked = await getUntrackedFiles(repo);
  if (untracked.includes(path)) {
    return synthesizeUntrackedDiff(repo, path);
  }
  return "";
}
