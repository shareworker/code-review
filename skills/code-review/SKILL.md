---
name: code-review
description: |
  AI-powered code review using the code-review-mcp server. Reviews git changes
  (workspace, range, or commit) for code quality issues with deterministic file
  coverage, precise comment positioning, and deterministic reflection. Use when
  the user asks to review code, review a pull request, review staged/unstaged
  changes, review a commit, or compare branches for code quality.
---

# Code Review Skill

This skill orchestrates the `@shareworker/code-review-mcp` MCP server to perform
structured code reviews. The server provides deterministic engineering (file
selection, bundling, rule matching, comment positioning, comment reflection);
you (the host LLM) provide the reasoning (generating comments, semantic review).

## Trigger Conditions

Activate this skill when the user says any of:
- "review code" / "review my changes"
- "review PR" / "review pull request"
- "review commit" / "review this commit"
- "review staged/unstaged changes"
- "compare branches for code quality"

## Complete Flow

You MUST follow this flow in order. Do not skip steps.

### Step 1: Get review targets

Call `get_review_targets` to determine which files need review.

```
get_review_targets(mode: "workspace" | "range" | "commit", from?, to?, commit?)
```

- **workspace**: review staged + unstaged + untracked changes (default when user says "review my changes")
- **range**: review `from..to` (when user says "compare branches" or "review PR")
- **commit**: review a specific commit (when user says "review commit abc123")

The response includes a `diff_ref` — you MUST pass this to all downstream tools.

### Step 2: Bundle files

Call `get_file_bundle` with the file paths from step 1 and the `diff_ref`.

```
get_file_bundle(files: [...], diff_ref: "<from step 1>")
```

This groups related files (test/source pairs, i18n variants) into review bundles
with a 20000 char cap. Review each bundle as a unit.

### Step 3: Review each bundle

For each bundle:

1. **Get rules**: Call `match_rules(path)` for each file in the bundle to get
   the `prompt_section` (review rules to apply). The server has built-in
   language-specific rules for TS/JS/TSX/JSX, Python, Go, Java, C/C++, Rust,
   QML/Qt, JSON, YAML, XML (SQL Mapper), GitHub Actions workflows,
   Dockerfiles, and `package.json` — these are used when no user rule
   matches.

2. **Read file content**: Use your native capabilities (read/grep/glob) to read
   the full file content for each file. The diff alone is not enough — you need
   the full file to understand context. For cross-file context, use
   `search_code` and `read_file_context` (see Step 3b below).

3. **Gather ground-truth signals** (see Step 3d): Before generating comments,
   call the ground-truth tools to collect deterministic signals that inform
   your review:
   - `get_lint_findings(files, diff_ref)` — linter findings on changed files
   - `scan_secrets(diff_ref)` — hardcoded secrets in added lines
   - `check_dependency_diff(path, diff_ref)` — dependency manifest changes
   - `get_file_history_stats(path)` — file commit history for prioritization
   - `get_importers(path)` — reverse dependency lookup for impact analysis

4. **Generate comments**: Using the `prompt_section` + diff + full file content
   + ground-truth signals, generate review comments. Each comment has:
   - `path`: file path
   - `content`: the comment text
   - `existing_code` (optional): the code snippet the comment references
   - `suggestion_code` (optional): suggested fix code
   - `evidence` (optional): cross-file evidence snippets the comment references
     (see Step 3b for when to use this)

5. **Position each comment**: Call `position_comment` to locate each comment to
   precise line numbers. The server uses text matching → hunk alignment → fuzzy
   matching (Levenshtein) as fallback layers:
   ```
   position_comment(path, content, existing_code, suggestion_code, hint_line?, diff_ref)
   ```

6. **Reflect each comment**: Call `reflect_comment` on every positioned comment:
   ```
   reflect_comment(path, content, start_line, end_line, existing_code?, evidence?, diff_ref)
   ```

7. **Deduplicate comments**: Call `dedupe_comments` with all kept comments from
   all bundles to remove text-similar duplicates across files:
   ```
   dedupe_comments(comments: [...], similarity_threshold?)
   ```
   The server computes Jaccard similarity of normalized content and compares
   `existing_code`. Comments with similarity ≥ 0.6 (default) and matching
   `existing_code` are considered duplicates — only the one with the
   alphabetically-first path is kept.

### Step 3b: Cross-file evidence gathering (when to use `search_code` / `read_file_context`)

When you suspect a comment involves cross-file impact (e.g., "this function is
called from X", "this config key is used in Y", "this symbol is dead code"),
**gather evidence before reporting**:

1. Call `search_code(query, diff_ref)` to find where a symbol/string is
   referenced across the codebase. The search source adapts to `diff_ref`
   (workspace mode searches the worktree including untracked files; range/commit
   mode searches the corresponding revision).

2. Call `read_file_context(path, diff_ref, anchor_line|start_line+end_line)` to
   read a bounded slice of a file for deeper context without loading the entire
   file.

3. When you attach cross-file evidence to a comment, pass it via the `evidence`
   field in `reflect_comment`. Each evidence entry has `path`, `snippet`
   (required), and optional `start_line`/`end_line`. The server will
   deterministically verify that each `snippet` actually exists in its `path` —
   if any snippet is fabricated or the file doesn't exist, `reflect_comment`
   returns `drop` with `evidence_valid.passed=false`.

**When NOT to use evidence**: The `evidence` field is optional. Do not attach
evidence to every comment — only use it when the comment makes a cross-file
claim that could be a hallucination risk (e.g., "this function has no callers",
"this config is unused elsewhere"). Comments purely about the local diff do not
need evidence.

### Step 3c: Recovering from `position_comment` failure

When `position_comment` returns `located_by: "failed"` (start_line=0, end_line=0):

1. Call `read_file_context(path, diff_ref, anchor_line=<hint_line>)` to get
   fresh context around where you think the comment should go.
2. Rewrite `existing_code` using the actual file content you just read (the
   original `existing_code` may have been a hallucination or stale).
3. Retry `position_comment` once with the corrected `existing_code`.
4. If the retry also fails, discard the comment — do not output unpositioned
   comments.

Note: `position_comment` now has a fuzzy matching fallback (Levenshtein distance).
When text matching and hunk alignment both fail, it tries a sliding-window
Levenshtein comparison against the full file content. If the average
distance/length ratio is below 0.15, it returns `located_by: "fuzzy_match"`.
This catches cases where `existing_code` has minor typos or variable renames.

### Step 3d: Ground-truth signals (deterministic evidence)

Before generating comments, call these tools to collect deterministic signals
that inform your review. These are "ground truth" — they don't depend on LLM
reasoning and provide hard evidence you can cite in comments.

1. **`get_lint_findings(files, diff_ref)`**: Runs the project's configured
   linters (ESLint, golangci-lint, ruff) on the changed files. Returns findings
   with severity, message, line, and rule name. Use these to:
   - Confirm suspected code quality issues with linter backing
   - Discover issues you might have missed
   - Cite the linter rule in your comment (e.g., "ESLint reports
     `no-unused-vars` on line 42")

2. **`scan_secrets(diff_ref)`**: Scans added diff lines for hardcoded secrets
   (AWS access keys, private key PEM headers, API tokens). Returns findings
   with masked matched text. Use these to:
   - Flag security issues with high confidence (the pattern match is
     deterministic ground truth)
   - Cite the specific pattern name (e.g., "aws_access_key detected")
   - Treat `high_entropy_string` findings as heuristic — they may flag
     legitimate high-entropy data (base64 blobs, hashes, minified tokens).
     Verify before flagging as a real secret.

3. **`check_dependency_diff(path, diff_ref)`**: Compares a dependency manifest
   (package.json, requirements.txt, go.mod) before and after the diff. Returns
   added, removed, and unpinned dependencies. Use these to:
   - Flag supply-chain risks (new unpinned dependencies, `*` or `latest`
     version ranges)
   - Comment on removed dependencies that might break consumers
   - Cross-reference with `get_importers` to assess impact

4. **`get_file_history_stats(path)`**: Returns total commits, fix-commit ratio,
   and last modified date for a file. Use these to:
   - Prioritize review attention on frequently-changed or bug-prone files
     (high fix-commit ratio)
   - Add context to comments (e.g., "this file has had 15 fix commits in its
     history — consider adding tests")

5. **`get_importers(path)`**: Finds all files that import a given file (reverse
   dependency lookup). Use these to:
   - Assess the blast radius of breaking changes
   - Confirm that a removed export is truly unused (if `get_importers` returns
     empty, the export is safe to remove)
   - Find cross-file evidence for comments about API changes

6. **`run_affected_tests(repo, timeout_ms?)`**: Executes the project's
   `npm run test` script with a 60-second timeout. Returns exit code, stdout,
   stderr, and timeout status. Use this to:
   - Verify that changes don't break existing tests
   - Cite test failures in comments (e.g., "running `npm test` produces 3
     failures in the auth module")
   - Only call this when the changeset might affect test behavior — it's
     expensive and should be called at most once per review session

### Step 4: Filter and output

- **Discard** all comments where `reflect_comment` returns `verdict: "drop"`.
- **Keep** comments where `verdict: "keep"`.
- **Deduplicate across bundles**: Call `dedupe_comments` with all kept comments
  from all bundles. The server computes Jaccard text similarity and compares
  `existing_code` — comments with similarity ≥ 0.6 and matching `existing_code`
  are considered duplicates. Only the one with the alphabetically-first path is
  kept; the rest are dropped with a `duplicateOf` reference.
- Optionally perform a semantic self-review on kept comments (is the suggestion
  technically correct?). This is your responsibility, not the server's.
- Classify kept comments by priority and output.

## Hard Constraints (MUST follow)

1. **You MUST call `reflect_comment` on every comment.** Comments that have not
   been reflected MUST NOT be output to the user.

2. **Comments where `reflect_comment` returns `drop` MUST be discarded**, not
   shown to the user.

3. **You MUST call `get_review_targets` before `get_file_bundle`.** Do not skip
   either step.

4. **You MUST pass the `diff_ref` returned by `get_review_targets`** to
   `get_file_bundle`, `search_code`, `read_file_context`, `position_comment`,
   and `reflect_comment`. Do not rely on the `"HEAD"` default unless you ran
   `get_review_targets` in `workspace` mode.

5. **You MUST deduplicate cross-file repeat issues.** Call `dedupe_comments`
   with all kept comments from all bundles. The server deterministically
   deduplicates by Jaccard text similarity (default threshold 0.6) and
   `existing_code` match. Do not output comments that `dedupe_comments` marks
   as dropped.

6. **You MUST gather evidence before reporting cross-file claims.** When a
   comment asserts something about code in another file (e.g., "this function
   has no callers", "this config is unused"), call `search_code` and/or
   `read_file_context` first, and pass the evidence via the `evidence` field in
   `reflect_comment`. Comments with fabricated cross-file claims will be
   dropped by `evidence_valid`.

## Output Format

```markdown
## Code Review Results

**Files reviewed**: N
**Issues found**: X high priority / Y medium priority

### High Priority

- **`path/to/file.ts:42`** -- Brief description
  > Recommendation: How to fix

### Medium Priority

- **`path/to/file.ts:88`** -- Brief description
  > Recommendation: How to fix (if applicable)
```

**Priority classification**:
- **High**: Obvious bugs, security issues, clear mistakes, well-founded
  suggestions with precise fix proposals
- **Medium**: Reasonable but context-dependent concerns, style/performance
  suggestions, fixes requiring manual implementation
- **Low**: Discarded silently (likely false positives, lacking context, nitpicks)

## Key Boundary

The server does NOT call any LLM. `reflect_comment` is pure deterministic logic
(checks line ranges, code existence). Semantic-level reflection (is the
suggestion technically correct?) is YOUR job. After `reflect_comment` returns
`keep`, you may perform a semantic self-review before outputting.
