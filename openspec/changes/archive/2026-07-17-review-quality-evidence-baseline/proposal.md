## Why

本项目对标 alibaba/open-code-review 时，最大的审查质量差距是：宿主 LLM 缺少标准化的跨文件证据获取手段，且 `reflect_comment` 只验证评论定位的真实性，不验证评论所引用的跨文件证据是否真实存在。这导致误报率高（规则要求"确认调用链/数据源"却无工具可用）且质量随宿主模型能力波动。在不违反"server 不调 LLM"这一核心约束的前提下，可以把跨文件证据获取做成确定性工具，把证据真实性校验做成确定性检查，从而系统性压低误报率。

## What Changes

- 新增 `search_code` 工具：基于 `git grep` 的文本级跨文件检索，按 `diff_ref` 选择搜索源（workspace 搜工作区含未跟踪文件；range/commit 搜对应 revision），复用 `.code-review/rules.json` 的 `filters.exclude`，结果数受 `max_results` 硬上限约束。
- 新增 `read_file_context` 工具：按锚点+前后行数或显式行区间读取文件的有限上下文，复用现有 ref/worktree 回退解析逻辑，受 `max_lines` 硬上限约束。
- 扩展 `reflect_comment`：新增可选输入字段 `evidence`（引用的跨文件片段列表）和新检查项 `evidence_valid`（校验每条证据的 `snippet` 是否真实存在于其 `path`）。`evidence` 缺省时该检查恒为通过（vacuous pass），保证现有调用方零改动兼容。
- 扩展 `match_rules` 的内置规则表：从单一通用规则扩展为按扩展名/路径匹配的语言/文件类型专属规则表（首批覆盖 TS/JS/TSX/JSX、JSON、YAML、GitHub Actions workflow、`package.json`），无匹配时回退现有通用默认规则。
- 更新 `skills/code-review/SKILL.md`：新增证据获取时机指引（怀疑跨文件影响时先取证再报告）、`position_comment` 定位失败的恢复流程（用 `read_file_context` 重新取上下文后重试一次）、多文件重复问题的宿主侧去重要求。

## Capabilities

### New Capabilities

<!-- 本次不引入新 capability；所有变更都是对现有 code-review-mcp capability 的需求扩展。 -->

### Modified Capabilities

- `code-review-mcp`: 新增两个确定性工具（`search_code`、`read_file_context`）及其编排契约；`reflect_comment` 新增 `evidence_valid` 检查项；`match_rules` 的内置默认规则从单条通用规则扩展为按路径匹配的规则表。

## Impact

- **受影响代码**：`src/rules.ts`（规则表结构调整）、`src/reflect.ts`（新检查项）、`src/types.ts`（新增 `EvidenceRef`、`ReflectInput.evidence`、`CheckResult.name` 枚举扩展）、`src/index.ts`（注册 2 个新工具）；新增 `src/search-code.ts`、`src/read-file-context.ts`。
- **受影响测试**：新增 `search-code.test.ts`、`read-file-context.test.ts`；扩展 `reflect.test.ts`、`rules.test.ts`；`cli.test.ts`/`package.test.ts`/`bundler.test.ts`/`position.test.ts` 作回归验证。
- **受影响文档**：`skills/code-review/SKILL.md`（编排协议更新）、`README.md`（工具列表从 5 个更新为 7 个）。
- **不受影响**：`get_review_targets`、`get_file_bundle`、`position_comment` 的既有行为；MCP server 的无状态特性；server 不调 LLM 的边界（本次两个新工具和一个新检查项均为纯确定性逻辑，不引入任何 LLM 调用或新增运行时依赖）。
- **不做（明确排除）**：AST/符号解析、agent loop/plan/batch/跨 bundle 去重、suggestion-diff 渲染——留给后续迭代或不做。
