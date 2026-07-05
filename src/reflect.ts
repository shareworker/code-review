import { getDiffForFileOrSynthesize, getFileContent } from "./git.js";
import { parseFileDiffs, getAddedLineNumbers, splitAndNormalize, normalizeLine } from "./diff-parser.js";
import type { CheckResult, ReflectInput, ReflectResult } from "./types.js";

/**
 * Deterministic validation of a positioned comment.
 * Returns keep or drop. Does not call LLM.
 *
 * Three checks:
 * 1. line_in_hunk: Are start_line/end_line within the diff hunk's changed line range?
 * 2. existing_code_found: Does the existing_code snippet actually exist in the file?
 *    (not applicable when existing_code is empty/undefined — passes by default)
 * 3. existing_code_in_diff: Is at least one line of existing_code within the diff's changed lines?
 *    (not applicable when existing_code is empty/undefined — passes by default)
 *
 * Verdict: any check fails → drop; all pass → keep.
 * Semantic-level reflection is the host LLM's responsibility.
 */
export async function reflectComment(
  repo: string,
  input: ReflectInput
): Promise<ReflectResult> {
  const path = input.path.replace(/\\/g, "/");
  const diffRef = input.diffRef ?? "HEAD";

  const checks: CheckResult[] = [
    { name: "line_in_hunk", passed: false },
    { name: "existing_code_found", passed: false },
    { name: "existing_code_in_diff", passed: false },
  ];

  // Read the diff for this file.
  let diffText = "";
  let hasDiff = true;
  try {
    diffText = await getDiffForFileOrSynthesize(repo, diffRef, path);
  } catch {
    hasDiff = false;
  }

  // Read the file content (try ref first, then worktree).
  // Note: `git show <range>:<path>` returns empty string for range refs, so
  // we treat empty content as "not found at ref" and fall back to worktree.
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

  // File not found → all checks fail, drop.
  if (fileContent === null) {
    return {
      verdict: "drop",
      reason: "file not found",
      checks: [
        { name: "line_in_hunk", passed: false },
        { name: "existing_code_found", passed: false },
        { name: "existing_code_in_diff", passed: false },
      ],
    };
  }

  // Check 1: line_in_hunk
  // For new files (untracked / full-file-add), all lines are "changed" → passes vacuously.
  // For positioning failure (0,0), fails.
  // For workspace mode untracked files: `git diff HEAD -- <path>` returns empty string
  // (file not tracked), but the file exists in worktree → treat as new file (all lines changed).
  const isUntracked = hasDiff && !diffText && fileContent !== null && fileContent.length > 0;
  let lineInHunk: boolean;
  if (isUntracked) {
    // Untracked file: all lines are "changed" → any valid line range passes.
    lineInHunk = input.startLine > 0 && input.endLine >= input.startLine;
  } else {
    lineInHunk = checkLineInHunk(input.startLine, input.endLine, diffText, hasDiff);
  }
  checks[0] = { name: "line_in_hunk", passed: lineInHunk };

  // Determine if existing_code is applicable.
  const hasExistingCode = !!input.existingCode && input.existingCode.trim() !== "";

  // Check 2: existing_code_found
  if (!hasExistingCode) {
    checks[1] = { name: "existing_code_found", passed: true }; // not applicable
  } else {
    const found = checkExistingCodeFound(input.existingCode!, fileContent);
    checks[1] = { name: "existing_code_found", passed: found };
  }

  // Check 3: existing_code_in_diff
  if (!hasExistingCode) {
    checks[2] = { name: "existing_code_in_diff", passed: true }; // not applicable
  } else if (isUntracked) {
    // Untracked file: all code is "new" → all existing_code is in the diff.
    checks[2] = { name: "existing_code_in_diff", passed: true };
  } else if (!hasDiff || !diffText) {
    // No diff available (e.g., invalid ref) → can't verify → fail.
    checks[2] = { name: "existing_code_in_diff", passed: false };
  } else {
    const inDiff = checkExistingCodeInDiff(input.existingCode!, diffText);
    checks[2] = { name: "existing_code_in_diff", passed: inDiff };
  }

  // Verdict: any check fails → drop.
  const allPass = checks.every((c) => c.passed);
  return {
    verdict: allPass ? "keep" : "drop",
    reason: allPass ? "passed all checks" : describeFailure(checks),
    checks,
  };
}

/**
 * Check if start_line/end_line fall within the diff's changed line range.
 * - For new files (full-file-add, all lines added), all lines are "changed" → passes.
 * - For positioning failure (0,0), fails.
 * - For empty/invalid diff, fails.
 */
function checkLineInHunk(startLine: number, endLine: number, diffText: string, hasDiff: boolean): boolean {
  if (startLine <= 0 || endLine < startLine) return false;
  if (!hasDiff || !diffText) return false;

  const fileDiffs = parseFileDiffs(diffText);
  const fileDiff = fileDiffs[0];
  if (!fileDiff) return false;

  // New file: all lines are "changed" → any line is in hunk.
  if (fileDiff.isNew) return true;

  // Collect all added line numbers across hunks.
  const addedLines = getAddedLineNumbers(fileDiff.hunks);
  if (addedLines.size === 0) return false;

  // The comment's line range must overlap with at least one added line.
  for (let line = startLine; line <= endLine; line++) {
    if (addedLines.has(line)) return true;
  }
  return false;
}

/**
 * Check if existing_code exists in the file content.
 * Normalizes both sides (trim, strip diff markers) and checks if all
 * non-blank target lines appear consecutively in the file.
 */
function checkExistingCodeFound(existingCode: string, fileContent: string): boolean {
  const targetLines = splitAndNormalize(existingCode);
  if (targetLines.length === 0) return true;

  const fileLines = fileContent
    .split("\n")
    .map((l) => normalizeLine(l))
    .filter((l) => l !== ""); // skip blanks so they don't break the window match
  // Check for consecutive match (same logic as matchInFileContent but simpler — just existence).
  for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (fileLines[i + j] !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Check if at least one line of existing_code falls within the diff's changed lines.
 * "Changed lines" = added lines (new-side) + deleted lines (old-side content).
 * We check if any normalized target line matches any normalized added/deleted line.
 */
function checkExistingCodeInDiff(existingCode: string, diffText: string): boolean {
  const targetLines = splitAndNormalize(existingCode);
  if (targetLines.length === 0) return true;

  const fileDiffs = parseFileDiffs(diffText);
  const fileDiff = fileDiffs[0];
  if (!fileDiff) return false;

  // Collect normalized content of all changed lines (added + deleted).
  const changedContents = new Set<string>();
  for (const hunk of fileDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "added" || line.type === "deleted") {
        const n = normalizeLine(line.content);
        if (n !== "") changedContents.add(n);
      }
    }
  }

  // At least one target line must match a changed line.
  for (const target of targetLines) {
    if (changedContents.has(target)) return true;
  }
  return false;
}

/**
 * Describe which check(s) failed for the drop reason.
 */
function describeFailure(checks: CheckResult[]): string {
  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  if (failed.length === 0) return "passed all checks";
  return `failed: ${failed.join(", ")}`;
}
