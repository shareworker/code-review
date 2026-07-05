## Why

通用 agent（Claude/Codex/Devin）靠纯语言驱动做 code review 时，存在三个稳定性问题：大变更集漏文件、评论行号对不上实际代码、prompt 微调导致质量大幅波动。根因是缺少对 review 过程的硬约束。open-code-review 已验证"确定性工程 × agent 混合"能解决这些问题，但它自带 LLM，与 host session 的 LLM 和 agent 循环重复。我们需要把确定性工程层抽成 MCP server，让 host agent 在自己的 LLM 循环里调用，server 不碰 LLM——既保留稳定性来源，又真正活在 host session 内。

## What Changes

- 新增 `@shareworker/code-review-mcp` npm 包：一个 stdio 传输的 MCP server，零配置（`npx -y @shareworker/code-review-mcp` 即用）。
- 暴露 5 个确定性工具：
  - `get_review_targets`：从 git diff 算出待 review 文件，应用过滤规则，返回 `diff_ref` + 文件列表。
  - `get_file_bundle`：按 test/source 配对、i18n 变体把文件打包成 review 单元，受 20000 字符上限约束。
  - `match_rules`：按文件路径匹配 review 规则，合并为 `prompt_section` 供 host 注入 prompt。
  - `position_comment`：把 host LLM 生成的评论精确定位到文件行号（文本匹配优先 → hunk 对齐 → 兜底 0,0）。
  - `reflect_comment`：对已定位的评论做三项确定性检查（行号在 hunk 内、引用代码存在、引用代码在改动行内），返回 keep/drop。
- 新增 host agent 编排 skill（`skills/code-review/SKILL.md`）：规定 host 必须按 `get_review_targets → get_file_bundle → (match_rules + 生成评论 + position_comment + reflect_comment) → 过滤 drop → 输出` 的流程调用，并强制传递 `diff_ref`。
- 新增配置约定 `.code-review/rules.json`：`filters.include/exclude`（glob 过滤）+ `rules`（按路径匹配的 review 提示词），优先级 `--rule` flag > repo > home > 内置默认。
- 新增项目骨架：TypeScript/Node，`simple-git` 做 git 操作，`diff` 库做 diff 解析，`@modelcontextprotocol/sdk` 做 MCP 传输。

## Capabilities

### New Capabilities

- `code-review-mcp`: MCP server 暴露的 5 个确定性工具及其编排契约。覆盖文件选择与过滤、智能打包、规则匹配、评论定位、评论反思五项确定性逻辑，以及 `diff_ref` 在管线中的流转契约。server 不调 LLM，所有 LLM 推理由 host agent 完成。

### Modified Capabilities

<!-- 无现有 spec，全部为新增。 -->

## Impact

- **新增代码**：`src/` 下 9 个模块（index/git/diff-parser/filter/bundler/rules/position/reflect/types），`skills/code-review/SKILL.md`，`.code-review/rules.json` 示例。
- **新增依赖**：`@modelcontextprotocol/sdk`、`simple-git`、`diff`；dev 依赖 TypeScript、测试框架。
- **新增分发**：发布到 npm 为 `@shareworker/code-review-mcp`，通过 `npx -y` 零预安装调用。
- **受影响系统**：host agent（Claude Code / Codex / Devin）通过 MCP client 连接本 server；host 侧需配置 MCP server 条目并安装编排 skill。
- **不受影响**：host session 的 LLM 凭证、原生文件读写、代码搜索能力——本 server 不触碰这些，只接收工具调用并返回结构化结果。
- **边界约束**：server 进程不崩溃（每工具 try/catch），无状态（每次调用独立，不维护 session），跨平台（Windows 路径、非 ASCII 文件名、CRLF/LF 统一 trim）。
