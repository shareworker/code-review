import simpleGit from "simple-git";
import type {
  GetFileHistoryStatsInput,
  GetFileHistoryStatsResult,
} from "./types.js";

const FIX_KEYWORDS = ["fix", "bug", "hotfix", "patch", "regression"];

/**
 * Compute file history statistics for review prioritization.
 *
 * - total_commits: number of commits that touched the file (via --follow)
 * - last_modified: ISO timestamp of the most recent commit
 * - fix_commit_ratio: fraction of commits whose message contains fix/bug/hotfix keywords
 *
 * Never throws — new files and missing paths return empty stats + reason.
 */
export async function getFileHistoryStats(
  repo: string,
  input: GetFileHistoryStatsInput
): Promise<GetFileHistoryStatsResult> {
  const path = input.path.replace(/\\/g, "/");
  const git = simpleGit(repo);

  let isRepo = false;
  try {
    isRepo = (await git.checkIsRepo()) === true;
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    return { totalCommits: 0, fixCommitRatio: 0, reason: "not a git repository" };
  }

  // Get commit log for this file (--follow tracks renames).
  // Format: <hash>\t<iso date>\t<subject>
  let raw: string;
  try {
    raw = await git.raw([
      "log",
      "--follow",
      "--format=%H\t%cI\t%s",
      "--",
      path,
    ]);
  } catch {
    return { totalCommits: 0, fixCommitRatio: 0, reason: "could not read git log for path" };
  }

  if (!raw.trim()) {
    return { totalCommits: 0, fixCommitRatio: 0, reason: "no commit history for this path" };
  }

  const lines = raw.trim().split("\n");
  const totalCommits = lines.length;
  let fixCount = 0;
  let lastModified: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 3) continue;
    const date = parts[1];
    const subject = parts[2].toLowerCase();
    // First line is the most recent commit.
    if (i === 0) lastModified = date;
    if (FIX_KEYWORDS.some((kw) => subject.includes(kw))) {
      fixCount++;
    }
  }

  return {
    totalCommits,
    lastModified,
    fixCommitRatio: totalCommits > 0 ? fixCount / totalCommits : 0,
  };
}
