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
  /** Present only for i18n_variants bundles with parseable JSON files. */
  keyDiff?: I18nKeyDiff;
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

export type LocatedBy = "text_match" | "hunk_align" | "fuzzy_match" | "failed";

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
  /** Cross-file evidence snippets referenced by the comment. */
  evidence?: EvidenceRef[];
  diffRef?: string;
  repo?: string;
}

/** A cross-file evidence snippet referenced by a comment. */
export interface EvidenceRef {
  /** Repository-relative path of the file the evidence comes from. */
  path: string;
  /** Optional 1-indexed start line of the evidence range. */
  startLine?: number;
  /** Optional 1-indexed end line of the evidence range. */
  endLine?: number;
  /** The verbatim snippet text the comment claims to reference. */
  snippet: string;
}

export interface CheckResult {
  name:
    | "line_in_hunk"
    | "existing_code_found"
    | "existing_code_in_diff"
    | "evidence_valid";
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

/** Input for search_code. */
export interface SearchCodeInput {
  /** Literal or regex query for `git grep`. */
  query: string;
  /** Optional glob restricting which paths to search. */
  pathGlob?: string;
  /** Maximum number of matches to return (default 50). */
  maxResults?: number;
  /** diff_ref from get_review_targets — determines search source. */
  diffRef: string;
  /** Optional repo path (defaults to cwd at the MCP layer). */
  repo?: string;
}

/** A single match line from search_code. */
export interface SearchMatch {
  path: string;
  line: number;
  content: string;
}

/** Output of search_code. */
export interface SearchCodeResult {
  query: string;
  diffRef: string;
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
  /** Populated when no matches and a recoverable reason exists (e.g. not a git repo). */
  reason?: string;
}

/** Input for read_file_context. */
export interface ReadFileContextInput {
  /** Repository-relative file path. */
  path: string;
  /** diff_ref from get_review_targets — determines read source. */
  diffRef: string;
  /** Anchor line (1-indexed) — used with before/after. */
  anchorLine?: number;
  /** Lines before the anchor (default 10). */
  before?: number;
  /** Lines after the anchor (default 10). */
  after?: number;
  /** Explicit start line (1-indexed) — alternative to anchor mode. */
  startLine?: number;
  /** Explicit end line (1-indexed) — alternative to anchor mode. */
  endLine?: number;
  /** Maximum lines to return (default 200). */
  maxLines?: number;
  /** Optional repo path (defaults to cwd at the MCP layer). */
  repo?: string;
}

/** Output of read_file_context. */
export interface ReadFileContextResult {
  path: string;
  diffRef: string;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
  /** Populated when the file/range could not be read. */
  reason?: string;
}

// --- get_lint_findings ---

export interface LintFinding {
  path: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
  tool: string;
}

export interface GetLintFindingsInput {
  files?: string[];
  repo?: string;
}

export interface GetLintFindingsResult {
  findings: LintFinding[];
  toolsRun: string[];
  timedOut?: string[];
  reason?: string;
}

// --- scan_secrets ---

export interface SecretFinding {
  path: string;
  line: number;
  patternName: string;
  /** Partially masked matched text. */
  matchedText: string;
}

export interface ScanSecretsInput {
  diffRef: string;
  repo?: string;
}

export interface ScanSecretsResult {
  findings: SecretFinding[];
  reason?: string;
}

// --- check_dependency_diff ---

export interface DependencyChange {
  name: string;
  versionConstraint?: string;
}

export interface CheckDependencyDiffInput {
  path: string;
  diffRef: string;
  repo?: string;
}

export interface CheckDependencyDiffResult {
  added: DependencyChange[];
  removed: string[];
  unpinned: string[];
  reason?: string;
}

// --- get_file_history_stats ---

export interface GetFileHistoryStatsInput {
  path: string;
  repo?: string;
}

export interface GetFileHistoryStatsResult {
  totalCommits: number;
  lastModified?: string;
  fixCommitRatio: number;
  reason?: string;
}

// --- run_affected_tests ---

export interface RunAffectedTestsInput {
  repo?: string;
  timeoutMs?: number;
}

export interface RunAffectedTestsResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  reason?: string;
}

// --- get_importers ---

export interface GetImportersInput {
  path: string;
  repo?: string;
}

export interface GetImportersResult {
  path: string;
  importers: string[];
  reason?: string;
}

// --- dedupe_comments ---

export interface CommentForDedupe {
  path: string;
  content: string;
  existingCode?: string;
}

export interface DedupeDroppedItem {
  comment: CommentForDedupe;
  duplicateOf: CommentForDedupe;
}

export interface DedupeCommentsInput {
  comments: CommentForDedupe[];
  similarityThreshold?: number;
}

export interface DedupeCommentsResult {
  kept: CommentForDedupe[];
  dropped: DedupeDroppedItem[];
}

// --- i18n key consistency (added to FileBundle) ---

export interface I18nKeyDiffEntry {
  path: string;
  missingKeys: string[];
  extraKeys: string[];
}

export interface I18nKeyDiff {
  /** Per-file diff against the union of keys across all files in the bundle. */
  entries: I18nKeyDiffEntry[];
  reason?: string;
}
