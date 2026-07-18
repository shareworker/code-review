## MODIFIED Requirements

### Requirement: MCP server 暴露 5 个确定性工具

系统 SHALL 作为 stdio 传输的 MCP server 运行，注册并处理 7 个工具：`get_review_targets`、`get_file_bundle`、`match_rules`、`search_code`、`read_file_context`、`position_comment`、`reflect_comment`。系统 MUST NOT 调用任何 LLM；所有 LLM 推理由 host agent 完成。

#### Scenario: 零配置启动
- **WHEN** host 通过 `npx -y @shareworker/code-review-mcp` 启动 server
- **THEN** server 通过 stdio 建立 MCP 连接，无需任何预安装或配置文件即可响应工具调用

#### Scenario: server 进程不崩溃
- **WHEN** 任一工具处理过程中抛出异常
- **THEN** 该工具返回 MCP error response，server 进程保持存活并继续响应后续工具调用

#### Scenario: server 无状态
- **WHEN** 同一工具被连续调用多次
- **THEN** 每次调用独立处理，不依赖前序调用的内存状态；`search_code`、`read_file_context`、`position_comment`、`reflect_comment` 每次重新读取 git 状态或重新解析 diff

### Requirement: `match_rules` 返回规则 prompt_section

系统 SHALL 提供 `match_rules` 工具，接收 `path`、`repo`，按 glob 模式匹配 `.code-review/rules.json` 的 `rules` 数组（first match wins），合并为 `prompt_section` 纯文本供 host 注入 review prompt。无用户规则匹配时 SHALL 按 `path` 的扩展名/文件名在内置语言专属规则表中查找匹配项；表中也无匹配时 SHALL 回退到内置通用默认规则（覆盖 correctness/security/performance/maintainability/test-coverage）。任一内置规则生效时 `used_default=true`。

#### Scenario: 匹配到用户规则
- **WHEN** `path="src/foo.ts"` 且 rules.json 有 `{"path":"**/*.ts","rule":"Check for any types"}`
- **THEN** 返回 `matched_rules=[{pattern:"**/*.ts",rule:"Check for any types"}]`，`prompt_section` 包含该规则文本，`used_default=false`

#### Scenario: 无用户规则匹配到语言专属内置规则
- **WHEN** `path` 不匹配 `.code-review/rules.json` 中任何用户规则，但匹配内置语言专属规则表中的 `**/*.{ts,js,tsx,jsx}` 条目
- **THEN** 返回该语言专属规则文本作为 `prompt_section`，`used_default=true`

#### Scenario: 无任何匹配用内置通用默认
- **WHEN** `path` 既不匹配用户规则也不匹配内置语言专属规则表中任何条目
- **THEN** 返回内置通用规则，`used_default=true`，`prompt_section` 覆盖 correctness/security/performance/maintainability/test-coverage

#### Scenario: rules.json 缺失
- **WHEN** `<repo>/.code-review/rules.json` 不存在
- **THEN** 静默回退到内置语言专属规则表（若匹配）或内置通用规则，`used_default=true`

#### Scenario: rules.json 解析失败
- **WHEN** rules.json 存在但 JSON 格式错误
- **THEN** 输出 warning 日志，回退到内置语言专属规则表（若匹配）或内置通用规则，`used_default=true`

### Requirement: `reflect_comment` 确定性验证评论

系统 SHALL 提供 `reflect_comment` 工具，对已定位的评论执行确定性检查并返回 `keep`/`drop` 二元 verdict。核心三项检查：`line_in_hunk`（`start_line`/`end_line` 是否在 diff hunk 改动行范围内）、`existing_code_found`（`existing_code` 是否真实存在于文件）、`existing_code_in_diff`（`existing_code` 是否至少一行落在改动行内）。系统 SHALL 额外接收可选输入字段 `evidence`（跨文件证据引用数组，每项含 `path`、可选 `start_line`/`end_line`、必填 `snippet`），并执行第四项检查 `evidence_valid`：`evidence` 未提供或为空数组时该检查恒为 `passed=true`（not applicable）；提供时，每条 `evidence` 的 `snippet` MUST 在对应 `path` 的文件内容中找到匹配（复用与 `existing_code_found` 相同的规范化连续行匹配逻辑），任一条不匹配或字段缺失（缺 `path` 或 `snippet`）SHALL 使该检查 `passed=false`。任一检查失败 SHALL 返回 `drop`；全部通过 SHALL 返回 `keep`。系统 MUST NOT 调用 LLM 做语义反思，包括不校验 `evidence` 与评论内容的语义相关性。

#### Scenario: 全部检查通过（无 evidence）
- **WHEN** `start_line`/`end_line` 在 hunk 改动行内，`existing_code` 存在于文件且至少一行在改动行内，且未提供 `evidence`
- **THEN** `verdict="keep"`，`reason="passed all checks"`，`evidence_valid.passed=true`（not applicable）

#### Scenario: 行号不在 hunk 内
- **WHEN** `start_line`/`end_line` 不在 diff hunk 改动行范围内
- **THEN** `verdict="drop"`，`line_in_hunk.passed=false`

#### Scenario: 引用代码不存在
- **WHEN** `existing_code` 提供但在文件中找不到
- **THEN** `verdict="drop"`，`existing_code_found.passed=false`

#### Scenario: 引用代码不在改动行
- **WHEN** `existing_code` 存在于文件但无任何一行落在 diff 改动行内
- **THEN** `verdict="drop"`，`existing_code_in_diff.passed=false`

#### Scenario: 无 existing_code 时仅看 line_in_hunk 和 evidence
- **WHEN** `existing_code` 为空或未提供，且未提供 `evidence`
- **THEN** `existing_code_found`、`existing_code_in_diff`、`evidence_valid` 均标记为 not applicable 并默认通过，verdict 仅由 `line_in_hunk` 决定

#### Scenario: 定位失败的评论
- **WHEN** `start_line=0`/`end_line=0`（定位失败）
- **THEN** `line_in_hunk.passed=false`，`verdict="drop"`

#### Scenario: 文件不存在
- **WHEN** `path` 指向的文件不存在
- **THEN** 所有检查 `passed=false`，`verdict="drop"`，`reason="file not found"`

#### Scenario: evidence 全部真实存在
- **WHEN** `evidence` 提供且每条的 `snippet` 都能在对应 `path` 的文件内容中找到连续匹配
- **THEN** `evidence_valid.passed=true`；若其他检查也通过，`verdict="keep"`

#### Scenario: evidence 引用的 snippet 不存在
- **WHEN** `evidence` 中至少一条的 `snippet` 在其 `path` 的文件内容中找不到匹配
- **THEN** `evidence_valid.passed=false`，`verdict="drop"`

#### Scenario: evidence 条目格式错误
- **WHEN** `evidence` 中至少一条缺失 `path` 或 `snippet` 字段
- **THEN** 该条视为校验失败，`evidence_valid.passed=false`，`verdict="drop"`

## ADDED Requirements

### Requirement: `search_code` 提供跨文件文本级检索

系统 SHALL 提供 `search_code` 工具，接收 `query`、可选 `path_glob`、可选 `max_results`（默认 50）、`diff_ref`、可选 `repo`，基于 `git grep` 在与 `diff_ref` 对应的版本中检索匹配行。`diff_ref` 表示 workspace 模式（如 `"HEAD"`）时 SHALL 搜索工作区（包含未跟踪文件）；表示 range/commit 模式时 SHALL 搜索该 revision 对应的已提交内容。返回结果 SHALL 遵循 `.code-review/rules.json` 的 `filters.exclude` 排除规则，并在匹配数超过 `max_results` 时截断且标记 `truncated=true`。

#### Scenario: workspace 模式检索包含未跟踪文件
- **WHEN** `diff_ref="HEAD"` 且工作区存在匹配 `query` 的未跟踪文件
- **THEN** 该未跟踪文件的匹配行出现在 `matches[]` 中

#### Scenario: range 模式检索对应 revision
- **WHEN** `diff_ref="main..feature"`
- **THEN** 检索基于 `feature` revision 的已提交内容，不包含工作区未提交的改动

#### Scenario: 排除规则生效
- **WHEN** `.code-review/rules.json` 的 `filters.exclude` 包含 `**/*.lock`
- **THEN** `matches[]` 不包含 `.lock` 文件中的匹配

#### Scenario: 结果截断
- **WHEN** 匹配数超过 `max_results`
- **THEN** `matches[]` 长度等于 `max_results`，`truncated=true`，`total_matches` 反映实际匹配总数

#### Scenario: 无匹配
- **WHEN** `query` 在检索范围内无任何匹配
- **THEN** 返回 `matches=[]`，`truncated=false`，不报错

#### Scenario: 非 git 仓库或无效 query
- **WHEN** `repo` 不是有效 git 仓库，或 `query` 是非法的 grep 模式
- **THEN** 返回 `matches=[]` 及说明性 `reason` 字段，不抛出异常、不返回 MCP error response

### Requirement: `read_file_context` 提供有限范围文件上下文读取

系统 SHALL 提供 `read_file_context` 工具，接收 `path`、`diff_ref`、可选 `repo`，以及二选一的范围指定方式：（`anchor_line` + 可选 `before`/`after`）或（`start_line` + `end_line`）。系统 SHALL 按与 `position_comment`/`reflect_comment` 相同的 ref-then-worktree 回退逻辑读取文件内容，返回指定行区间的内容，超过 `max_lines`（默认 200）时截断并标记 `truncated=true`。

#### Scenario: 锚点方式读取
- **WHEN** 提供 `anchor_line=50`、`before=10`、`after=10`
- **THEN** 返回第 40-60 行的内容，`start_line=40`、`end_line=60`

#### Scenario: 显式区间方式读取
- **WHEN** 提供 `start_line=100`、`end_line=150`
- **THEN** 返回第 100-150 行的内容

#### Scenario: 超过行数上限截断
- **WHEN** 指定区间超过 `max_lines`（默认 200）
- **THEN** 返回内容截断至 `max_lines`，`truncated=true`

#### Scenario: ref 中不存在回退 worktree
- **WHEN** `path` 在 `diff_ref` 指定的 revision 中不存在，但存在于工作区
- **THEN** 回退读取工作区内容并返回

#### Scenario: 文件完全不存在
- **WHEN** `path` 在 `diff_ref` 和工作区中都不存在
- **THEN** 返回 `content=null` 及错误说明，不抛出异常

#### Scenario: 未提供有效范围指定方式
- **WHEN** 既未提供 `anchor_line` 也未提供完整的 `start_line`/`end_line` 组合
- **THEN** 返回 MCP error response，提示需要提供其中一种范围指定方式
