import { minimatch } from "minimatch";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MatchRulesResult, PathRule, RulesConfig } from "./types.js";

/**
 * Built-in generic default rule, aligned with open-code-review's default.md.
 * Covers correctness, security, performance, maintainability, test coverage.
 */
export const BUILT_IN_DEFAULT_RULE = `#### Correctness
Is the logic correct? Are there missing boundary conditions?
Are exceptions handled properly?
Is it thread-safe in concurrent scenarios?

#### Security
Are there security vulnerabilities such as SQL injection or XSS?
Is sensitive information handled correctly?
Is permission validation complete?

#### Performance
Are there obvious performance issues (e.g., N+1 queries, unnecessary loops)?
Are resources properly released?

#### Maintainability
Is the code clear and easy to understand?
Do names accurately express intent?
Does it follow the project's existing code style and architecture patterns?

#### Test Coverage
Do critical logic paths have corresponding test cases?
Do test cases cover boundary conditions?`;

/**
 * Load a rules.json file, returning null if missing or unparseable.
 * Parse failures log a warning and return null (caller falls back to default).
 * Accepts both `path` and `pattern` as the glob field key (spec uses `path`).
 */
async function loadRulesFile(dir: string): Promise<RulesConfig | null> {
  const filePath = join(dir, ".code-review", "rules.json");
  try {
    const content = await readFile(filePath, "utf8");
    const raw = JSON.parse(content) as any;
    // Normalize: rules entries may use `path` or `pattern` — map to `pattern`.
    if (raw?.rules && Array.isArray(raw.rules)) {
      raw.rules = raw.rules.map((r: any) => ({
        pattern: r.pattern ?? r.path,
        rule: r.rule,
      }));
    }
    return raw as RulesConfig;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null; // missing: silent fallback
    // Parse error or other failure: warn and fall back.
    console.warn(`[code-review-mcp] Failed to parse ${filePath}: ${err?.message ?? err}. Falling back to default rules.`);
    return null;
  }
}

/**
 * Match a file path against a list of path rules (first match wins).
 * Case-insensitive, supports glob patterns including ** and brace expansion.
 */
function matchPathRules(path: string, rules: PathRule[]): PathRule | null {
  const lowerPath = path.toLowerCase();
  for (const rule of rules) {
    if (minimatch(lowerPath, rule.pattern.toLowerCase())) {
      return rule;
    }
  }
  return null;
}

/**
 * Match review rules for a file path, returning a ready-to-use prompt_section.
 *
 * Priority: repo .code-review/rules.json > home ~/.code-review/rules.json > built-in default.
 * First match wins at each layer; the first layer with a match takes precedence.
 */
export async function matchRules(
  repo: string,
  path: string
): Promise<MatchRulesResult> {
  const normalizedPath = path.replace(/\\/g, "/");

  // Layer 1: repo rules.
  const repoConfig = await loadRulesFile(repo);
  if (repoConfig?.rules) {
    const matched = matchPathRules(normalizedPath, repoConfig.rules);
    if (matched) {
      return {
        path: normalizedPath,
        matchedRules: [matched],
        promptSection: formatPromptSection([matched.rule]),
        usedDefault: false,
      };
    }
  }

  // Layer 2: home rules.
  const homeConfig = await loadRulesFile(homedir());
  if (homeConfig?.rules) {
    const matched = matchPathRules(normalizedPath, homeConfig.rules);
    if (matched) {
      return {
        path: normalizedPath,
        matchedRules: [matched],
        promptSection: formatPromptSection([matched.rule]),
        usedDefault: false,
      };
    }
  }

  // Layer 3: built-in default.
  return {
    path: normalizedPath,
    matchedRules: [],
    promptSection: formatPromptSection([BUILT_IN_DEFAULT_RULE]),
    usedDefault: true,
  };
}

/**
 * Format rule texts into a single prompt_section string.
 */
function formatPromptSection(rules: string[]): string {
  if (rules.length === 0) return "";
  if (rules.length === 1) return rules[0];
  return rules.map((r) => `- ${r}`).join("\n");
}
