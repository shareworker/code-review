import simpleGit from "simple-git";
import { matchAny } from "./filter.js";
import { loadFilterConfig } from "./filter.js";
import type { SearchCodeInput, SearchCodeResult, SearchMatch } from "./types.js";

/** Default cap on the number of matches returned. */
export const DEFAULT_MAX_RESULTS = 50;

/**
 * Parse a diff_ref into the git revision that search_code should grep.
 * - "HEAD" → workspace mode (returns null, signals worktree search with --untracked)
 * - "from..to" → "to"
 * - "commit^..commit" → "commit"
 * - any other single ref → that ref
 */
function resolveSearchRevision(diffRef: string): string | null {
  if (diffRef === "HEAD") return null; // workspace mode
  const rangeMatch = diffRef.match(/^(.+?)\.\.(.+)$/);
  if (rangeMatch) return rangeMatch[2]; // the "to" side
  return diffRef;
}

/**
 * Cross-file text-level search via `git grep`.
 *
 * - workspace mode (diff_ref="HEAD") searches the worktree including untracked files.
 * - range/commit mode searches the corresponding revision's tree.
 * - Results are filtered by `.code-review/rules.json` filters.exclude.
 * - max_results (default 50) caps the returned matches; truncated=true when capped.
 *
 * Never throws — non-git repo, invalid pattern, and no-match all return empty
 * results with an optional `reason` field.
 */
export async function searchCode(
  repo: string,
  input: SearchCodeInput
): Promise<SearchCodeResult> {
  const query = (input.query ?? "").toString();
  const maxResults = input.maxResults && input.maxResults > 0
    ? Math.floor(input.maxResults)
    : DEFAULT_MAX_RESULTS;
  const diffRef = input.diffRef ?? "HEAD";

  if (!query) {
    return emptyResult(query, diffRef, "empty query");
  }

  const git = simpleGit(repo);
  let isRepo = false;
  try {
    isRepo = (await git.checkIsRepo()) === true;
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    return emptyResult(query, diffRef, "not a git repository");
  }

  const searchRev = resolveSearchRevision(diffRef);
  // Build git grep args. -n shows line numbers, -I skips binary files,
  // -E uses extended regex so common patterns behave intuitively.
  // Option order matters: flags like --untracked must precede the pattern.
  const args = ["grep", "-n", "-I", "-E"];
  if (searchRev === null) {
    // workspace mode: include untracked files in the worktree search.
    args.push("--untracked");
  }
  args.push(query);
  if (searchRev !== null) {
    // revision mode: search the tree at the resolved revision.
    args.push(searchRev);
  }
  // Optional pathspec glob restricts which files are searched.
  if (input.pathGlob) {
    args.push("--", input.pathGlob);
  }

  let raw: string;
  try {
    // raw_output keeps git grep's stdout verbatim so we can parse line:content.
    raw = await git.raw(args) ?? "";
  } catch {
    // git grep exits non-zero on no matches OR on invalid pattern. Distinguish
    // by re-probing with a trivially-matching pattern; if that also fails, the
    // repo/rev is unreadable. Otherwise treat as "no matches / invalid pattern".
    return emptyResult(query, diffRef, "no matches or invalid pattern");
  }

  if (!raw.trim()) {
    return emptyResult(query, diffRef);
  }

  // Load filter config to apply excludes.
  const filterConfig = await loadFilterConfig(repo);

  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Output formats:
    //   workspace:  `<path>:<line>:<content>`
    //   revision:   `<rev>:<path>:<line>:<content>` (one extra leading field)
    const parts = line.split(":");
    let path: string;
    let lineNo: number;
    let content: string;
    if (searchRev === null) {
      // <path>:<line>:<content>
      if (parts.length < 3) continue;
      path = parts[0];
      lineNo = parseInt(parts[1], 10);
      content = parts.slice(2).join(":");
    } else {
      // <rev>:<path>:<line>:<content>
      if (parts.length < 4) continue;
      path = parts[1];
      lineNo = parseInt(parts[2], 10);
      content = parts.slice(3).join(":");
    }
    if (!Number.isFinite(lineNo)) continue;
    const normalizedPath = path.replace(/\\/g, "/");

    // Apply exclude filters.
    if (matchAny(normalizedPath, filterConfig.exclude)) {
      continue;
    }
    if (filterConfig.include.length > 0 && !matchAny(normalizedPath, filterConfig.include)) {
      continue;
    }

    totalMatches++;
    if (matches.length >= maxResults) {
      truncated = true;
      // Keep counting totalMatches but stop collecting.
      continue;
    }
    matches.push({ path: normalizedPath, line: lineNo, content });
  }

  return {
    query,
    diffRef,
    matches,
    totalMatches,
    truncated,
  };
}

function emptyResult(query: string, diffRef: string, reason?: string): SearchCodeResult {
  return {
    query,
    diffRef,
    matches: [],
    totalMatches: 0,
    truncated: false,
    reason,
  };
}
