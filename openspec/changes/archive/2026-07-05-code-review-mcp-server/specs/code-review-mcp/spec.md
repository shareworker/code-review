## ADDED Requirements

### Requirement: MCP server 暴露 5 个确定性工具

系统 SHALL 作为 stdio 传输的 MCP server 运行，注册并处理 5 个工具：`get_review_targets`、`get_file_bundle`、`match_rules`、`position_comment`、`reflect_comment`。系统 MUST NOT 调用任何 LLM；所有 LLM 推理由 host agent 完成。

#### Scenario: 零配置启动
- **WHEN** host 通过 `npx -y @shareworker/code-review-mcp` 启动 server
- **THEN** server 通过 stdio 建立 MCP 连接，无需任何预安装或配置文件即可响应工具调用

#### Scenario: server 进程不崩溃
- **WHEN** 任一工具处理过程中抛出异常
- **THEN** 该工具返回 MCP error response，server 进程保持存活并继续响应后续工具调用

#### Scenario: server 无状态
- **WHEN** 同一工具被连续调用多次
- **THEN** 每次调用独立处理，不依赖前序调用的内存状态；`position_comment` 和 `reflect_comment` 每次重新解析 diff

### Requirement: `get_review_targets` 算出待 review 文件并产出 diff_ref

系统 SHALL 提供 `get_review_targets` 工具，接收 `mode`（`workspace`/`range`/`commit`）及对应参数，从 git diff 算出待 review 文件列表，应用文件过滤规则，返回规范 `diff_ref` 和文件数组。`diff_ref` MUST 按 mode 产出：workspace→`"HEAD"`、range→`"<from>..<to>"`、commit→`"<commit>^..<commit>"`。

#### Scenario: workspace 模式
- **WHEN** 调用 `get_review_targets(mode="workspace")`
- **THEN** 返回 `diff_ref="HEAD"`，`files[]` 包含 staged + unstaged + untracked 文件的 diff；untracked 文件合成为 full-file-add diff

#### Scenario: range 模式
- **WHEN** 调用 `get_review_targets(mode="range", from="main", to="feature")`
- **THEN** 返回 `diff_ref="main..feature"`，`files[]` 为 `git diff main feature` 的结果

#### Scenario: commit 模式
- **WHEN** 调用 `get_review_targets(mode="commit", commit="abc123")`
- **THEN** 返回 `diff_ref="abc123^..abc123"`，`files[]` 为 `git diff abc123^ abc123` 的结果

#### Scenario: 文件过滤
- **WHEN** diff 中包含 `*.lock`、`package-lock.json`、`*.min.js`、`*.map`、二进制文件（由 `diffSummary` 检测）
- **THEN** 这些文件不进入 `files[]`，`filtered_out` 计数增加

#### Scenario: 用户自定义过滤
- **WHEN** `<repo>/.code-review/rules.json` 的 `filters.include`/`filters.exclude` 存在
- **THEN** 用户规则与内置默认黑名单合并应用，优先级：`--rule` flag > repo > home > 内置默认

#### Scenario: 无变更
- **WHEN** git diff 为空（无任何变更）
- **THEN** 返回 `files=[]`、`total_files=0`，不报错

#### Scenario: 无效 ref
- **WHEN** `mode="range"` 且 `from`/`to` 不是有效 git ref
- **THEN** 返回 MCP error response，提示检查 repo 路径和 ref

### Requirement: `get_file_bundle` 按相关性打包文件

系统 SHALL 提供 `get_file_bundle` 工具，接收 `files`、`diff_ref`、`repo`，按 test/source 配对和 i18n 变体规则把文件打包成 review 单元，受 20000 字符上限约束。系统 MUST 通过 `simple-git` 用 `diff_ref` 自己重读 diff，不接收 host 传来的 diff 文本。

#### Scenario: test/source 配对
- **WHEN** `files` 包含 `foo.test.ts` 和 `foo.ts`
- **THEN** 两者打包进同一 bundle，`bundle_reason="test_source_pair"`

#### Scenario: i18n 变体配对
- **WHEN** `files` 包含 `messages_en.ts` 和 `messages_zh.ts`（同 base 名不同 locale 后缀）
- **THEN** 两者打包进同一 bundle，`bundle_reason="i18n_variants"`

#### Scenario: 字符上限切分
- **WHEN** 加入下一个文件会使 bundle 的 `total_chars`（各文件 diff 文本之和）超过 20000
- **THEN** 关闭当前 bundle，开新 bundle；文件 MUST NOT 在中间被切分

#### Scenario: 单文件超限
- **WHEN** 单个文件的 diff 文本独自超过 20000 字符
- **THEN** 该文件独占一个 over-cap bundle，MUST NOT 被丢弃

#### Scenario: 无配对的独立文件
- **WHEN** 文件不匹配 test/source 或 i18n 规则
- **THEN** 该文件成为独立 bundle，`bundle_reason="single_file"`

#### Scenario: 空文件列表
- **WHEN** `files=[]`
- **THEN** 返回 `bundles=[]`、`total_bundles=0`，不报错

#### Scenario: 无效 diff_ref
- **WHEN** `diff_ref` 不是有效 git ref
- **THEN** 返回 MCP error response，提示检查 ref

#### Scenario: 单文件 diff 读取失败
- **WHEN** bundle 过程中某个文件的 diff 读取失败
- **THEN** 跳过该文件，其他文件正常打包

### Requirement: `match_rules` 返回规则 prompt_section

系统 SHALL 提供 `match_rules` 工具，接收 `path`、`repo`，按 glob 模式匹配 `.code-review/rules.json` 的 `rules` 数组（first match wins），合并为 `prompt_section` 纯文本供 host 注入 review prompt。无规则匹配时 SHALL 返回内置通用规则（覆盖 correctness/security/performance/maintainability/test-coverage），`used_default=true`。

#### Scenario: 匹配到用户规则
- **WHEN** `path="src/foo.ts"` 且 rules.json 有 `{"path":"**/*.ts","rule":"Check for any types"}`
- **THEN** 返回 `matched_rules=[{pattern:"**/*.ts",rule:"Check for any types"}]`，`prompt_section` 包含该规则文本，`used_default=false`

#### Scenario: 无匹配用内置默认
- **WHEN** `path` 不匹配 rules.json 中任何规则
- **THEN** 返回内置通用规则，`used_default=true`，`prompt_section` 覆盖 correctness/security/performance/maintainability/test-coverage

#### Scenario: rules.json 缺失
- **WHEN** `<repo>/.code-review/rules.json` 不存在
- **THEN** 静默回退到内置通用规则，`used_default=true`

#### Scenario: rules.json 解析失败
- **WHEN** rules.json 存在但 JSON 格式错误
- **THEN** 输出 warning 日志，回退到内置通用规则，`used_default=true`

### Requirement: `position_comment` 精确定位评论行号

系统 SHALL 提供 `position_comment` 工具，按三级策略把评论定位到文件行号：文本匹配优先（从 `existing_code`/`suggestion_code` 提取代码行，normalize 后在 hunk new-side → old-side → 全文件依次搜索连续匹配）→ hunk 对齐（无代码片段但有 `hint_line` 时用 hunk 行号映射）→ 兜底 `0,0,"failed"`。行 normalize SHALL 执行 `trimSpace` + 去除前导 `+`/`-` diff 标记。

#### Scenario: 文本匹配命中 hunk new-side
- **WHEN** `existing_code` 提供的代码片段在 diff hunk 的 new-side（context + added 行）中连续匹配
- **THEN** 返回 `start_line`/`end_line` 为 new-file 行号，`located_by="text_match"`

#### Scenario: 文本匹配命中 hunk old-side
- **WHEN** 代码片段在 new-side 未命中但在 old-side（context + deleted 行）命中
- **THEN** 返回 old-file 行号，`located_by="text_match"`

#### Scenario: 文本匹配命中全文件
- **WHEN** 代码片段在 hunk 两侧都未命中但在全文件内容中命中
- **THEN** 返回文件行号，`located_by="text_match"`

#### Scenario: hunk 对齐兜底
- **WHEN** 无 `existing_code`/`suggestion_code` 但提供 `hint_line`
- **THEN** 用 hunk 行号映射对齐 `hint_line`，返回对齐后的行号，`located_by="hunk_align"`

#### Scenario: 定位失败
- **WHEN** 无 `existing_code`、无 `suggestion_code`、无 `hint_line`，或所有策略都未命中
- **THEN** 返回 `start_line=0`、`end_line=0`、`located_by="failed"`

#### Scenario: 文件不可读
- **WHEN** `path` 指向的文件不存在或不可读
- **THEN** 返回 `start_line=0`、`end_line=0`、`located_by="failed"`

### Requirement: `reflect_comment` 确定性验证评论

系统 SHALL 提供 `reflect_comment` 工具，对已定位的评论执行三项确定性检查并返回 `keep`/`drop` 二元 verdict。三项检查：`line_in_hunk`（`start_line`/`end_line` 是否在 diff hunk 改动行范围内）、`existing_code_found`（`existing_code` 是否真实存在于文件）、`existing_code_in_diff`（`existing_code` 是否至少一行落在改动行内）。任一检查失败 SHALL 返回 `drop`；全部通过 SHALL 返回 `keep`。系统 MUST NOT 调用 LLM 做语义反思。

#### Scenario: 全部检查通过
- **WHEN** `start_line`/`end_line` 在 hunk 改动行内，且 `existing_code` 存在于文件且至少一行在改动行内
- **THEN** `verdict="keep"`，`reason="passed all checks"`，三项检查均 `passed=true`

#### Scenario: 行号不在 hunk 内
- **WHEN** `start_line`/`end_line` 不在 diff hunk 改动行范围内
- **THEN** `verdict="drop"`，`line_in_hunk.passed=false`

#### Scenario: 引用代码不存在
- **WHEN** `existing_code` 提供但在文件中找不到
- **THEN** `verdict="drop"`，`existing_code_found.passed=false`

#### Scenario: 引用代码不在改动行
- **WHEN** `existing_code` 存在于文件但无任何一行落在 diff 改动行内
- **THEN** `verdict="drop"`，`existing_code_in_diff.passed=false`

#### Scenario: 无 existing_code 时仅看 line_in_hunk
- **WHEN** `existing_code` 为空或未提供
- **THEN** `existing_code_found` 和 `existing_code_in_diff` 标记为 not applicable 并默认通过，verdict 仅由 `line_in_hunk` 决定

#### Scenario: 定位失败的评论
- **WHEN** `start_line=0`/`end_line=0`（定位失败）
- **THEN** `line_in_hunk.passed=false`，`verdict="drop"`

#### Scenario: 文件不存在
- **WHEN** `path` 指向的文件不存在
- **THEN** 所有检查 `passed=false`，`verdict="drop"`，`reason="file not found"`

### Requirement: `diff_ref` 在管线中显式流转

`get_review_targets` SHALL 在输出中返回规范 `diff_ref`。host MUST 把该 `diff_ref` 传给 `get_file_bundle`、`position_comment`、`reflect_comment`，保证整条管线读同一个 diff。工具默认 `diff_ref="HEAD"` 仅为 workspace 模式的便利默认值；range/commit 模式下依赖默认值会产生错误结果。

#### Scenario: workspace 模式默认值安全
- **WHEN** host 在 workspace 模式下不传 `diff_ref` 给下游工具
- **THEN** 下游工具用默认 `"HEAD"`，与 `get_review_targets` 产出的 `diff_ref` 一致，结果正确

#### Scenario: range 模式必须显式传
- **WHEN** host 在 range 模式下不传 `diff_ref` 给 `position_comment`
- **THEN** `position_comment` 用默认 `"HEAD"` 解析 hunk，与实际 review 的 diff 不一致，定位结果错误

### Requirement: 跨平台行为一致

系统 SHALL 在 Windows、macOS、Linux 上行为一致。内部路径统一用正斜杠；diff 解析统一 trim `\r`；非 ASCII 文件名由 `simple-git` 处理 `core.quotepath` 转义。

#### Scenario: Windows 路径
- **WHEN** repo 位于 Windows 系统且文件路径含反斜杠
- **THEN** 工具内部统一用正斜杠，输出路径为正斜杠格式

#### Scenario: 非 ASCII 文件名
- **WHEN** diff 中包含非 ASCII 文件名（如中文）
- **THEN** `simple-git` 处理 `core.quotepath` 转义，文件名正确解析

#### Scenario: CRLF/LF 混合
- **WHEN** 文件或 diff 中混合 CRLF 和 LF 行尾
- **THEN** diff 解析统一 trim `\r`，行匹配不受行尾差异影响
