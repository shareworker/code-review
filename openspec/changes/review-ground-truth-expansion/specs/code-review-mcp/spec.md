## MODIFIED Requirements

### Requirement: MCP server 暴露确定性工具集

系统 SHALL 作为 stdio 传输的 MCP server 运行，注册并处理 14 个工具：`get_review_targets`、`get_file_bundle`、`match_rules`、`search_code`、`read_file_context`、`position_comment`、`reflect_comment`、`get_lint_findings`、`scan_secrets`、`check_dependency_diff`、`get_file_history_stats`、`run_affected_tests`、`get_importers`、`dedupe_comments`。系统 MUST NOT 调用任何 LLM；所有 LLM 推理由 host agent 完成。

#### Scenario: 零配置启动
- **WHEN** host 通过 `npx -y @shareworker/code-review-mcp` 启动 server
- **THEN** server 通过 stdio 建立 MCP 连接，无需任何预安装或配置文件即可响应工具调用

#### Scenario: server 进程不崩溃
- **WHEN** 任一工具处理过程中抛出异常
- **THEN** 该工具返回 MCP error response，server 进程保持存活并继续响应后续工具调用

#### Scenario: server 无状态
- **WHEN** 同一工具被连续调用多次
- **THEN** 每次调用独立处理，不依赖前序调用的内存状态；`search_code`、`read_file_context`、`position_comment`、`reflect_comment`、`get_lint_findings`、`scan_secrets`、`check_dependency_diff`、`get_file_history_stats`、`run_affected_tests`、`get_importers`、`dedupe_comments` 每次重新读取 git 状态、重新执行命令或重新解析 diff，不缓存跨调用结果

#### Scenario: 首次执行仓库命令需在文档中披露
- **WHEN** host 调用 `get_lint_findings` 或 `run_affected_tests`
- **THEN** server SHALL 只执行仓库内已声明的命令（检测到的 lint/typecheck 工具、`package.json` 的 `test` script），不接受 host 传入的任意命令字符串；此行为 MUST 在 README 中明确披露

### Requirement: `get_file_bundle` 按相关性打包文件

系统 SHALL 提供 `get_file_bundle` 工具，接收 `files`、`diff_ref`、`repo`，按 test/source 配对和 i18n 变体规则把文件打包成 review 单元，受 20000 字符上限约束。系统 MUST 通过 `simple-git` 用 `diff_ref` 自己重读 diff，不接收 host 传来的 diff 文本。当一个 bundle 内的文件因字符上限被截断顺序影响时，系统 SHALL 按每个文件的"改动密度"（`insertions + deletions` 除以该文件 diff 文本字符数）降序排列后再应用上限，优先完整保留改动密度高的文件。当 `bundle_reason="i18n_variants"` 时，系统 SHALL 额外解析各文件的顶层 JSON key 集合，返回两两之间的 `key_diff`（`missing_keys`/`extra_keys`）。

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

#### Scenario: 按改动密度排序影响截断优先级
- **WHEN** 一个 bundle 内有多个候选文件且总字符数超过 20000
- **THEN** 改动密度（insertions+deletions / diff 字符数）更高的文件优先完整保留在当前 bundle 内，密度较低的文件优先被移到后续 bundle

#### Scenario: i18n bundle 返回 key 一致性 diff
- **WHEN** bundle 的 `bundle_reason="i18n_variants"` 且各文件是合法 JSON，其中一个文件缺少另一个文件存在的顶层 key
- **THEN** bundle 结果包含 `key_diff`，标注每个文件相对其他文件缺失（`missing_keys`）或多出（`extra_keys`）的 key

#### Scenario: i18n bundle 文件非 JSON 或解析失败时跳过 key 一致性检查
- **WHEN** i18n bundle 中的文件内容不是合法 JSON
- **THEN** 该 bundle 的 `key_diff` 为空或标注 `reason`，不抛出异常

### Requirement: `position_comment` 精确定位评论行号

系统 SHALL 提供 `position_comment` 工具，按四级策略把评论定位到文件行号：文本匹配优先（从 `existing_code`/`suggestion_code` 提取代码行，normalize 后在 hunk new-side → old-side → 全文件依次搜索连续匹配）→ hunk 对齐（无代码片段但有 `hint_line` 时用 hunk 行号映射）→ 模糊匹配兜底（对文件内容做等长滑动窗口，计算与 `existing_code` 规范化后的 Levenshtein 距离，距离与长度比低于阈值——默认 0.15——时接受为匹配）→ 兜底 `0,0,"failed"`。行 normalize SHALL 执行 `trimSpace` + 去除前导 `+`/`-` diff 标记。

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

#### Scenario: 模糊匹配命中
- **WHEN** `existing_code` 提供，精确文本匹配和 hunk 对齐都未命中，但文件中存在一个等长窗口与 `existing_code` 规范化后的 Levenshtein 距离/长度比低于阈值
- **THEN** 返回该窗口对应的行号，`located_by="fuzzy_match"`

#### Scenario: 模糊匹配也未命中
- **WHEN** 所有窗口的 Levenshtein 距离/长度比都不低于阈值
- **THEN** 返回 `start_line=0`、`end_line=0`、`located_by="failed"`

#### Scenario: 定位失败
- **WHEN** 无 `existing_code`、无 `suggestion_code`、无 `hint_line`，或所有策略都未命中
- **THEN** 返回 `start_line=0`、`end_line=0`、`located_by="failed"`

#### Scenario: 文件不可读
- **WHEN** `path` 指向的文件不存在或不可读
- **THEN** 返回 `start_line=0`、`end_line=0`、`located_by="failed"`

## ADDED Requirements

### Requirement: `get_lint_findings` 执行已配置的 lint/typecheck 工具

系统 SHALL 提供 `get_lint_findings` 工具，接收 `files`、可选 `repo`，检测仓库已配置的 lint/typecheck 工具（`.eslintrc*`/`eslint.config.*` → eslint；`tsconfig.json` → `tsc --noEmit`；`pyproject.toml`/`ruff.toml` → ruff；`.golangci.yml` 或 `go.mod` → `go vet`；`Cargo.toml` → `cargo clippy`），通过项目本地 `node_modules/.bin/`（Node 生态）或系统 PATH（其他生态）调用检测到的工具，解析其输出为统一的 `LintFinding[]`（含 `path`、`line`、`severity`、`message`、`tool` 字段）。系统 MUST NOT 自行安装或捆绑任何 lint/typecheck 工具；检测不到任何已知配置时返回空结果 + `reason`，不报错。

#### Scenario: 检测到 ESLint 配置并运行
- **WHEN** 仓库存在 `.eslintrc.json` 且 `node_modules/.bin/eslint` 存在
- **THEN** 对 `files` 中匹配的文件运行 eslint，解析其 JSON 输出为 `findings[]`，每条含 `tool="eslint"`

#### Scenario: 检测到 tsconfig.json 并运行 tsc
- **WHEN** 仓库根目录存在 `tsconfig.json`
- **THEN** 运行 `tsc --noEmit`，解析编译器诊断输出为 `findings[]`，每条含 `tool="tsc"`

#### Scenario: 未检测到任何已知配置
- **WHEN** 仓库不存在任何已知 lint/typecheck 配置文件
- **THEN** 返回 `findings=[]`，`reason="no known lint/typecheck configuration detected"`，不报错

#### Scenario: 工具二进制不存在
- **WHEN** 检测到配置文件（如 `.eslintrc.json`）但对应二进制未安装（`node_modules/.bin/eslint` 不存在）
- **THEN** 跳过该工具，返回其他已检测到工具的结果；若无任何工具可执行，返回 `findings=[]` 及 `reason`

#### Scenario: 工具执行超时
- **WHEN** lint/typecheck 工具执行超过默认超时（60 秒）
- **THEN** 终止该工具的子进程，标记该工具的结果为 `timed_out=true`，不影响其他工具的结果

### Requirement: `scan_secrets` 检测 diff 中意外提交的密钥

系统 SHALL 提供 `scan_secrets` 工具，接收 `diff_ref`、可选 `repo`，只扫描 diff 中新增的行（不扫描未改动的历史内容），基于内置密钥模式（AWS Access Key、私钥 PEM 头、JWT 三段式、常见 `api_key=`/`token=`/`password=` 赋值模式）和轻量熵值检测（对疑似字符串字面量计算 Shannon 熵，超过阈值且长度超过最小字符数才报告）识别可能的密钥泄露，返回 `finding[]`（含 `path`、`line`、`pattern_name`、`matched_text` 的部分掩码）。

#### Scenario: 命中已知密钥模式
- **WHEN** diff 新增行包含形如 `AKIA[0-9A-Z]{16}` 的字符串
- **THEN** 返回一条 `finding`，`pattern_name="aws_access_key"`，`matched_text` 中间部分被掩码（如 `AKIA****************`）

#### Scenario: 高熵字符串触发熵值检测
- **WHEN** diff 新增行包含一个长度超过最小阈值、Shannon 熵超过阈值的字符串字面量，且不匹配任何已知模式
- **THEN** 返回一条 `finding`，`pattern_name="high_entropy_string"`

#### Scenario: 未改动的历史密钥不报告
- **WHEN** 文件中存在一个密钥模式字符串，但该行不在 diff 的新增行范围内
- **THEN** 该密钥不出现在 `finding[]` 中

#### Scenario: 无匹配
- **WHEN** diff 新增行中不包含任何已知密钥模式或高熵字符串
- **THEN** 返回 `findings=[]`，不报错

### Requirement: `check_dependency_diff` 检查依赖清单变更

系统 SHALL 提供 `check_dependency_diff` 工具，接收 `path`（依赖清单文件路径，如 `package.json`/`requirements.txt`/`go.mod`）、`diff_ref`、可选 `repo`，对比 `diff_ref` 前后该文件解析出的依赖列表，返回 `added[]`（新增依赖名+版本约束）、`removed[]`（移除依赖名）、`unpinned[]`（`added` 中版本约束为 `*`、`latest`、空或无上界范围的依赖名）。系统 MUST NOT 发起任何网络请求查询依赖的发布时间或 registry 元数据。

#### Scenario: 检测到新增未锁定版本的依赖
- **WHEN** `package.json` 新增一条 `"some-pkg": "*"` 或 `"some-pkg": "latest"`
- **THEN** `added` 包含该依赖，`unpinned` 也包含该依赖名

#### Scenario: 检测到新增已锁定版本的依赖
- **WHEN** `package.json` 新增一条 `"some-pkg": "1.2.3"`
- **THEN** `added` 包含该依赖，`unpinned` 不包含该依赖名

#### Scenario: 检测到移除的依赖
- **WHEN** 依赖清单在 `diff_ref` 前后对比，某依赖从存在变为不存在
- **THEN** `removed` 包含该依赖名

#### Scenario: 依赖清单在指定 ref 不存在或解析失败
- **WHEN** `path` 在 `diff_ref` 对应版本不存在，或文件内容不是合法的 `package.json`/`requirements.txt`/`go.mod` 格式
- **THEN** 返回空结果 + `reason`，不抛出异常

### Requirement: `get_file_history_stats` 提供文件历史修改统计

系统 SHALL 提供 `get_file_history_stats` 工具，接收 `path`、可选 `repo`，基于 `git log --follow` 统计该文件的历史 commit 总数、最近修改时间，以及消息中包含 fix/bug/hotfix 等关键词（大小写不敏感）的"修复类" commit 占比。

#### Scenario: 返回历史统计
- **WHEN** 文件在 git 历史中有多次 commit，其中部分 commit 消息包含 "fix"
- **THEN** 返回 `total_commits`、`last_modified`（ISO 时间字符串）、`fix_commit_ratio`（0-1 之间的比例）

#### Scenario: 文件是新文件（无历史）
- **WHEN** 文件是本次 diff 新增的、git 历史中没有该文件的记录
- **THEN** 返回 `total_commits=0`，`fix_commit_ratio=0`，不报错

#### Scenario: 路径在 git 历史中不存在
- **WHEN** `path` 从未在该仓库的 git 历史中出现过
- **THEN** 返回 `total_commits=0` 及 `reason`

### Requirement: `run_affected_tests` 执行项目声明的测试脚本

系统 SHALL 提供 `run_affected_tests` 工具，接收可选 `repo`、可选 `timeout_ms`（默认 60000），读取仓库 `package.json` 的 `scripts.test` 字段，用不经过 shell 的子进程方式（等价于 `npm run test`）执行，返回 `exit_code`、`stdout`、`stderr`、`timed_out`。系统 MUST NOT 接受 host 传入的任意命令字符串或测试文件路径过滤参数；只执行 `package.json` 中已声明的 `test` script 本身。超时或非零退出码 SHALL 原样返回，系统 MUST NOT 重试或吞掉失败信息。

#### Scenario: 测试全部通过
- **WHEN** `package.json` 的 `scripts.test` 执行后退出码为 0
- **THEN** 返回 `exit_code=0`，`stdout`/`stderr` 包含测试运行器的原始输出，`timed_out=false`

#### Scenario: 测试失败
- **WHEN** 测试执行后退出码非 0
- **THEN** 原样返回该退出码和 `stdout`/`stderr`，不重试

#### Scenario: 执行超时
- **WHEN** 测试执行时间超过 `timeout_ms`
- **THEN** 终止子进程，返回 `timed_out=true`，`exit_code` 为终止时的状态

#### Scenario: package.json 不存在或无 test script
- **WHEN** 仓库根目录没有 `package.json`，或 `package.json` 没有 `scripts.test` 字段
- **THEN** 返回空结果 + `reason`，不报错、不执行任何命令

### Requirement: `get_importers` 提供模块级反向依赖检索

系统 SHALL 提供 `get_importers` 工具，接收 `path`、可选 `repo`、可选 `diff_ref`，对 `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` 文件，用正则解析仓库内所有文件的 `import ... from "..."`、`require("...")`、`export ... from "..."` 语句中的相对路径模块引用，解析为绝对路径后建立反向索引，返回引用了 `path` 的文件列表。系统 MUST NOT 解析动态 `import(variable)`、条件 `require`，或 tsconfig `paths` 路径别名映射（记录为已知局限）。

#### Scenario: 找到静态 import 的引用方
- **WHEN** `src/b.ts` 中有 `import { foo } from "./a"`，查询 `get_importers("src/a.ts")`
- **THEN** 返回的列表包含 `src/b.ts`

#### Scenario: 找到 require 的引用方
- **WHEN** `src/b.js` 中有 `const a = require("./a")`，查询 `get_importers("src/a.js")`
- **THEN** 返回的列表包含 `src/b.js`

#### Scenario: 无引用方
- **WHEN** 仓库中没有任何文件引用 `path`
- **THEN** 返回空列表，不报错

#### Scenario: 动态 import 不被识别（已知局限）
- **WHEN** 某文件仅通过 `import(someVariable)` 动态引用 `path`，路径不是字符串字面量
- **THEN** 该引用方 MUST NOT 出现在结果中，此为已知局限而非缺陷

### Requirement: `dedupe_comments` 对多条评论做确定性去重

系统 SHALL 提供 `dedupe_comments` 工具，接收 `comments[]`（每项含 `path`、`content`、可选 `existing_code`）和可选 `similarity_threshold`（默认 0.6），对每条评论的 `content` 规范化（小写、去标点、分词）后计算两两 Jaccard 相似度，相似度超过阈值且 `existing_code` 规范化后一致或高度重叠时判定为重复，保留 `path` 字母序最先的一条，返回 `kept[]` 和 `dropped[]`（含 `duplicate_of` 指向被保留的评论）。系统 MUST NOT 调用任何 LLM 或语义相似度模型判断重复。

#### Scenario: 识别高度相似的重复评论
- **WHEN** 两条评论的 `content` 经规范化后词汇高度重叠（相似度超过阈值），且 `existing_code` 一致
- **THEN** 其中一条进入 `dropped[]`，`duplicate_of` 指向 `kept[]` 中保留的那条

#### Scenario: 相似度不足阈值不判定为重复
- **WHEN** 两条评论的相似度低于 `similarity_threshold`
- **THEN** 两条都保留在 `kept[]` 中

#### Scenario: 空评论列表
- **WHEN** `comments=[]`
- **THEN** 返回 `kept=[]`、`dropped=[]`，不报错

#### Scenario: 阈值可配置
- **WHEN** host 传入自定义 `similarity_threshold`
- **THEN** 去重判定使用该阈值而非默认值 0.6
