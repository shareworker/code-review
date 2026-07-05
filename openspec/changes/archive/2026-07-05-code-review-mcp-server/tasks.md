## 1. 项目骨架

- [x] 1.1 初始化 `package.json`（name=`@shareworker/code-review-mcp`，type=module，bin 指向 dist/index.js，files=["dist"]）
- [x] 1.2 创建 `tsconfig.json`（target=ES2022，module=ESNext，moduleResolution=Bundler，strict=true，outDir=dist）
- [x] 1.3 安装运行时依赖：`@modelcontextprotocol/sdk`、`simple-git`、`diff`
- [x] 1.4 安装 dev 依赖：`typescript`、`@types/node`、测试框架（vitest）
- [x] 1.5 创建 `src/types.ts`：定义 `FileDiff`、`Hunk`、`HunkLine`、`FileBundle`、`PathRule`、`FilterConfig`、`PositionInput`、`PositionResult`、`ReflectInput`、`ReflectResult`、`ReviewTarget` 等共享类型

## 2. Git 操作层

- [x] 2.1 实现 `src/git.ts`：`getDiff(repo, ref)` 返回 unified diff 文本
- [x] 2.2 实现 `getDiffSummary(repo, ref)` 返回文件级元数据（rename/binary/mode/insertions/deletions）
- [x] 2.3 实现 `getFileContent(repo, ref, path)` 返回文件内容
- [x] 2.4 实现 `getStatus(repo)` 返回 porcelain 状态（用于 workspace 模式检测 untracked 文件）
- [x] 2.5 为 untracked 文件合成 full-file-add diff（等价 `git diff --no-index /dev/null <file>`）
- [x] 2.6 单元测试：mock simple-git，验证各函数输入输出和 ref 处理

## 3. Diff 解析层

- [x] 3.1 实现 `src/diff-parser.ts`：`parseFileDiffs(diffText)` 用 `diff` 库 `parsePatch` 解析为 `FileDiff[]`
- [x] 3.2 处理 git edge case：rename（old_path/new_path）、binary、mode change、new file、deleted file 标记
- [x] 3.3 实现 `parseHunks(fileDiffText)` 解析 `@@ -oldStart,oldCount +newStart,newCount @@` 头，分类 context/added/deleted 行
- [x] 3.4 实现 `normalizeLine(line)`：trimSpace + 去除前导 `+`/`-` diff 标记 + trim `\r`
- [x] 3.5 单元测试：用真实 git diff 样本（含 rename/binary/new file）验证解析正确性

## 4. 文件过滤

- [x] 4.1 实现 `src/filter.ts`：`loadFilterConfig(repo)` 加载 `.code-review/rules.json` 的 `filters` 字段，缺失则用空配置
- [x] 4.2 实现内置默认黑名单：`*.lock`、`package-lock.json`、`yarn.lock`、`*.min.js`、`*.map`、二进制扩展名（png/jpg/jpeg/gif/zip/tar/gz/pdf 等）
- [x] 4.3 实现 `filterFiles(files, config)`：合并 include/exclude（glob），优先级 repo > home > 内置默认；`diffSummary` 标记的 binary 文件跳过
- [x] 4.4 单元测试：验证默认黑名单、用户 include/exclude 覆盖、binary 跳过

## 5. 智能打包

- [x] 5.1 实现 `src/bundler.ts`：`bundleFiles(repo, files, diffRef)` 用 `getDiff` 重读每个文件 diff
- [x] 5.2 实现 test/source 配对识别：`foo.test.ts`↔`foo.ts`、`foo_spec.go`↔`foo.go`、`TestFoo.java`↔`Foo.java`
- [x] 5.3 实现 i18n 变体配对识别：同 base 名 + 不同 locale 后缀（`_en`/`_zh`/`_ja` 等）
- [x] 5.4 实现 20000 字符上限切分：加下一个文件会超限则关闭当前 bundle 开新 bundle；不在文件中间切；单文件独自超限独占 over-cap bundle 不丢弃
- [x] 5.5 单元测试：验证配对、切分、over-cap 单文件、无配对独立 bundle、空文件列表

## 6. 规则匹配

- [x] 6.1 实现 `src/rules.ts`：加载 `.code-review/rules.json` 的 `rules` 数组，glob 匹配（first match wins）
- [x] 6.2 实现内置通用默认规则（覆盖 correctness/security/performance/maintainability/test-coverage，对齐 open-code-review `default.md`）
- [x] 6.3 实现 `matchRules(repo, path)`：返回 `matched_rules`、`prompt_section`（纯文本合并）、`used_default`
- [x] 6.4 处理 rules.json 缺失（静默回退）和解析失败（warning 日志 + 回退）
- [x] 6.5 单元测试：验证匹配、first-match-wins、无匹配回退、解析失败回退、prompt_section 格式

## 7. 评论定位

- [x] 7.1 实现 `src/position.ts`：`positionComment(repo, input)` 接收 path/content/existing_code/suggestion_code/hint_line/diff_ref
- [x] 7.2 实现文本匹配主策略：从 existing_code/suggestion_code 提取代码行，normalize 后依次在 hunk new-side → old-side → 全文件搜索连续匹配
- [x] 7.3 实现 hunk 对齐兜底：无代码片段但有 hint_line 时用 hunk 行号映射
- [x] 7.4 实现兜底返回 `0,0,"failed"`
- [x] 7.5 单元测试：验证 new-side 命中、old-side 命中、全文件命中、hunk 对齐、定位失败、文件不可读

## 8. 评论反思

- [x] 8.1 实现 `src/reflect.ts`：`reflectComment(repo, input)` 接收 path/content/start_line/end_line/existing_code/diff_ref
- [x] 8.2 实现 `line_in_hunk` 检查：start_line/end_line 是否在 diff hunk 改动行范围内
- [x] 8.3 实现 `existing_code_found` 检查：existing_code 是否真实存在于文件（空/未提供时 not applicable 默认通过）
- [x] 8.4 实现 `existing_code_in_diff` 检查：existing_code 至少一行落在改动行内（空/未提供时 not applicable 默认通过）
- [x] 8.5 实现 verdict 逻辑：任一检查失败→drop；全部通过→keep；定位失败（0,0）→line_in_hunk=false→drop；文件不存在→全 false→drop
- [x] 8.6 单元测试：验证全通过、各检查单独失败、无 existing_code 时仅看 line_in_hunk、定位失败、文件不存在

## 9. MCP server 入口

- [x] 9.1 实现 `src/index.ts`：用 `@modelcontextprotocol/sdk` 创建 stdio server，注册 5 个工具的 schema 和 handler
- [x] 9.2 每个 handler 包 try/catch，异常返回 MCP error response，server 不崩溃
- [x] 9.3 定义 5 个工具的 inputSchema（JSON Schema），与 types.ts 一致
- [x] 9.4 验证 `npx -y` 启动路径：build 后 bin 指向 dist/index.js，stdio 握手成功

## 10. Host 编排 skill

- [x] 10.1 创建 `skills/code-review/SKILL.md`：写明触发条件（review code/PR/commit/changes/compare branches）
- [x] 10.2 写明完整流程：get_review_targets → get_file_bundle → (match_rules + 读文件 + 生成评论 + position_comment + reflect_comment) → 过滤 drop → 输出
- [x] 10.3 写明硬约束：必须调 reflect_comment、drop 必须丢弃、必须按序调 get_review_targets→get_file_bundle、必须传 diff_ref
- [x] 10.4 写明输出格式（High/Medium/Low 分组，aligned with open-code-review skill）
- [x] 10.5 在 README.md 写明三个 host（Claude Code/Codex/Devin）的安装方式

## 11. 配置示例

- [x] 11.1 创建 `.code-review/rules.json` 示例：含 filters.include/exclude 和 rules 数组示例
- [x] 11.2 在 README.md 文档化配置格式和优先级（--rule flag > repo > home > 内置默认）

## 12. 测试仓库与验证

- [x] 12.1 创建最小测试仓库：user.ts（null 检查 bug）、user.test.ts、auth.ts（SQL 注入）、utils.ts（干净文件）、i18n/messages_en.ts、messages_zh.ts、package.json
- [x] 12.2 集成测试：用 MCP inspector 手动调 5 个工具，验证返回结构
- [ ] 12.3 端到端测试：在 Claude Code 通过 skill 跑完整 review，验证输出格式和评论质量
- [ ] 12.4 稳定性测试：同一 test repo 跑 3 次，验证文件覆盖率 100%、定位准确率 > 80%
- [x] 12.5 跨平台验证：在 Windows 上验证路径分隔符、非 ASCII 文件名、CRLF 处理
