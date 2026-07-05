// Shared types for the code-review MCP server.

/** A single line within a diff hunk. */
export type HunkLineType = "context" | "added" | "deleted";

export interface HunkLine {
  type: HunkLineType;
  /** Content without the leading +/-/space diff marker. */
  content: string;
}

/** One @@ ... @@ block in a unified diff. */
export interface Hunk {
  /** Starting line in the old file (1-indexed). */
  oldStart: number;
  oldCount: number;
  /** Starting line in the new file (1-indexed). */
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

/** A parsed diff for a single file. */
export interface FileDiff {
  oldPath: string;
  newPath: string;
  /** Raw unified diff text for this file (including headers). */
  diff: string;
  hunks: Hunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  insertions: number;
  deletions: number;
}

/** A file selected for review. */
export interface ReviewTarget {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

/** A path -> rule entry. */
export interface PathRule {
  pattern: string;
  rule: string;
}

/** Filter configuration from .code-review/rules.json. */
export interface FilterConfig {
  include: string[];
  exclude: string[];
}

/** Rules configuration from .code-review/rules.json. */
export interface RulesConfig {
  filters?: FilterConfig;
  rules?: PathRule[];
}

/** A bundle of related files reviewed together. */
export interface BundleFile {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
}

export type BundleReason = "test_source_pair" | "i18n_variants" | "single_file";

export interface FileBundle {
  id: string;
  files: BundleFile[];
  totalChars: number;
  bundleReason: BundleReason;
}

/** Input for position_comment. */
export interface PositionInput {
  path: string;
  content: string;
  existingCode?: string;
  suggestionCode?: string;
  hintLine?: number;
  diffRef?: string;
  repo?: string;
}

export type LocatedBy = "text_match" | "hunk_align" | "failed";

export interface PositionResult {
  path: string;
  startLine: number;
  endLine: number;
  locatedBy: LocatedBy;
}

/** Input for reflect_comment. */
export interface ReflectInput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  existingCode?: string;
  diffRef?: string;
  repo?: string;
}

export interface CheckResult {
  name: "line_in_hunk" | "existing_code_found" | "existing_code_in_diff";
  passed: boolean;
}

export interface ReflectResult {
  verdict: "keep" | "drop";
  reason: string;
  checks: CheckResult[];
}

/** Output of get_review_targets. */
export interface ReviewTargetsResult {
  diffRef: string;
  files: ReviewTarget[];
  totalFiles: number;
  filteredOut: number;
}

/** Output of match_rules. */
export interface MatchRulesResult {
  path: string;
  matchedRules: PathRule[];
  promptSection: string;
  usedDefault: boolean;
}
