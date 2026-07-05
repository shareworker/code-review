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
   the `prompt_section` (review rules to apply).

2. **Read file content**: Use your native capabilities (read/grep/glob) to read
   the full file content for each file. The diff alone is not enough — you need
   the full file to understand context.

3. **Generate comments**: Using the `prompt_section` + diff + full file content,
   generate review comments. Each comment has:
   - `path`: file path
   - `content`: the comment text
   - `existing_code` (optional): the code snippet the comment references
   - `suggestion_code` (optional): suggested fix code

4. **Position each comment**: Call `position_comment` to locate each comment to
   precise line numbers:
   ```
   position_comment(path, content, existing_code, suggestion_code, hint_line?, diff_ref)
   ```

5. **Reflect each comment**: Call `reflect_comment` on every positioned comment:
   ```
   reflect_comment(path, content, start_line, end_line, existing_code?, diff_ref)
   ```

### Step 4: Filter and output

- **Discard** all comments where `reflect_comment` returns `verdict: "drop"`.
- **Keep** comments where `verdict: "keep"`.
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
   `get_file_bundle`, `position_comment`, and `reflect_comment`. Do not rely on
   the `"HEAD"` default unless you ran `get_review_targets` in `workspace` mode.

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
