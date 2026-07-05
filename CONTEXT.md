# Code Review MCP

一个 MCP server，把代码 review 的确定性工程（文件选择、智能打包、规则匹配、评论定位、评论反思）做成工具，供 codex/claude/devin 等 host agent 在自己的 LLM 循环里调用。核心思想源自 open-code-review 的"确定性工程 × agent 混合"，但把 LLM 推理交给 host session，server 只做确定性逻辑。

## Language

**Host Agent**:
运行 LLM 推理和 agent 循环的 session 环境（codex / claude / devin）。它拥有 LLM 凭证、原生文件读写和代码搜索能力，是 review 推理的执行者。
_Avoid_: client, caller, IDE

**Deterministic Core**:
MCP server 中不依赖 LLM 的逻辑层，负责文件选择、智能打包、规则匹配、评论定位、评论反思。所有 LLM 推理在 host agent 侧，server 不碰 LLM。
_Avoid_: engine, pipeline, backend

**Review Target**:
一次 review 中被选中、通过过滤规则后进入 review 的文件。由 `get_review_targets` 工具从 git diff 算出。
_Avoid_: reviewed file, change

**File Bundle**:
按相关性（test/source 配对、i18n 变体）打包成的一个 review 单元。受字符数上限约束。由 `get_file_bundle` 工具产出，host agent 对一个 bundle 内的文件一起 review。
_Avoid_: group, package, unit

**Review Rule**:
按文件路径匹配的 review 提示词，由 `match_rules` 工具返回，合并为 `prompt_section` 供 host agent 拼进 review prompt。来源优先级：`--rule` flag > repo `.code-review/rules.json` > home `~/.code-review/rules.json` > 内置通用规则。
_Avoid_: guideline, check, lint

**Comment Positioning**:
把 host LLM 生成的评论精确定位到文件行号的过程。策略：文本匹配优先（从评论引用的代码片段在文件中搜索）→ hunk 对齐（用 diff 行号映射）→ 兜底 0,0（定位失败）。由 `position_comment` 工具执行。
_Avoid_: line mapping, anchoring

**Comment Reflection**:
对已定位的评论做确定性验证，判断 keep 或 drop。检查项：评论行号是否在 diff hunk 改动范围内、评论引用的代码是否真实存在、引用的代码是否属于改动行。不调 LLM，语义级反思由 host agent 自审。由 `reflect_comment` 工具执行。
_Avoid_: validation, filtering, scoring

**Diff Ref**:
一次 review 的 diff 范围的规范化 ref（如 `"HEAD"`、`"main..feature"`、`"abc123^..abc123"`）。由 `get_review_targets` 根据模式产出，host 必须把它传给 `get_file_bundle`、`position_comment`、`reflect_comment`，保证整条管线读同一个 diff。工具默认 `"HEAD"` 仅为 workspace 模式的便利默认值，range/commit 模式下不能依赖默认值。
_Avoid_: range, refspec, commit range
