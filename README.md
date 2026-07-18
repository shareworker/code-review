# @shareworker/code-review-mcp

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

An MCP server that exposes the deterministic engineering layer of code review as
tools, callable by host agents (Claude Code, Cursor, Codex, Devin) within their
own LLM loops. The server never calls an LLM — all reasoning happens in the host
session.

### Why

General-purpose agents doing code review via Skills suffer from: incomplete
coverage (skipping files on large changesets), position drift (line numbers
don't match actual code), and unstable quality (minor prompt variations cause
large quality swings). This server enforces hard constraints on the review
process — file selection, smart bundling, rule matching, comment positioning,
and comment reflection — so quality is stable regardless of host model variation.

### Tools

| Tool | Purpose |
|------|---------|
| `get_review_targets` | Git diff → file filtering → `diff_ref` + file list |
| `get_file_bundle` | Smart bundling (test/source + i18n) with 20000 char cap, density-sorted, i18n key consistency diff |
| `match_rules` | Path-based rule matching → `prompt_section` for host LLM |
| `search_code` | Cross-file text search via `git grep` — gather evidence before reporting cross-file issues |
| `read_file_context` | Bounded file slice reader — anchored or explicit line range, ref-then-worktree fallback |
| `position_comment` | Text match + hunk align + fuzzy match → precise line numbers |
| `reflect_comment` | Deterministic validation (keep/drop) — 4 checks including `evidence_valid` — no LLM |
| `get_lint_findings` | Run project linters (ESLint, golangci-lint, ruff) on changed files → ground-truth findings |
| `scan_secrets` | Scan added diff lines for hardcoded secrets (AWS keys, PEM, API tokens) — masked output |
| `check_dependency_diff` | Compare package.json/requirements.txt/go.mod before vs after → added/removed/unpinned deps |
| `get_file_history_stats` | File commit history → total commits, fix-commit ratio, last modified — prioritize review attention |
| `run_affected_tests` | Execute `npm run test` with timeout → exit code, stdout, stderr — no arbitrary commands |
| `get_importers` | Reverse dependency lookup — find all files that import a given file (static analysis) |
| `dedupe_comments` | Deduplicate review comments by Jaccard text similarity + existing_code match — no LLM |

### Design Lineage

This project's split between deterministic engineering and LLM reasoning is
inspired by [alibaba/open-code-review](https://github.com/alibaba/open-code-review),
a battle-tested CLI that runs both halves itself (agent loop, concurrency,
multi-tier comment positioning, language-specific rules). This project exposes
only the deterministic half as MCP tools, so any MCP-compatible host agent can
supply the reasoning half using its own model. It is a narrower, host-agnostic
subset, not a feature-equivalent reimplementation.

### Installation

One command — auto-detects your agent, writes MCP config, installs the skill:

```bash
npx @shareworker/code-review-mcp setup
```

Works on macOS, Linux, and Windows. If you prefer a global install so you can
call `code-review-mcp` directly:

```bash
npm install -g @shareworker/code-review-mcp
code-review-mcp setup
```

To install the agent config and skill into your user home directory instead of the current project:

```bash
npx @shareworker/code-review-mcp setup --global
npx @shareworker/code-review-mcp setup --global --agent claude
```

That's it. Restart your agent and the `code-review` MCP server is available.

<details>
<summary>What does <code>setup</code> do?</summary>

It detects which agents are present (`.claude/`, `.cursor/`, `.devin/`, `.codex/`) — or checks your home directory when `--global` is used — and for each:

1. Writes the MCP server entry into the agent's config file (merges with existing config)
2. Copies `SKILL.md` into the agent's skill directory

To set up a specific agent only: `code-review-mcp setup --agent claude` (also: `cursor`, `devin`, `codex`)
</details>

### Uninstall

Remove this package's project-local MCP entry and installed skill, while preserving other agent configuration and review rules:

```bash
npx @shareworker/code-review-mcp uninstall
npx @shareworker/code-review-mcp uninstall --agent devin

# remove from user home directory
npx @shareworker/code-review-mcp uninstall --global
npx @shareworker/code-review-mcp uninstall --global --agent devin
```

If you installed globally, you can use `code-review-mcp uninstall` instead of `npx`.

<details>
<summary>What does <code>uninstall</code> do?</summary>

For each detected agent (or only the one passed via `--agent`):

1. Removes the `code-review` entry from the agent's MCP config (leaves other entries intact)
2. Deletes the installed skill file (`SKILL.md`, or `code-review.mdc` for Cursor) and the skill directory if it becomes empty

It does not remove the agent directory, other skills, `.code-review/rules.json`, or the npm package.
</details>

<details>
<summary>Manual configuration (if you prefer)</summary>

Add to your agent's MCP config (`.claude/mcp.json` / `.cursor/mcp.json` / `.devin/config.json` / `.codex/config.toml`):

```json
{
  "mcpServers": {
    "code-review": {
      "command": "npx",
      "args": ["-y", "@shareworker/code-review-mcp"]
    }
  }
}
```

For Codex (TOML format), add this section to `.codex/config.toml` instead:

```toml
[mcp_servers.code-review]
command = "npx"
args = ["-y", "@shareworker/code-review-mcp"]
```
</details>

### Configuration

**Optional** — the server works out of the box with built-in default rules:
language-specific rules for TS/JS/TSX/JSX, Python, Go, Java, C/C++, Rust, QML/Qt,
JSON, YAML, XML (SQL mapper), GitHub Actions workflows, Dockerfiles, and
`package.json`, plus a generic default covering correctness, security,
performance, maintainability, and test coverage.
Only create `.code-review/rules.json` when you need project-specific rules.

To generate an example config in your repo:

```bash
npx @shareworker/code-review-mcp init-config
```

Or create `.code-review/rules.json` manually (or `~/.code-review/rules.json`
for global config):

```json
{
  "filters": {
    "exclude": ["**/*.lock", "**/*.min.js", "**/*.map"],
    "include": ["**/*.ts", "**/*.js"]
  },
  "rules": [
    {
      "path": "**/*.ts",
      "rule": "Check for any types and proper null handling"
    },
    {
      "path": "**/*mapper*.xml",
      "rule": "Check SQL for injection risks and missing closing tags"
    }
  ]
}
```

#### Configuration Resolution Priority

1. `--rule <path>` flag (highest) — not exposed via MCP, reserved for future CLI
2. `<repo>/.code-review/rules.json` — project-level
3. `~/.code-review/rules.json` — global/user-level
4. Built-in defaults (lowest) — covers correctness, security, performance,
   maintainability, test coverage

For MVP, only layers 2-4 are active (the `--rule` flag is not yet exposed via the CLI).
The first matching user rule replaces the built-in system rule at the same layer.

#### `filters`

- `exclude`: glob patterns for files to exclude (merged with built-in defaults)
- `include`: glob patterns — when present, only matching files are reviewed

#### `rules`

Array of `{ "path": "<glob>", "rule": "<text>" }`. First match wins. The `rule`
text is returned as `prompt_section` for the host LLM to inject into its review
prompt.

### Development

```bash
npm install
npm run build      # compile TypeScript
npm test           # run unit tests
npm run dev        # watch mode
```

### License

MIT

---

<a id="中文"></a>

## 中文

一个 MCP 服务器，将代码审查的确定性工程层封装为工具，供宿主代理（Claude Code、
Cursor、Codex、Devin）在自身的 LLM 循环中调用。服务器自身不调用任何 LLM —— 所有推理
都在宿主会话中完成。

### 为什么需要

通用代理通过 Skill 做代码审查时存在三大问题：覆盖不完整（大变更集时跳过文件）、
定位漂移（行号与实际代码不匹配）、质量不稳定（提示词微小变化导致质量大幅波动）。
本服务器对审查流程施加硬约束 —— 文件选择、智能打包、规则匹配、评论定位、
评论反思 —— 使质量不受宿主模型变化影响。

### 工具

| 工具 | 职责 |
|------|------|
| `get_review_targets` | Git diff → 文件过滤 → 返回 `diff_ref` + 文件列表 |
| `get_file_bundle` | 智能打包（测试/源码配对 + i18n 配对），20000 字符上限，密度排序，i18n key 一致性 diff |
| `match_rules` | 路径匹配规则 → 返回 `prompt_section` 供宿主 LLM 注入 |
| `search_code` | 跨文件文本检索（`git grep`）—— 报告跨文件问题前先取证 |
| `read_file_context` | 有限范围文件读取 —— 锚点或显式行区间，ref/worktree 回退 |
| `position_comment` | 文本匹配 + hunk 对齐 + 模糊匹配 → 精确行号 |
| `reflect_comment` | 确定性验证（保留/丢弃）—— 4 项检查含 `evidence_valid` —— 不调用 LLM |
| `get_lint_findings` | 运行项目 linter（ESLint、golangci-lint、ruff）→ ground-truth 发现 |
| `scan_secrets` | 扫描新增 diff 行中的硬编码密钥（AWS key、PEM、API token）—— 输出已脱敏 |
| `check_dependency_diff` | 对比 package.json/requirements.txt/go.mod 变更前后 → 新增/删除/未锁定依赖 |
| `get_file_history_stats` | 文件提交历史 → 总提交数、修复提交比例、最后修改时间 —— 用于审查优先级 |
| `run_affected_tests` | 执行 `npm run test`（带超时）→ 退出码、stdout、stderr —— 不接受任意命令 |
| `get_importers` | 反向依赖查找 —— 找出所有 import 指定文件的文件（静态分析） |
| `dedupe_comments` | 按 Jaccard 文本相似度 + existing_code 匹配去重评论 —— 不调用 LLM |

### 安装

一条命令——自动检测你的 agent，写入 MCP 配置，安装 skill：

```bash
npx @shareworker/code-review-mcp setup
```

适用于 macOS、Linux、Windows。如需全局安装后直接使用 `code-review-mcp` 命令：

```bash
npm install -g @shareworker/code-review-mcp
code-review-mcp setup
```

如需把 agent 配置和 skill 安装到用户主目录（而非当前项目）：

```bash
npx @shareworker/code-review-mcp setup --global
npx @shareworker/code-review-mcp setup --global --agent claude
```

完成。重启 agent 即可使用 `code-review` MCP 服务器。

<details>
<summary><code>setup</code> 做了什么？</summary>

检测项目中存在哪些 agent（`.claude/`、`.cursor/`、`.devin/`、`.codex/`），带 `--global` 时则检测用户主目录，对每个 agent：

1. 将 MCP 服务器配置写入 agent 的配置文件（与已有配置合并）
2. 将 `SKILL.md` 复制到 agent 的 skill 目录（Cursor 使用 `.cursor/rules/code-review.mdc`）

仅安装指定 agent：`npx @shareworker/code-review-mcp setup --agent claude`（也可：`cursor`、`devin`、`codex`）
</details>

### 卸载

仅移除本包写入的项目级 MCP 配置和安装的 skill，保留其他 agent 配置与 review 规则：

```bash
npx @shareworker/code-review-mcp uninstall
npx @shareworker/code-review-mcp uninstall --agent devin

# 移除用户主目录中的配置
npx @shareworker/code-review-mcp uninstall --global
npx @shareworker/code-review-mcp uninstall --global --agent devin
```

如已全局安装，可直接使用 `code-review-mcp uninstall` 代替 `npx`。

<details>
<summary><code>uninstall</code> 做了什么？</summary>

对每个检测到的 agent（或通过 `--agent` 指定的 agent）：

1. 从 agent 的 MCP 配置中移除 `code-review` 条目（保留其他条目）
2. 删除已安装的 skill 文件（`SKILL.md`，Cursor 为 `code-review.mdc`），若 skill 目录因此变空则一并删除

不会删除 agent 目录、其他 skill、`.code-review/rules.json` 或 npm 包。
</details>

<details>
<summary>手动配置（如果你更喜欢）</summary>

将以下内容添加到 agent 的 MCP 配置（`.claude/mcp.json` / `.cursor/mcp.json` / `.devin/config.json` / `.codex/config.toml`）：

```json
{
  "mcpServers": {
    "code-review": {
      "command": "npx",
      "args": ["-y", "@shareworker/code-review-mcp"]
    }
  }
}
```

Codex 使用 TOML 格式，请在 `.codex/config.toml` 中添加以下段落：

```toml
[mcp_servers.code-review]
command = "npx"
args = ["-y", "@shareworker/code-review-mcp"]
```
</details>

### 配置

**可选** —— 服务器开箱即用，内置默认规则：针对 TS/JS/TSX/JSX、Python、Go、Java、
C/C++、Rust、QML/Qt、JSON、YAML、XML（SQL Mapper）、GitHub Actions workflow、
Dockerfile、`package.json` 的语言专属规则，以及覆盖正确性、安全性、性能、
可维护性、测试覆盖率的通用默认规则。
仅在需要项目特定规则时才创建 `.code-review/rules.json`。

在仓库中生成示例配置：

```bash
npx @shareworker/code-review-mcp init-config
```

或手动创建 `.code-review/rules.json`（或 `~/.code-review/rules.json` 作为全局配置）：

```json
{
  "filters": {
    "exclude": ["**/*.lock", "**/*.min.js", "**/*.map"],
    "include": ["**/*.ts", "**/*.js"]
  },
  "rules": [
    {
      "path": "**/*.ts",
      "rule": "检查 any 类型和空值处理"
    },
    {
      "path": "**/*mapper*.xml",
      "rule": "检查 SQL 注入风险和标签闭合"
    }
  ]
}
```

#### 配置优先级

1. `--rule <path>` 命令行参数（最高）—— MCP 未暴露，预留给未来 CLI
2. `<repo>/.code-review/rules.json` —— 项目级
3. `~/.code-review/rules.json` —— 全局/用户级
4. 内置默认规则（最低）—— 覆盖正确性、安全性、性能、可维护性、测试覆盖率

MVP 版本仅启用 2-4 层（`--rule` 参数尚未通过 CLI 暴露）。同一层中首个匹配的用户规则
替换内置系统规则。

#### `filters`

- `exclude`：排除文件的 glob 模式（与内置默认黑名单合并）
- `include`：包含文件的 glob 模式 —— 存在时仅审查匹配的文件

#### `rules`

`{ "path": "<glob>", "rule": "<文本>" }` 数组。首个匹配生效。`rule` 文本作为
`prompt_section` 返回，供宿主 LLM 注入审查提示词。

### 开发

```bash
npm install
npm run build      # 编译 TypeScript
npm test           # 运行单元测试
npm run dev        # 监听模式
```

### 许可证

MIT
