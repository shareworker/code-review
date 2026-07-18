import { getFileContent } from "./git.js";
import type { ReadFileContextInput, ReadFileContextResult } from "./types.js";

/** Default cap on the number of lines returned. */
export const DEFAULT_MAX_LINES = 200;
/** Default lines before the anchor when not specified. */
const DEFAULT_BEFORE = 10;
/** Default lines after the anchor when not specified. */
const DEFAULT_AFTER = 10;

/**
 * Read a bounded slice of a file's content for cross-file evidence gathering.
 *
 * Two mutually exclusive range modes:
 * - anchor mode: `anchorLine` + optional `before`/`after` (defaults 10/10)
 * - explicit mode: `startLine` + `endLine`
 *
 * Reads via the same ref-then-worktree fallback as `position_comment`/`reflect_comment`:
 * tries `diff_ref` first, falls back to `WORKTREE` when the file is not present at the ref.
 * Caps output at `maxLines` (default 200); `truncated=true` when capped.
 *
 * Never throws — missing file or invalid range returns an empty result with `reason`.
 */
export async function readFileContext(
  repo: string,
  input: ReadFileContextInput
): Promise<ReadFileContextResult> {
  const path = (input.path ?? "").replace(/\\/g, "/");
  const diffRef = input.diffRef ?? "HEAD";
  const maxLines = input.maxLines && input.maxLines > 0
    ? Math.floor(input.maxLines)
    : DEFAULT_MAX_LINES;

  if (!path) {
    return emptyResult(path, diffRef, "missing path");
  }

  // Resolve the requested line range.
  let startLine: number;
  let endLine: number;
  const hasAnchor = typeof input.anchorLine === "number";
  const hasExplicit = typeof input.startLine === "number" && typeof input.endLine === "number";

  if (hasAnchor && hasExplicit) {
    return emptyResult(path, diffRef, "provide either anchor_line or start_line/end_line, not both");
  }
  if (!hasAnchor && !hasExplicit) {
    return emptyResult(path, diffRef, "missing range: provide anchor_line or start_line+end_line");
  }

  if (hasAnchor) {
    const anchor = Math.floor(input.anchorLine!);
    if (anchor < 1) {
      return emptyResult(path, diffRef, "anchor_line must be >= 1");
    }
    const before = input.before ?? DEFAULT_BEFORE;
    const after = input.after ?? DEFAULT_AFTER;
    startLine = Math.max(1, anchor - before);
    endLine = anchor + after;
  } else {
    startLine = Math.floor(input.startLine!);
    endLine = Math.floor(input.endLine!);
    if (startLine < 1 || endLine < startLine) {
      return emptyResult(path, diffRef, "invalid start_line/end_line range");
    }
  }

  // Read file content: try ref first, then worktree (mirrors reflect.ts).
  let fileContent: string | null = null;
  try {
    const atRef = await getFileContent(repo, diffRef, path);
    fileContent = atRef && atRef.length > 0 ? atRef : null;
  } catch {
    fileContent = null;
  }
  if (fileContent === null) {
    try {
      const atWorktree = await getFileContent(repo, "WORKTREE", path);
      fileContent = atWorktree && atWorktree.length > 0 ? atWorktree : null;
    } catch {
      fileContent = null;
    }
  }

  if (fileContent === null) {
    return emptyResult(path, diffRef, "file not found at ref or worktree");
  }

  const allLines = fileContent.split("\n");
  // Drop a trailing empty line produced by a final newline (matches git.ts convention).
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  // Clamp endLine to the file length.
  const clampedEnd = Math.min(endLine, allLines.length);
  if (startLine > allLines.length) {
    return {
      path,
      diffRef,
      startLine,
      endLine: startLine - 1,
      content: "",
      truncated: false,
      reason: "start_line beyond file length",
    };
  }

  const requested = clampedEnd - startLine + 1;
  const truncated = requested > maxLines;
  const actualEnd = truncated ? startLine + maxLines - 1 : clampedEnd;
  const slice = allLines.slice(startLine - 1, actualEnd); // 1-indexed → 0-indexed
  const content = slice.join("\n");

  return {
    path,
    diffRef,
    startLine,
    endLine: actualEnd,
    content,
    truncated,
  };
}

function emptyResult(path: string, diffRef: string, reason: string): ReadFileContextResult {
  return {
    path,
    diffRef,
    startLine: 0,
    endLine: 0,
    content: "",
    truncated: false,
    reason,
  };
}
