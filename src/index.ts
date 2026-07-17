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
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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

const AGENTS: AgentConfig[] = [
  { name: "claude", dir: ".claude", configFile: ".claude/mcp.json", skillDir: ".claude/skills/code-review", configFormat: "json" },
  { name: "devin", dir: ".devin", configFile: ".devin/config.json", skillDir: ".devin/skills/code-review", configFormat: "json" },
  { name: "codex", dir: ".codex", configFile: ".codex/config.toml", skillDir: ".codex/skills/code-review", configFormat: "toml" },
];

function selectAgents(defaultToAll: boolean) {
  const agentIdx = process.argv.indexOf("--agent");
  const agentFlag = agentIdx !== -1 && agentIdx + 1 < process.argv.length
    ? process.argv[agentIdx + 1]
    : null;
  if (agentIdx !== -1 && !agentFlag) {
    console.error("--agent requires a value (claude, devin, or codex)");
    process.exit(1);
  }

  const selected = agentFlag
    ? AGENTS.filter((agent) => agent.name === agentFlag)
    : AGENTS.filter((agent) => fs.existsSync(agent.dir));
  if (selected.length === 0 && !agentFlag && defaultToAll) {
    console.log("No agent directories detected. Setting up for all supported agents.");
    return [...AGENTS];
  }
  if (selected.length === 0 && agentFlag) {
    console.error(`Unknown agent: ${agentFlag}. Supported: claude, devin, codex`);
    process.exit(1);
  }
  return selected;
}

/**
 * `setup` subcommand: one-command install.
 * Detects which agents are present in the project, writes MCP config entries,
 * and copies the skill file. Creates agent directories if they don't exist yet.
 *
 * Usage: npx @shareworker/code-review-mcp setup
 *        npx @shareworker/code-review-mcp setup --agent claude
 */
function setup() {
  const skillSrc = path.join(__dirname, "..", "skills", "code-review", "SKILL.md");
  if (!fs.existsSync(skillSrc)) {
    console.error(`Skill source not found: ${skillSrc}`);
    process.exit(1);
  }
  const skillContent = fs.readFileSync(skillSrc, "utf-8");

  const selected = selectAgents(true);

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
    return false;
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
  const selected = selectAgents(false);
  if (selected.length === 0) {
    console.log("No agent directories detected. Nothing to uninstall.");
    return;
  }

  for (const agent of selected) {
    try {
      const configRemoved = agent.configFormat === "toml"
        ? removeTomlConfig(agent)
        : removeJsonConfig(agent);
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
 * Create and start the MCP server with 5 tools.
 */
async function main() {
  const server = new Server(
    { name: "code-review-mcp", version: "0.1.3" },
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
        name: "position_comment",
        description:
          "Locate a comment to precise line numbers. Text matching primary (hunk new-side �?old-side �?full file), hunk alignment fallback. Pass diff_ref from get_review_targets.",
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
          "Deterministic validation of a positioned comment. Returns keep or drop. Does not call LLM. Three checks: line_in_hunk, existing_code_found, existing_code_in_diff.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            start_line: { type: "number", description: "From position_comment" },
            end_line: { type: "number", description: "From position_comment" },
            existing_code: { type: "string", description: "Code snippet the comment references" },
            diff_ref: { type: "string", description: "Default HEAD; pass from get_review_targets" },
            repo: { type: "string", description: "Repo path, default: cwd" },
          },
          required: ["path", "content", "start_line", "end_line"],
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
        case "position_comment":
          return await handlePositionComment(args, repo);
        case "reflect_comment":
          return await handleReflectComment(args, repo);
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

main().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
