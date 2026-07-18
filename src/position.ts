import { getDiffForFileOrSynthesize, getFileContent, resolvePostRef } from "./git.js";
import { parseFileDiffs, parseHunks, extractSideLines, matchConsecutive, splitAndNormalize, normalizeLine } from "./diff-parser.js";
import type { Hunk, PositionInput, PositionResult } from "./types.js";

const FUZZY_MATCH_THRESHOLD = 0.15;

/**
 * Compute Levenshtein distance between two strings.
 * Uses a simple dynamic programming approach.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Locate a comment to precise line numbers in the target file.
 *
 * Strategy:
 * 1. Text matching (primary): extract code lines from existing_code/suggestion_code,
 *    normalize, search for consecutive matches. Try hunk new-side first, then
 *    old-side, then full file content.
 * 2. Hunk alignment (fallback): if no code snippet but hint_line is provided,
 *    use hunk line-number mapping to align.
 * 3. Fuzzy matching (fallback): if text matching and hunk alignment both fail,
 *    slide a window over the file content and compute Levenshtein distance
 *    against the normalized existing_code. Accept if distance/length < threshold.
 * 4. Fallback: return 0, 0, "failed".
 */
export async function positionComment(
  repo: string,
  input: PositionInput
): Promise<PositionResult> {
  const path = input.path.replace(/\\/g, "/");
  const diffRef = input.diffRef ?? "HEAD";

  // Gather code lines from existing_code or suggestion_code.
  const codeSource = input.existingCode || input.suggestionCode || "";
  const targetLines = splitAndNormalize(codeSource);

  // If we have code lines, try text matching.
  if (targetLines.length > 0) {
    const result = await tryTextMatch(repo, path, diffRef, targetLines);
    if (result) return result;
  }

  // Fallback: hunk alignment with hint_line.
  if (input.hintLine && input.hintLine > 0) {
    const result = await tryHunkAlign(repo, path, diffRef, input.hintLine);
    if (result) return result;
  }

  // Fallback: fuzzy matching against full file content.
  if (targetLines.length > 0) {
    const result = await tryFuzzyMatch(repo, path, diffRef, targetLines);
    if (result) return result;
  }

  return { path, startLine: 0, endLine: 0, locatedBy: "failed" };
}

/**
 * Try text matching: hunk new-side → old-side → full file content.
 */
async function tryTextMatch(
  repo: string,
  path: string,
  diffRef: string,
  targetLines: string[]
): Promise<PositionResult | null> {
  let diffText: string;
  try {
    diffText = await getDiffForFileOrSynthesize(repo, diffRef, path);
  } catch {
    return null;
  }
  if (!diffText) return null;

  const fileDiffs = parseFileDiffs(diffText);
  const fileDiff = fileDiffs[0];
  if (!fileDiff) return null;

  // Try hunk new-side first (context + added → new-file line numbers).
  for (const hunk of fileDiff.hunks) {
    const newSide = extractSideLines(hunk, true);
    const match = matchConsecutive(newSide, targetLines);
    if (match) {
      return { path, startLine: match.start, endLine: match.end, locatedBy: "text_match" };
    }
  }

  // Try hunk old-side (context + deleted → old-file line numbers).
  for (const hunk of fileDiff.hunks) {
    const oldSide = extractSideLines(hunk, false);
    const match = matchConsecutive(oldSide, targetLines);
    if (match) {
      return { path, startLine: match.start, endLine: match.end, locatedBy: "text_match" };
    }
  }

  // Fallback: scan full file content at the post-change revision.
  const fileContent = await tryGetFileContent(repo, resolvePostRef(diffRef), path);
  if (fileContent) {
    const match = matchInFileContent(fileContent, targetLines);
    if (match) {
      return { path, startLine: match.start, endLine: match.end, locatedBy: "text_match" };
    }
  }

  return null;
}

/**
 * Try to get file content at a ref. Returns null on failure or empty result.
 * Note: `git show <range>:<path>` returns empty string for range refs, so
 * we treat empty as "not found" and fall back to worktree.
 */
async function tryGetFileContent(repo: string, ref: string, path: string): Promise<string | null> {
  try {
    const content = await getFileContent(repo, ref, path);
    if (content && content.length > 0) return content;
  } catch {
    // fall through to worktree
  }
  try {
    const content = await getFileContent(repo, "WORKTREE", path);
    if (content && content.length > 0) return content;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Scan file content line-by-line for consecutive matches of normalized target lines.
 * Blank lines are skipped so they don't break the sliding-window match.
 * Mirrors open-code-review's resolveFromFileContent.
 */
function matchInFileContent(
  fileContent: string,
  targetLines: string[]
): { start: number; end: number } | null {
  const fileLines = fileContent.split("\n");
  const normalizedLines: string[] = [];
  const lineNums: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const n = normalizeLine(fileLines[i]);
    if (n === "") continue;
    normalizedLines.push(n);
    lineNums.push(i + 1);
  }
  if (normalizedLines.length < targetLines.length) return null;

  for (let i = 0; i <= normalizedLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (normalizedLines[i + j] !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start: lineNums[i], end: lineNums[i + targetLines.length - 1] };
    }
  }
  return null;
}

/**
 * Try hunk alignment: map hint_line to the closest hunk's line range.
 * If hint_line falls within a hunk's new-side range, return it.
 */
async function tryHunkAlign(
  repo: string,
  path: string,
  diffRef: string,
  hintLine: number
): Promise<PositionResult | null> {
  let diffText: string;
  try {
    diffText = await getDiffForFileOrSynthesize(repo, diffRef, path);
  } catch {
    return null;
  }
  if (!diffText) return null;

  const hunks = parseHunks(diffText);
  if (hunks.length === 0) return null;

  // Find the hunk whose new-side range contains hint_line.
  for (const hunk of hunks) {
    const newEnd = hunk.newStart + hunk.newCount - 1;
    if (hintLine >= hunk.newStart && hintLine <= newEnd) {
      return { path, startLine: hintLine, endLine: hintLine, locatedBy: "hunk_align" };
    }
  }

  // If hint_line is before the first hunk, clamp to the first hunk's new start.
  if (hintLine < hunks[0].newStart) {
    return { path, startLine: hunks[0].newStart, endLine: hunks[0].newStart, locatedBy: "hunk_align" };
  }
  // If after the last hunk, clamp to the last hunk's new end.
  const last = hunks[hunks.length - 1];
  const lastEnd = last.newStart + last.newCount - 1;
  if (hintLine > lastEnd) {
    return { path, startLine: lastEnd, endLine: lastEnd, locatedBy: "hunk_align" };
  }

  // Between hunks — pick the closest.
  let closest = hunks[0];
  let minDist = Math.abs(hintLine - closest.newStart);
  for (const hunk of hunks) {
    const dist = Math.abs(hintLine - hunk.newStart);
    if (dist < minDist) {
      minDist = dist;
      closest = hunk;
    }
  }
  return { path, startLine: closest.newStart, endLine: closest.newStart, locatedBy: "hunk_align" };
}

/**
 * Try fuzzy matching: slide a window over the file content and compute
 * Levenshtein distance against the normalized target lines.
 * Accept if the average distance/length ratio is below the threshold.
 */
async function tryFuzzyMatch(
  repo: string,
  path: string,
  diffRef: string,
  targetLines: string[]
): Promise<PositionResult | null> {
  const fileContent = await tryGetFileContent(repo, resolvePostRef(diffRef), path);
  if (!fileContent) return null;

  const fileLines = fileContent.split("\n");
  const normalizedLines: string[] = [];
  const lineNums: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const n = normalizeLine(fileLines[i]);
    if (n === "") continue;
    normalizedLines.push(n);
    lineNums.push(i + 1);
  }
  if (normalizedLines.length < targetLines.length) return null;

  const windowSize = targetLines.length;

  for (let i = 0; i <= normalizedLines.length - windowSize; i++) {
    let totalDist = 0;
    let totalLen = 0;
    for (let j = 0; j < windowSize; j++) {
      const dist = levenshtein(normalizedLines[i + j], targetLines[j]);
      const maxLen = Math.max(normalizedLines[i + j].length, targetLines[j].length, 1);
      totalDist += dist;
      totalLen += maxLen;
    }
    const ratio = totalLen > 0 ? totalDist / totalLen : 1;
    if (ratio < FUZZY_MATCH_THRESHOLD) {
      return {
        path,
        startLine: lineNums[i],
        endLine: lineNums[i + windowSize - 1],
        locatedBy: "fuzzy_match",
      };
    }
  }

  return null;
}
