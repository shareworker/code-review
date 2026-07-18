#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDiff, getUntrackedFiles, synthesizeUntrackedDiff } from "./git.js";
import { parseFileDiffs } from "./diff-parser.js";
import { loadFilterConfig, filterFiles, isBinaryByExtension } from "./filter.js";
import { bundleFiles } from "./bundler.js";
import { matchRules } from "./rules.js";
import { positionComment } from "./position.js";
import { reflectComment } from "./reflect.js";
import { searchCode } from "./search-code.js";
import { readFileContext } from "./read-file-context.js";
import { getLintFindings } from "./lint.js";
import { scanSecrets } from "./secrets.js";
import { checkDependencyDiff } from "./dependency-diff.js";
import { getFileHistoryStats } from "./file-history.js";
import { runAffectedTests } from "./run-tests.js";
import { getImporters } from "./importers.js";
import { dedupeComments } from "./dedupe.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AgentConfig {
  name: string;
  dir: string;
  configFile: string;
  skillDir: string;
  configFormat: "json" | "toml";
}

const MCP_CONFIG_ENTRY = {
  command: "npx",
  args: ["-y", "@shareworker/code-review-mcp"],
};

function isGlobal(): boolean {
  return process.argv.includes("--global");
}

function getAgents(global: boolean): AgentConfig[] {
  const base = global ? homedir() : process.cwd();
  return [
    { name: "claude", dir: path.join(base, ".claude"), configFile: path.join(base, ".claude", "mcp.json"), skillDir: path.join(base, ".claude", "skills", "code-review"), configFormat: "json" },
    { name: "devin", dir: path.join(base, ".devin"), configFile: path.join(base, ".devin", "config.json"), skillDir: path.join(base, ".devin", "skills", "code-review"), configFormat: "json" },
    { name: "codex", dir: path.join(base, ".codex"), configFile: path.join(base, ".codex", "config.toml"), skillDir: path.join(base, ".codex", "skills", "code-review"), configFormat: "toml" },
  ];
}

function selectAgents(defaultToAll: boolean, global: boolean) {
  const agentIdx = process.argv.indexOf("--agent");
  const agentFlag = agentIdx !== -1 && agentIdx + 1 < process.argv.length
    ? process.argv[agentIdx + 1]
    : null;
  if (agentIdx !== -1 && !agentFlag) {
    console.error("--agent requires a value (claude, devin, or codex)");
    process.exit(1);
  }

  const agents = getAgents(global);
  const selected = agentFlag
    ? agents.filter((agent) => agent.name === agentFlag)
    : agents.filter((agent) => fs.existsSync(agent.dir));
  if (selected.length === 0 && !agentFlag && defaultToAll) {
    console.log(`No agent directories detected${global ? " globally" : ""}. Setting up for all supported agents.`);
    return [...agents];
  }
  if (selected.length === 0 && agentFlag) {
    console.error(`Unknown agent: ${agentFlag}. Supported: claude, devin, codex`);
    process.exit(1);
  }
  return selected;
}

/**
 * `setup` subcommand: one-command install.
 * Detects which agents are present in the project or home directory (when --global),
 * writes MCP config entries, and copies the skill file. Creates agent directories
 * if they don't exist yet.
 *
 * Usage: npx @shareworker/code-review-mcp setup
 *        npx @shareworker/code-review-mcp setup --agent claude
 *        npx @shareworker/code-review-mcp setup --global
 *        npx @shareworker/code-review-mcp setup --global --agent claude
 */
function setup() {
  const global = isGlobal();
  const skillSrc = path.join(__dirname, "..", "skills", "code-review", "SKILL.md");
  if (!fs.existsSync(skillSrc)) {
    console.error(`Skill source not found: ${skillSrc}`);
    process.exit(1);
  }
  const skillContent = fs.readFileSync(skillSrc, "utf-8");

  const selected = selectAgents(true, global);

  for (const agent of selected) {
    // 1. Write MCP config.
    fs.mkdirSync(path.dirname(agent.configFile), { recursive: true });
    if (agent.configFormat === "toml") {
      writeTomlConfig(agent);
    } else {
      writeJsonConfig(agent);
    }

    // 2. Copy skill.
    try {
      fs.mkdirSync(agent.skillDir, { recursive: true });
      fs.writeFileSync(path.join(agent.skillDir, "SKILL.md"), skillContent, "utf-8");
      console.log(`[${agent.name}] Skill installed to ${agent.skillDir}/SKILL.md`);
    } catch (err: any) {
      console.error(`[${agent.name}] Failed to install skill: ${err?.message ?? err}`);
    }
  }

  console.log(`\nDone! Configured ${selected.length} agent(s): ${selected.map((a) => a.name).join(", ")}`);
  console.log("Restart your agent to pick up the new MCP server.");
}

/**
 * Write/merge MCP config for JSON-based agents (Claude, Devin).
 */
function writeJsonConfig(agent: AgentConfig) {
  let config: any = {};
  if (fs.existsSync(agent.configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(agent.configFile, "utf-8"));
    } catch {
      console.warn(`Warning: ${agent.configFile} is unparseable, overwriting.`);
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    if (config.mcpServers) {
      console.warn(`Warning: ${agent.configFile} has invalid mcpServers field. Resetting.`);
    }
    config.mcpServers = {};
  }
  config.mcpServers["code-review"] = { ...MCP_CONFIG_ENTRY };
  fs.writeFileSync(agent.configFile, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`[${agent.name}] MCP config written to ${agent.configFile}`);
}

/**
 * Write/merge MCP config for TOML-based agents (Codex).
 * Codex uses config.toml with [mcp_servers.<name>] sections.
 */
function writeTomlConfig(agent: AgentConfig) {
  const sectionHeader = "[mcp_servers.code-review]";
  const sectionBody = [
    `command = "npx"`,
    `args = ["-y", "@shareworker/code-review-mcp"]`,
  ].join("\n");
  const newSection = `${sectionHeader}\n${sectionBody}`;

  let existing = "";
  if (fs.existsSync(agent.configFile)) {
    existing = fs.readFileSync(agent.configFile, "utf-8");
  }

  // Check if section already exists; if so, replace it. Otherwise append.
  const sectionRe = /\[mcp_servers\.code-review\][\s\S]*?(?=\n\[|\n$|$)/;
  if (sectionRe.test(existing)) {
    const updated = existing.replace(sectionRe, newSection);
    fs.writeFileSync(agent.configFile, updated, "utf-8");
  } else {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    const suffix = existing ? "\n" : "";
    fs.writeFileSync(agent.configFile, existing + prefix + newSection + "\n", "utf-8");
  }
  console.log(`[${agent.name}] MCP config written to ${agent.configFile}`);
}

function removeJsonConfig(agent: AgentConfig) {
  if (!fs.existsSync(agent.configFile)) return false;
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(agent.configFile, "utf-8"));
  } catch {
    console.warn(`Warning: ${agent.configFile} is unparseable, leaving it unchanged.`);
    return null;
  }
  if (!config?.mcpServers || typeof config.mcpServers !== "object" || !("code-review" in config.mcpServers)) return false;

  delete config.mcpServers["code-review"];
  fs.writeFileSync(agent.configFile, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return true;
}

function removeTomlConfig(agent: AgentConfig) {
  if (!fs.existsSync(agent.configFile)) return false;
  const existing = fs.readFileSync(agent.configFile, "utf-8");
  const sectionRe = /\[mcp_servers\.code-review\][\s\S]*?(?=\n\[|\n$|$)/;
  if (!sectionRe.test(existing)) return false;

  fs.writeFileSync(agent.configFile, existing.replace(sectionRe, ""), "utf-8");
  return true;
}

function removeSkill(agent: AgentConfig) {
  const skillPath = path.join(agent.skillDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) return false;

  fs.unlinkSync(skillPath);
  if (fs.readdirSync(agent.skillDir).length === 0) fs.rmdirSync(agent.skillDir);
  return true;
}

function uninstall() {
  const global = isGlobal();
  const selected = selectAgents(false, global);
  if (selected.length === 0) {
    console.log(`No agent directories detected${global ? " globally" : ""}. Nothing to uninstall.`);
    return;
  }

  for (const agent of selected) {
    try {
      const configRemoved = agent.configFormat === "toml"
        ? removeTomlConfig(agent)
        : removeJsonConfig(agent);
      if (configRemoved === null) {
        console.error(`[${agent.name}] MCP config could not be parsed; skill left intact`);
        continue;
      }
      console.log(`[${agent.name}] MCP config ${configRemoved ? "removed" : "not found"}`);

      const skillRemoved = removeSkill(agent);
      console.log(`[${agent.name}] Skill ${skillRemoved ? "removed" : "not found"}`);
    } catch (err: any) {
      console.error(`[${agent.name}] Failed to uninstall: ${err?.message ?? err}`);
    }
  }

  console.log(`\nDone! Cleaned ${selected.length} agent(s): ${selected.map((agent) => agent.name).join(", ")}`);
}

const EXAMPLE_CONFIG = `{
  "filters": {
    "exclude": ["**/*.lock", "**/*.min.js", "**/*.map"],
    "include": ["**/*.ts", "**/*.js", "**/*.go", "**/*.java", "**/*.py"]
  },
  "rules": [
    {
      "path": "**/*.ts",
      "rule": "Check for any types and proper null handling. Verify TypeScript best practices."
    },
    {
      "path": "**/*mapper*.xml",
      "rule": "Check SQL for injection risks (use parameterized queries) and missing closing tags."
    },
    {
      "path": "**/*.go",
      "rule": "Check for proper error handling (no ignored errors) and goroutine leaks."
    },
    {
      "path": "**/*.py",
      "rule": "Check for type hints, proper exception handling, and security issues (eval, exec, shell injection)."
    }
  ]
}
`;

/**
 * `init-config` subcommand: generate an example .code-review/rules.json
 * in the current directory. Does not overwrite if one already exists.
 */
function initConfig() {
  const configPath = path.join(process.cwd(), ".code-review", "rules.json");
  if (fs.existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    console.log("Remove it first if you want to regenerate with defaults.");
    return;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, EXAMPLE_CONFIG, "utf-8");
  console.log(`Created ${configPath}`);
  console.log("Edit it to add project-specific review rules. See README for format details.");
}

// Handle subcommands before starting the MCP server.
const subcommand = process.argv[2];
if (subcommand === "setup" || subcommand === "install-skill") {
  setup();
  process.exit(0);
}
if (subcommand === "init-config") {
  initConfig();
  process.exit(0);
}
if (subcommand === "uninstall") {
  uninstall();
  process.exit(0);
}

/**
 * Create and start the MCP server with 7 tools.
 */
async function main() {
  const server = new Server(
    { name: "code-review-mcp", version: "0.1.4" },
    { capabilities: { tools: {} } }
  );

  // --- Tool definitions ---
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "get_review_targets",
        description:
          "Determine which files need review from a git diff. Applies file filtering and returns a diff_ref to pass to downstream tools.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["workspace", "range", "commit"],
              description: "workspace: staged+unstaged+untracked; range: from..to; commit: commit^..commit",
            },
            from: { type: "string", description: "Required when mode=range" },
            to: { type: "string", description: "Required when mode=range" },
            commit: { type: "string", description: "Required when mode=commit" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["mode"],
        },
      },
      {
        name: "get_file_bundle",
        description:
          "Group related files into review bundles (test/source pairs, i18n variants) with a 20000 char cap. Pass the diff_ref from get_review_targets.",
        inputSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "File paths from get_review_targets",
            },
            diff_ref: { type: "string", description: "Default HEAD; pass the diff_ref from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["files"],
        },
      },
      {
        name: "match_rules",
        description:
          "Return applicable review rules for a file path, merged into a prompt_section for the host LLM.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to match rules against" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path"],
        },
      },
      {
        name: "search_code",
        description:
          "Cross-file text-level search via `git grep`. Use to gather evidence before reporting cross-file issues (e.g., confirming a symbol has no other callers). Search source adapts to diff_ref: workspace mode searches the worktree including untracked files; range/commit mode searches the corresponding revision. Results respect .code-review/rules.json filters.exclude.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Literal or extended-regex pattern for git grep -E" },
            path_glob: { type: "string", description: "Optional glob restricting which paths to search" },
            max_results: { type: "number", description: "Maximum matches to return (default 50)" },
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["query", "diff_ref"],
        },
      },
      {
        name: "read_file_context",
        description:
          "Read a bounded slice of a file for cross-file evidence gathering. Two range modes (mutually exclusive): anchor_line + before/after, or start_line + end_line. Reads via the same ref-then-worktree fallback as position_comment/reflect_comment. Caps output at max_lines (default 200).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repository-relative file path" },
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            anchor_line: { type: "number", description: "Anchor line (1-indexed); use with before/after" },
            before: { type: "number", description: "Lines before the anchor (default 10)" },
            after: { type: "number", description: "Lines after the anchor (default 10)" },
            start_line: { type: "number", description: "Explicit start line (1-indexed); alternative to anchor mode" },
            end_line: { type: "number", description: "Explicit end line (1-indexed); alternative to anchor mode" },
            max_lines: { type: "number", description: "Maximum lines to return (default 200)" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path", "diff_ref"],
        },
      },
      {
        name: "position_comment",
        description:
          "Locate a comment to precise line numbers. Text matching primary (hunk new-side, then old-side, then full file), hunk alignment fallback. Pass diff_ref from get_review_targets.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string", description: "Comment text" },
            existing_code: { type: "string", description: "Code snippet the comment references" },
            suggestion_code: { type: "string", description: "Suggested fix code" },
            hint_line: { type: "number", description: "Rough line number from host LLM" },
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "reflect_comment",
        description:
          "Deterministic validation of a positioned comment. Returns keep or drop. Does not call LLM. Four checks: line_in_hunk, existing_code_found, existing_code_in_diff, evidence_valid. The evidence field is optional — when omitted, evidence_valid passes vacuously (backward compatible).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            start_line: { type: "number", description: "From position_comment" },
            end_line: { type: "number", description: "From position_comment" },
            existing_code: { type: "string", description: "Code snippet the comment references" },
            evidence: {
              type: "array",
              description: "Optional cross-file evidence snippets referenced by the comment. Each entry is validated against its file content.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Repository-relative path of the evidence file" },
                  start_line: { type: "number", description: "Optional 1-indexed start line" },
                  end_line: { type: "number", description: "Optional 1-indexed end line" },
                  snippet: { type: "string", description: "Verbatim snippet text the comment claims to reference" },
                },
                required: ["path", "snippet"],
              },
            },
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path", "content", "start_line", "end_line"],
        },
      },
      {
        name: "get_lint_findings",
        description:
          "Run project linters (ESLint, tsc, ruff, go vet, cargo clippy) on changed files and return findings as ground-truth signals. Only runs linters that are configured in the repo. Never fails — missing linters return empty findings with a reason.",
        inputSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "File paths to lint (from get_review_targets)",
            },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["files"],
        },
      },
      {
        name: "scan_secrets",
        description:
          "Scan added diff lines for hardcoded secrets (AWS keys, private keys, API tokens). Returns findings with masked matched text. Only scans added lines, not context or deleted lines.",
        inputSchema: {
          type: "object",
          properties: {
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["diff_ref"],
        },
      },
      {
        name: "check_dependency_diff",
        description:
          "Compare a dependency manifest (package.json, requirements.txt, go.mod) before and after a diff_ref. Returns added, removed, and unpinned dependencies. Use to flag supply-chain risks in dependency changes.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Manifest file path (e.g., package.json)" },
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path"],
        },
      },
      {
        name: "get_file_history_stats",
        description:
          "Get commit history statistics for a file: total commits, fix-commit ratio, last modified date. Use to prioritize review attention on frequently-changed or bug-prone files.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repository-relative file path" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path"],
        },
      },
      {
        name: "run_affected_tests",
        description:
          "Execute the project's declared `test` script from package.json. Returns exit code, stdout, stderr, and timeout status. Only runs `npm run test` — does NOT accept arbitrary commands. Default timeout: 60 seconds.",
        inputSchema: {
          type: "object",
          properties: {
            timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000)" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
        },
      },
      {
        name: "get_importers",
        description:
          "Find all files that import a given file (reverse dependency lookup). Uses static import/require/export-from parsing. Only processes .ts/.tsx/.js/.jsx/.mjs/.cjs files. Skips node_modules, dist, build directories.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repository-relative file path" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path"],
        },
      },
      {
        name: "dedupe_comments",
        description:
          "Deduplicate review comments by text similarity. Computes Jaccard similarity of normalized content and compares existing_code. Comments with similarity >= threshold (default 0.6) and matching existing_code are considered duplicates. Does NOT call any LLM.",
        inputSchema: {
          type: "object",
          properties: {
            comments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                  existing_code: { type: "string" },
                },
                required: ["path", "content"],
              },
            },
            similarity_threshold: { type: "number", description: "Default 0.6" },
          },
          required: ["comments"],
        },
      },
    ],
  }));

  // --- Tool handlers ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const repo = (args?.repo as string) || process.cwd();

    try {
      switch (name) {
        case "get_review_targets":
          return await handleGetReviewTargets(args, repo);
        case "get_file_bundle":
          return await handleGetFileBundle(args, repo);
        case "match_rules":
          return await handleMatchRules(args, repo);
        case "search_code":
          return await handleSearchCode(args, repo);
        case "read_file_context":
          return await handleReadFileContext(args, repo);
        case "position_comment":
          return await handlePositionComment(args, repo);
        case "reflect_comment":
          return await handleReflectComment(args, repo);
        case "get_lint_findings":
          return await handleGetLintFindings(args, repo);
        case "scan_secrets":
          return await handleScanSecrets(args, repo);
        case "check_dependency_diff":
          return await handleCheckDependencyDiff(args, repo);
        case "get_file_history_stats":
          return await handleGetFileHistoryStats(args, repo);
        case "run_affected_tests":
          return await handleRunAffectedTests(args, repo);
        case "get_importers":
          return await handleGetImporters(args, repo);
        case "dedupe_comments":
          return await handleDedupeComments(args, repo);
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Handler implementations ---

async function handleGetReviewTargets(args: any, repo: string) {
  const mode = args?.mode as string;
  let diffRef: string;
  let diffText: string;

  if (mode === "workspace") {
    diffRef = "HEAD";
    diffText = await getDiff(repo, "HEAD");
    // Add untracked files as synthesized full-file-add diffs.
    const untracked = await getUntrackedFiles(repo);
    for (const file of untracked) {
      if (isBinaryByExtension(file)) continue;
      const synth = await synthesizeUntrackedDiff(repo, file);
      if (synth) diffText += "\n" + synth;
    }
  } else if (mode === "range") {
    const from = args?.from as string;
    const to = args?.to as string;
    if (!from || !to) throw new Error("mode=range requires 'from' and 'to'");
    diffRef = `${from}..${to}`;
    diffText = await getDiff(repo, diffRef);
  } else if (mode === "commit") {
    const commit = args?.commit as string;
    if (!commit) throw new Error("mode=commit requires 'commit'");
    diffRef = `${commit}^..${commit}`;
    diffText = await getDiff(repo, diffRef);
  } else {
    throw new Error(`Invalid mode: ${mode}. Use workspace, range, or commit.`);
  }

  // Parse diffs to get file list, skipping binary files (per design: binary
  // files are not reviewable content and must not reach the host).
  const fileDiffs = parseFileDiffs(diffText);
  const allPaths = fileDiffs
    .filter((d) => !d.isBinary)
    .map((d) => d.newPath || d.oldPath)
    .filter((p) => p && !p.includes("/dev/null"));

  // Apply filtering.
  const filterConfig = await loadFilterConfig(repo);
  const { kept, filtered } = filterFiles(allPaths, filterConfig);

  // Build result with per-file diff.
  const files = kept.map((path) => {
    const fd = fileDiffs.find((d) => (d.newPath || d.oldPath) === path);
    const status: "added" | "modified" | "deleted" | "renamed" =
      fd?.isNew ? "added" : fd?.isDeleted ? "deleted" : fd?.isRenamed ? "renamed" : "modified";
    return {
      path,
      diff: fd?.diff ?? "",
      additions: fd?.insertions ?? 0,
      deletions: fd?.deletions ?? 0,
      status,
    };
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          diff_ref: diffRef,
          files,
          total_files: files.length,
          filtered_out: filtered,
        }),
      },
    ],
  };
}

async function handleGetFileBundle(args: any, repo: string) {
  const files = (args?.files as string[]) ?? [];
  const diffRef = (args?.diff_ref as string) ?? "HEAD";
  const bundles = await bundleFiles(repo, files, diffRef);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          bundles: bundles.map((b) => ({
            id: b.id,
            files: b.files,
            total_chars: b.totalChars,
            bundle_reason: b.bundleReason,
            ...(b.keyDiff ? { key_diff: b.keyDiff } : {}),
          })),
          total_bundles: bundles.length,
        }),
      },
    ],
  };
}

async function handleMatchRules(args: any, repo: string) {
  const path = args?.path as string;
  const result = await matchRules(repo, path);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          path: result.path,
          matched_rules: result.matchedRules,
          prompt_section: result.promptSection,
          used_default: result.usedDefault,
        }),
      },
    ],
  };
}

async function handlePositionComment(args: any, repo: string) {
  const result = await positionComment(repo, {
    path: args?.path,
    content: args?.content,
    existingCode: args?.existing_code,
    suggestionCode: args?.suggestion_code,
    hintLine: args?.hint_line,
    diffRef: args?.diff_ref,
    repo,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          path: result.path,
          start_line: result.startLine,
          end_line: result.endLine,
          located_by: result.locatedBy,
        }),
      },
    ],
  };
}

async function handleReflectComment(args: any, repo: string) {
  const result = await reflectComment(repo, {
    path: args?.path,
    content: args?.content,
    startLine: args?.start_line,
    endLine: args?.end_line,
    existingCode: args?.existing_code,
    evidence: args?.evidence,
    diffRef: args?.diff_ref,
    repo,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          verdict: result.verdict,
          reason: result.reason,
          checks: result.checks,
        }),
      },
    ],
  };
}

async function handleSearchCode(args: any, repo: string) {
  const result = await searchCode(repo, {
    query: args?.query,
    pathGlob: args?.path_glob,
    maxResults: args?.max_results,
    diffRef: args?.diff_ref ?? "HEAD",
    repo,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          query: result.query,
          diff_ref: result.diffRef,
          matches: result.matches,
          total_matches: result.totalMatches,
          truncated: result.truncated,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      },
    ],
  };
}

async function handleReadFileContext(args: any, repo: string) {
  const result = await readFileContext(repo, {
    path: args?.path,
    diffRef: args?.diff_ref ?? "HEAD",
    anchorLine: args?.anchor_line,
    before: args?.before,
    after: args?.after,
    startLine: args?.start_line,
    endLine: args?.end_line,
    maxLines: args?.max_lines,
    repo,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          path: result.path,
          diff_ref: result.diffRef,
          start_line: result.startLine,
          end_line: result.endLine,
          content: result.content,
          truncated: result.truncated,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      },
    ],
  };
}

async function handleGetLintFindings(args: any, repo: string) {
  const files = (args?.files as string[]) ?? [];
  const result = await getLintFindings(repo, { files });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tools_run: result.toolsRun,
          findings: result.findings,
          total_findings: result.findings.length,
          ...(result.timedOut ? { timed_out: result.timedOut } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      },
    ],
  };
}

async function handleScanSecrets(args: any, repo: string) {
  const diffRef = (args?.diff_ref as string) ?? "HEAD";
  const result = await scanSecrets(repo, { diffRef });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          findings: result.findings,
          total_findings: result.findings.length,
        }),
      },
    ],
  };
}

async function handleCheckDependencyDiff(args: any, repo: string) {
  const manifestPath = args?.path as string;
  const diffRef = (args?.diff_ref as string) ?? "HEAD";
  const result = await checkDependencyDiff(repo, { path: manifestPath, diffRef });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          added: result.added,
          removed: result.removed,
          unpinned: result.unpinned,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      },
    ],
  };
}

async function handleGetFileHistoryStats(args: any, repo: string) {
  const filePath = args?.path as string;
  const result = await getFileHistoryStats(repo, { path: filePath });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          total_commits: result.totalCommits,
          last_modified: result.lastModified,
          fix_commit_ratio: result.fixCommitRatio,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      },
    ],
  };
}

async function handleRunAffectedTests(args: any, repo: string) {
  const timeoutMs = args?.timeout_ms as number | undefined;
  const result = await runAffectedTests(repo, { timeoutMs });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.reason ? { reason: result.reason } : {}),
        }),
      },
    ],
  };
}

async function handleGetImporters(args: any, repo: string) {
  const filePath = args?.path as string;
  const result = await getImporters(repo, { path: filePath });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          path: result.path,
          importers: result.importers,
          total_importers: result.importers.length,
        }),
      },
    ],
  };
}

async function handleDedupeComments(args: any, _repo: string) {
  const comments = (args?.comments as any[]) ?? [];
  const similarityThreshold = args?.similarity_threshold as number | undefined;
  const result = dedupeComments({
    comments: comments.map((c) => ({
      path: c.path,
      content: c.content,
      existingCode: c.existing_code,
    })),
    similarityThreshold,
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kept: result.kept,
          dropped: result.dropped,
          total_kept: result.kept.length,
          total_dropped: result.dropped.length,
        }),
      },
    ],
  };
}

main().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
