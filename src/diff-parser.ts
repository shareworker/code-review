import { parsePatch } from "diff";
import type { FileDiff, Hunk, HunkLine, HunkLineType } from "./types.js";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Normalize a code/content line: trim whitespace and trailing \r.
 * Does NOT strip leading +/- because those can be real code characters
 * (e.g., `const x = -1;`). Diff markers are removed by parseHunkLines /
 * parseFileDiffs before this function is called.
 */
export function normalizeLine(line: string): string {
  return line.replace(/\r$/, "").trim();
}

/**
 * Split code text into normalized non-blank lines.
 */
export function splitAndNormalize(code: string): string[] {
  return code
    .split("\n")
    .map((l) => normalizeLine(l))
    .filter((l) => l !== "");
}

/**
 * Parse a single hunk's lines (with +/-/space prefixes) into typed HunkLine[].
 */
function parseHunkLines(lines: string[]): HunkLine[] {
  const result: HunkLine[] = [];
  for (const line of lines) {
    if (line === "") continue; // trailing empty line from split, not a real hunk line
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("+")) {
      result.push({ type: "added", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      result.push({ type: "deleted", content: line.slice(1) });
    } else {
      // Context line (' ' prefix) — only treat as context if it has the space marker.
      const content = line.startsWith(" ") ? line.slice(1) : line;
      result.push({ type: "context", content });
    }
  }
  return result;
}

/**
 * Parse @@ ... @@ blocks from raw diff text into Hunk[].
 * Lines before the first @@ header (file-level headers) are ignored.
 */
export function parseHunks(rawDiffText: string): Hunk[] {
  const lines = rawDiffText.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const m = line.match(HUNK_HEADER_RE);
    if (m) {
      if (current) {
        current.lines = parseHunkLines(currentLines);
        hunks.push(current);
      }
      const oldStart = parseInt(m[1], 10);
      const oldCount = m[2] ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] ? parseInt(m[4], 10) : 1;
      current = { oldStart, oldCount, newStart, newCount, lines: [] };
      currentLines = [];
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("diff --git ")) {
      // Next file starts; flush.
      current.lines = parseHunkLines(currentLines);
      hunks.push(current);
      current = null;
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  if (current) {
    current.lines = parseHunkLines(currentLines);
    hunks.push(current);
  }
  return hunks;
}

/**
 * Extract file paths and flags from raw diff headers.
 * Handles: rename, new file, deleted file, binary, mode change.
 */
interface FileMeta {
  oldPath: string;
  newPath: string;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

function parseFileMeta(rawDiffText: string): FileMeta {
  const lines = rawDiffText.split("\n");
  let oldPath = "";
  let newPath = "";
  let isBinary = false;
  let isNew = false;
  let isDeleted = false;
  let isRenamed = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // "diff --git a/path b/path" — extract both, but prefer ---/+++ lines below.
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        oldPath = m[1];
        newPath = m[2];
      }
    } else if (line.startsWith("--- ")) {
      oldPath = line.slice(4).replace(/^a\//, "");
      if (oldPath === "/dev/null") {
        isNew = true;
        oldPath = "";
      }
    } else if (line.startsWith("+++ ")) {
      newPath = line.slice(4).replace(/^b\//, "");
      if (newPath === "/dev/null") {
        isDeleted = true;
        newPath = "";
      }
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      isRenamed = true;
    } else if (line.startsWith("new file mode ")) {
      isNew = true;
    } else if (line.startsWith("deleted file mode ")) {
      isDeleted = true;
    } else if (line.startsWith("Binary files ") || line.includes("Binary files")) {
      isBinary = true;
    }
    // Stop at first hunk header — rest is hunk content.
    if (line.startsWith("@@ ")) break;
  }

  // For renamed files without ---/+++ (pure rename, no content change), keep paths from diff --git line.
  if (isRenamed && !oldPath && !newPath) {
    const m = lines[0]?.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      oldPath = m[1];
      newPath = m[2];
    }
  }

  return { oldPath, newPath, isBinary, isNew, isDeleted, isRenamed };
}

/**
 * Count insertions/deletions from hunks.
 */
function countChanges(hunks: Hunk[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "added") insertions++;
      else if (line.type === "deleted") deletions++;
    }
  }
  return { insertions, deletions };
}

/**
 * Parse a full unified diff (possibly multiple files) into FileDiff[].
 * Uses the `diff` library's parsePatch for hunk line splitting, and
 * raw-text scanning for git edge cases (rename/binary/new-file/deleted-file).
 */
export function parseFileDiffs(diffText: string): FileDiff[] {
  if (!diffText.trim()) return [];

  // Split into per-file blocks on "diff --git " boundaries.
  const fileBlocks = splitFileBlocks(diffText);

  const results: FileDiff[] = [];
  for (const block of fileBlocks) {
    const meta = parseFileMeta(block);
    const parsed = parsePatch(block)[0];
    const hunks: Hunk[] = [];

    if (parsed && parsed.hunks.length > 0) {
      for (const ph of parsed.hunks) {
        const lines: HunkLine[] = [];
        for (const rawLine of ph.lines) {
          if (rawLine === "") continue;
          if (rawLine.startsWith("\\ No newline at end of file")) continue;
          if (rawLine.startsWith("+")) {
            lines.push({ type: "added", content: rawLine.slice(1) });
          } else if (rawLine.startsWith("-")) {
            lines.push({ type: "deleted", content: rawLine.slice(1) });
          } else {
            const content = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
            lines.push({ type: "context", content });
          }
        }
        hunks.push({
          oldStart: ph.oldStart,
          oldCount: ph.oldLines,
          newStart: ph.newStart,
          newCount: ph.newLines,
          lines,
        });
      }
    }

    const { insertions, deletions } = countChanges(hunks);
    const path = meta.newPath || meta.oldPath;
    if (!path && !meta.isBinary) continue; // skip unparseable blocks

    results.push({
      oldPath: meta.oldPath,
      newPath: meta.newPath,
      diff: block,
      hunks,
      isBinary: meta.isBinary,
      isNew: meta.isNew,
      isDeleted: meta.isDeleted,
      isRenamed: meta.isRenamed,
      insertions,
      deletions,
    });
  }
  return results;
}

/**
 * Split a multi-file unified diff into per-file blocks.
 * Each block starts at a "diff --git " line and ends before the next one.
 */
function splitFileBlocks(diffText: string): string[] {
  const lines = diffText.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

/**
 * Extract one side of a hunk as indexed lines (line number + normalized content).
 * When newSide=true: context + added lines with new-file line numbers.
 * When newSide=false: context + deleted lines with old-file line numbers.
 * Mirrors open-code-review's extractSideLines.
 */
export interface IndexedLine {
  lineNum: number;
  content: string;
}

export function extractSideLines(hunk: Hunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const l of hunk.lines) {
    switch (l.type) {
      case "context":
        result.push({
          lineNum: newSide ? newLine : oldLine,
          content: normalizeLine(l.content),
        });
        oldLine++;
        newLine++;
        break;
      case "added":
        if (newSide) {
          result.push({ lineNum: newLine, content: normalizeLine(l.content) });
        }
        newLine++;
        break;
      case "deleted":
        if (!newSide) {
          result.push({ lineNum: oldLine, content: normalizeLine(l.content) });
        }
        oldLine++;
        break;
    }
  }
  return result;
}

/**
 * Scan sideLines for a consecutive run matching all targetLines.
 * Returns the start/end line numbers of the match, or null.
 * Mirrors open-code-review's matchConsecutive.
 */
export function matchConsecutive(
  sideLines: IndexedLine[],
  targetLines: string[]
): { start: number; end: number } | null {
  if (targetLines.length === 0) return null;

  // Filter blank lines from side lines so they don't break the sliding-window
  // match (target lines already have blanks stripped by splitAndNormalize).
  // Mirrors matchInFileContent's blank-line skipping.
  const nonBlank = sideLines.filter((l) => l.content !== "");
  if (nonBlank.length < targetLines.length) return null;

  for (let i = 0; i <= nonBlank.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (nonBlank[i + j].content !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return {
        start: nonBlank[i].lineNum,
        end: nonBlank[i + targetLines.length - 1].lineNum,
      };
    }
  }
  return null;
}

/**
 * Get the set of changed (added) line numbers in a hunk (new-file line numbers).
 */
export function getAddedLineNumbers(hunks: Hunk[]): Set<number> {
  const result = new Set<number>();
  for (const hunk of hunks) {
    let newLine = hunk.newStart;
    for (const l of hunk.lines) {
      if (l.type === "added") result.add(newLine);
      if (l.type === "added" || l.type === "context") newLine++;
    }
  }
  return result;
}
