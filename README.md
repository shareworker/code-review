# @shareworker/code-review-mcp

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

An MCP server that exposes the deterministic engineering layer of code review as
tools, callable by host agents (Claude Code, Codex, Devin) within their own LLM
loops. The server never calls an LLM — all reasoning happens in the host session.

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
| `get_file_bundle` | Smart bundling (test/source + i18n) with 20000 char cap |
| `match_rules` | Path-based rule matching → `prompt_section` for host LLM |
| `position_comment` | Text match + hunk align → precise line numbers |
| `reflect_comment` | Deterministic validation (keep/drop) — no LLM |

### Installation

One command — auto-detects your agent, writes MCP config, installs the skill:

```bash
# macOS / Linux
npx @shareworker/code-review-mcp setup

# Windows (PowerShell)
npm install -g @shareworker/code-review-mcp; code-review-mcp setup
```

That's it. Restart your agent and the `code-review` MCP server is available.

<details>
<summary>What does <code>setup</code> do?</summary>

It detects which agents are present (`.claude/`, `.devin/`, `.codex/`) and for each:

1. Writes the MCP server entry into the agent's config file (merges with existing config)
2. Copies `SKILL.md` into the agent's skill directory

To set up a specific agent only: `code-review-mcp setup --agent claude`
</details>

<details>
<summary>Manual configuration (if you prefer)</summary>

Add to your agent's MCP config (`.claude/mcp.json` / `.devin/config.json` / `.codex/config.json`):

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
</details>

### Configuration

**Optional** — the server works out of the box with built-in default rules
(correctness, security, performance, maintainability, test coverage). Only
create `.code-review/rules.json` when you need project-specific rules.

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

For MVP, only layers 2-4 are active (no `--rule` flag since there's no CLI).
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
Codex、Devin）在自身的 LLM 循环中调用。服务器自身不调用任何 LLM —— 所有推理
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
| `get_file_bundle` | 智能打包（测试/源码配对 + i18n 配对），20000 字符上限 |
| `match_rules` | 路径匹配规则 → 返回 `prompt_section` 供宿主 LLM 注入 |
| `position_comment` | 文本匹配 + hunk 对齐 → 精确行号 |
| `reflect_comment` | 确定性验证（保留/丢弃）—— 不调用 LLM |

### 安装

一条命令——自动检测你的 agent，写入 MCP 配置，安装 skill：

```bash
# macOS / Linux
npx @shareworker/code-review-mcp setup

# Windows (PowerShell)
npm install -g @shareworker/code-review-mcp; code-review-mcp setup
```

完成。重启 agent 即可使用 `code-review` MCP 服务器。

<details>
<summary><code>setup</code> 做了什么？</summary>

检测项目中存在哪些 agent（`.claude/`、`.devin/`、`.codex/`），对每个 agent：

1. 将 MCP 服务器配置写入 agent 的配置文件（与已有配置合并）
2. 将 `SKILL.md` 复制到 agent 的 skill 目录

仅安装指定 agent：`npx @shareworker/code-review-mcp setup --agent claude`
</details>

<details>
<summary>手动配置（如果你更喜欢）</summary>

将以下内容添加到 agent 的 MCP 配置（`.claude/mcp.json` / `.devin/config.json` / `.codex/config.json`）：

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
</details>

### 配置

**可选** —— 服务器开箱即用，内置默认规则（正确性、安全性、性能、可维护性、
测试覆盖率）。仅在需要项目特定规则时才创建 `.code-review/rules.json`。

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

MVP 版本仅启用 2-4 层（无 CLI 故无 `--rule` 参数）。同一层中首个匹配的用户规则
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
