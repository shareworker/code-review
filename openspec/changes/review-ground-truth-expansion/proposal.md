## Why

`code-review-mcp` 的确定性层目前只覆盖"文件选择、打包、规则匹配、定位、反思"，尚未利用**项目自身工具链能跑出的地面真值**（lint/typecheck 输出、真实测试执行结果、secret 正则命中、依赖元数据、git 历史统计）。这类信号比宿主 LLM 的语义猜测更可靠——它们是事实而非推断，且是 alibaba/open-code-review 的 agent loop 也没有利用的信号源（OCR 的 agent loop 只反复调用 `code_search`/`file_read`，不会跑项目自己的 lint/测试）。补齐这一层可以在不引入 agent loop、不违反"server 不调 LLM"约束的前提下，系统性降低误报率、提升召回率，形成相对 OCR 的差异化质量优势。同时补齐与 OCR 确定性层的既有差距（语言规则覆盖度、跨文件依赖检索、评论去重、定位鲁棒性、大 diff 的 token 预算）。

## What Changes

**地面真值信号工具（新增）：**
- 新增 `get_lint_findings` 工具：检测并运行项目已配置的 lint/typecheck 工具（eslint/tsc/ruff/golint/clippy），解析其原生输出为结构化诊断。
- 新增 `scan_secrets` 工具：基于已知密钥模式（AWS/GCP/私钥头/JWT/常见 token 格式）+ 简单熵值检测，扫描 diff 新增行。
- 新增 `check_dependency_diff` 工具：解析 `package.json`/`requirements.txt`/`go.mod` 的新增依赖，标记未锁定版本（`*`/`latest`/无版本约束），列出新增/移除的依赖名。不做网络请求（不查注册表新鲜度），保持零运行时依赖。
- 新增 `get_file_history_stats` 工具：基于 `git log` 统计文件的历史修改频率和"修复类" commit 占比（消息含 fix/bug 等关键词的启发式匹配），提示 review 重点。
- 新增 `run_affected_tests` 工具：只读取并执行 `package.json` 声明的 `test` script（不接受宿主传入的任意命令字符串或文件过滤），带超时（默认 60s），返回退出码、stdout/stderr、是否超时。不重试、不吞异常。

**确定性层差距补齐：**
- 新增 `get_importers` 工具：正则解析 `import`/`require`/`from` 语句，构建模块级"谁引用了这个文件"的反向依赖检索，覆盖"符号检索"里最高频的"谁调用了 X"场景，不引入 AST/tree-sitter。
- 新增 `dedupe_comments` 工具：基于规范化文本相似度对多条评论去重，把 SKILL.md 里"建议宿主去重"的软约束变成 server 侧确定性保证。
- 扩展 `position_comment`：文本匹配、hunk 对齐都失败后新增模糊匹配兜底层（基于 Levenshtein 距离容忍小改动），仍为确定性逻辑，不引入 LLM 重定位。
- 扩展 `get_file_bundle`：把现有 20000 字符硬截断改为按改动密度（每文件的新增+删除行数 / 字符数）排序后再截断，优先保留改动密集的文件；`i18n_variants` 类型的 bundle 额外返回各文件间的 key 一致性 diff（`missing_keys`/`extra_keys`）。
- 扩展 `match_rules` 的内置语言规则表：新增第二批 Python/Go/Java/SQL mapper(.xml)/Dockerfile 规则。

**编排协议更新：**
- 更新 `skills/code-review/SKILL.md`：在正确的 pipeline 阶段插入新工具调用时机（lint/secret 扫描在 bundle 生成后、生成评论前跑；`run_affected_tests`/`get_importers`/`get_file_history_stats` 按需在生成评论阶段调用；`dedupe_comments` 在 Step 4 输出前调用）；引入"置信度"输出维度：由确定性地面真值工具（`get_lint_findings`/`scan_secrets`/`run_affected_tests`/`evidence_valid`）支撑的评论标记为高置信度。

## Capabilities

### New Capabilities

<!-- 本次不引入新 capability 分类；所有新工具都归入现有 code-review-mcp capability 的需求扩展，与上一轮 review-quality-evidence-baseline 保持一致的组织方式。 -->

### Modified Capabilities

- `code-review-mcp`: 新增 7 个确定性工具（`get_lint_findings`、`scan_secrets`、`check_dependency_diff`、`get_file_history_stats`、`run_affected_tests`、`get_importers`、`dedupe_comments`）；`position_comment` 新增模糊匹配兜底层；`get_file_bundle` 改为按改动密度排序截断，`i18n_variants` bundle 新增 key 一致性 diff；`match_rules` 内置语言规则表新增第二批语言。

## Impact

- **受影响代码**：新增 `src/lint.ts`、`src/secrets.ts`、`src/dependency-diff.ts`、`src/file-history.ts`、`src/run-tests.ts`、`src/importers.ts`、`src/dedupe.ts`；修改 `src/position.ts`（模糊匹配层）、`src/bundler.ts`（密度排序 + i18n key diff）、`src/rules.ts`（第二批语言规则）、`src/types.ts`（新类型）、`src/index.ts`（注册 7 个新工具 + 更新 `get_file_bundle`/`position_comment` 输出）。
- **受影响测试**：为每个新模块新增测试文件；扩展 `bundler.test.ts`、`position.test.ts`、`rules.test.ts`、`e2e.test.ts`。
- **受影响文档**：`skills/code-review/SKILL.md` 编排协议重写；`README.md` 工具列表从 7 个更新为 14 个。
- **不受影响**：`get_review_targets`、`match_rules` 的用户规则优先级、`search_code`、`read_file_context`、`reflect_comment` 的既有检查项、server 无状态特性、server 不调 LLM 的边界。
- **新增运行时行为（需在文档中明确披露）**：`get_lint_findings` 和 `run_affected_tests` 会 spawn 子进程执行仓库内已配置的命令（lint 工具 / `npm test` 等 package.json script）。这是本项目历史上首次执行仓库内命令而非仅读取 git 数据，需要在 README 和 SKILL.md 中明确说明此行为及其信任边界（等同于运行 `npm install && npm test` 的信任级别）。
- **不做（明确排除）**：AST/符号解析、依赖新鲜度的网络查询（registry lookup）、`run_affected_tests` 接受宿主自定义命令或测试文件过滤参数、agent loop、server 调用 LLM 做语义反思或重定位。
