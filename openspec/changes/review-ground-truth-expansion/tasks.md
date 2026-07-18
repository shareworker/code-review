## 1. Types

- [ ] 1.1 在 `src/types.ts` 新增 `LintFinding`、`GetLintFindingsInput`/`GetLintFindingsResult` 类型
- [ ] 1.2 新增 `SecretFinding`、`ScanSecretsInput`/`ScanSecretsResult` 类型
- [ ] 1.3 新增 `CheckDependencyDiffInput`/`CheckDependencyDiffResult` 类型
- [ ] 1.4 新增 `GetFileHistoryStatsInput`/`GetFileHistoryStatsResult` 类型
- [ ] 1.5 新增 `RunAffectedTestsInput`/`RunAffectedTestsResult` 类型
- [ ] 1.6 新增 `GetImportersInput`/`GetImportersResult` 类型
- [ ] 1.7 新增 `DedupeCommentsInput`/`DedupeCommentsResult`、`CommentForDedupe` 类型
- [ ] 1.8 扩展 `LocatedBy` 枚举新增 `"fuzzy_match"`；扩展 `FileBundle` 新增可选 `keyDiff` 字段；扩展 `BundleFile` 新增 `densityRank`（如需要）

## 2. `get_lint_findings` 工具

- [ ] 2.1 新建 `src/lint.ts`：实现工具检测逻辑（按配置文件存在性判断 eslint/tsc/ruff/go vet/clippy 是否适用）
- [ ] 2.2 实现 eslint 检测与调用（`node_modules/.bin/eslint` + `--format json`），解析输出为 `LintFinding[]`
- [ ] 2.3 实现 tsc 检测与调用（`tsconfig.json` 存在 → `tsc --noEmit`），解析编译诊断为 `LintFinding[]`
- [ ] 2.4 实现 ruff/go vet/clippy 的检测与调用（PATH 查找二进制，找不到则跳过该工具）
- [ ] 2.5 实现执行超时（默认 60s）与子进程终止逻辑，超时标记 `timed_out=true` 但不影响其他工具结果
- [ ] 2.6 处理无任何已知配置场景，返回空结果 + `reason`，不报错
- [ ] 2.7 新增 `src/__tests__/lint.test.ts`：覆盖 eslint 检测命中、tsc 检测命中、二进制缺失跳过、无配置场景、超时场景

## 3. `scan_secrets` 工具

- [ ] 3.1 新建 `src/secrets.ts`：定义内置密钥正则模式（AWS key、私钥 PEM 头、JWT、常见 `api_key=`/`token=`/`password=` 赋值）
- [ ] 3.2 实现 Shannon 熵值计算函数，对疑似字符串字面量做高熵检测（长度阈值 + 熵值阈值）
- [ ] 3.3 实现 `scanSecrets(repo, input)`：只扫描 diff 新增行（复用 `diff-parser.ts` 的 hunk 解析获取 added 行），对每行应用正则模式和熵值检测
- [ ] 3.4 实现命中结果的 `matched_text` 部分掩码逻辑（保留首尾少量字符，中间替换为 `*`）
- [ ] 3.5 新增 `src/__tests__/secrets.test.ts`：覆盖已知模式命中、高熵字符串命中、未改动历史内容不报告、无匹配场景

## 4. `check_dependency_diff` 工具

- [ ] 4.1 新建 `src/dependency-diff.ts`：实现 `package.json` 依赖解析（dependencies + devDependencies）
- [ ] 4.2 实现 `requirements.txt` 依赖解析（`name==version`/`name>=version`/裸包名格式）
- [ ] 4.3 实现 `go.mod` 依赖解析（`require` 块的 module + version）
- [ ] 4.4 实现 `checkDependencyDiff(repo, input)`：对比 `diff_ref` 前后两份解析结果，算出 `added`/`removed`/`unpinned`
- [ ] 4.5 处理文件在指定 ref 不存在或解析失败场景，返回空结果 + `reason`
- [ ] 4.6 新增 `src/__tests__/dependency-diff.test.ts`：覆盖三种清单格式、未锁定版本检测、新增/移除检测、解析失败场景

## 5. `get_file_history_stats` 工具

- [ ] 5.1 新建 `src/file-history.ts`：实现 `getFileHistoryStats(repo, input)`，基于 `git log --follow --format=...` 获取该文件的 commit 历史
- [ ] 5.2 实现 fix/bug/hotfix 关键词（大小写不敏感）匹配 commit message，计算 `fix_commit_ratio`
- [ ] 5.3 处理新文件（无历史）和路径从未出现在历史中两种场景
- [ ] 5.4 新增 `src/__tests__/file-history.test.ts`：覆盖有历史文件的统计、新文件场景、路径不存在场景

## 6. `run_affected_tests` 工具

- [ ] 6.1 新建 `src/run-tests.ts`：实现 `runAffectedTests(repo, input)`，读取 `package.json` 的 `scripts.test` 字段
- [ ] 6.2 用 `child_process.execFile`（不经过 shell，Windows 下经由 `npm.cmd`）以 `npm run test` 等价方式执行，避免命令注入
- [ ] 6.3 实现超时（默认 60000ms，可通过 `timeout_ms` 覆盖）与进程终止，超时标记 `timed_out=true`
- [ ] 6.4 处理 `package.json` 不存在或无 `scripts.test` 场景，返回空结果 + `reason`，不执行任何命令
- [ ] 6.5 新增 `src/__tests__/run-tests.test.ts`：覆盖测试通过、测试失败（非零退出码原样返回）、超时、无 test script 场景

## 7. `get_importers` 工具

- [ ] 7.1 新建 `src/importers.ts`：实现正则提取 `import ... from "..."`、`require("...")`、`export ... from "..."` 中的相对路径模块引用
- [ ] 7.2 实现相对路径解析为绝对路径（处理无扩展名、`index` 文件等 Node 模块解析规则的常见情况）
- [ ] 7.3 实现遍历仓库内 `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` 文件构建反向索引，`getImporters(repo, input)` 查询该索引
- [ ] 7.4 处理无引用方场景，返回空列表
- [ ] 7.5 新增 `src/__tests__/importers.test.ts`：覆盖 import/require 静态引用命中、无引用方场景、动态 import 不被识别（记录为已知局限的测试用例）

## 8. `dedupe_comments` 工具

- [ ] 8.1 新建 `src/dedupe.ts`：实现评论 `content` 规范化（小写、去标点、分词）
- [ ] 8.2 实现 Jaccard 相似度计算（词集合交集/并集）
- [ ] 8.3 实现 `dedupeComments(input)`：两两比较，超过 `similarity_threshold`（默认 0.6）且 `existing_code` 高度重叠时判定重复，保留 `path` 字母序最先的一条
- [ ] 8.4 新增 `src/__tests__/dedupe.test.ts`：覆盖重复识别、相似度不足不判重复、空列表、自定义阈值

## 9. `position_comment` 模糊匹配兜底层

- [ ] 9.1 在 `src/position.ts` 新增 Levenshtein 距离计算函数（或引入零依赖的轻量实现）
- [ ] 9.2 在文本匹配和 hunk 对齐都失败后，新增模糊匹配层：对文件内容做等长滑动窗口，计算与规范化后 `existing_code` 的距离/长度比，低于阈值（默认 0.15）时接受
- [ ] 9.3 命中模糊匹配时 `located_by="fuzzy_match"`，未命中时仍走原有 `"failed"` 兜底
- [ ] 9.4 扩展 `src/__tests__/position.test.ts`：覆盖模糊匹配命中（小幅改动如变量重命名）、模糊匹配也未命中场景，确认现有 text_match/hunk_align 测试不受影响

## 10. `get_file_bundle` 智能截断 + i18n key 一致性

- [ ] 10.1 在 `src/bundler.ts` 实现每个文件"改动密度"计算（insertions+deletions / diff 字符数）
- [ ] 10.2 修改现有字符上限逻辑：按密度降序排列候选文件后再应用 20000 字符 cap
- [ ] 10.3 新建或扩展 i18n key 一致性检查：对 `bundle_reason="i18n_variants"` 的 bundle，解析各文件顶层 JSON key 集合，计算两两 `missing_keys`/`extra_keys`
- [ ] 10.4 处理 i18n bundle 文件非 JSON/解析失败场景，`key_diff` 为空或带 `reason`，不抛异常
- [ ] 10.5 扩展 `src/__tests__/bundler.test.ts`：覆盖密度排序影响截断优先级、i18n key diff 命中缺失/多余 key、非 JSON 文件跳过检查，确认现有 test/source 配对测试不受影响

## 11. 第二批内置语言规则

- [ ] 11.1 在 `src/rules.ts` 的 `BUILT_IN_LANGUAGE_RULES` 新增 Python 规则（类型提示、异常处理、eval/exec/shell 注入风险）
- [ ] 11.2 新增 Go 规则（错误处理、goroutine 泄漏、defer 使用）
- [ ] 11.3 新增 Java 规则（异常处理、资源关闭、并发安全）
- [ ] 11.4 新增 SQL mapper (`.xml`) 规则（SQL 注入、参数化查询、标签闭合）
- [ ] 11.5 新增 Dockerfile 规则（基础镜像固定版本、多阶段构建、非 root 用户、敏感信息硬编码）
- [ ] 11.6 扩展 `src/__tests__/rules.test.ts`：覆盖新增五类语言规则命中、按扩展名/文件名区分，确认现有测试不受影响

## 12. MCP 工具注册

- [ ] 12.1 在 `src/index.ts` 的 `ListToolsRequestSchema` 处理器中新增 7 个新工具的定义（含 JSON Schema 参数描述），并更新版本号和"N 个工具"注释
- [ ] 12.2 在 `src/index.ts` 的 `CallToolRequestSchema` 处理器中新增对应 `case` 分支
- [ ] 12.3 更新 `get_file_bundle` 的响应结构，加入 `key_diff` 字段
- [ ] 12.4 更新 `position_comment` 的文档/描述，说明新增 `fuzzy_match` 定位方式
- [ ] 12.5 新增/扩展 `src/__tests__/e2e.test.ts`，覆盖新工具的端到端 MCP 调用（至少每个新工具一条 happy-path 场景）

## 13. 文档更新

- [ ] 13.1 更新 `skills/code-review/SKILL.md`：在正确 pipeline 阶段插入新工具调用时机（lint/secret 扫描、依赖检查、历史统计、跑测试、依赖检索、去重）
- [ ] 13.2 更新 `skills/code-review/SKILL.md`：新增"置信度"输出维度指引——由 `get_lint_findings`/`scan_secrets`/`run_affected_tests`/`evidence_valid` 支撑的评论标记为高置信度
- [ ] 13.3 更新 `README.md`（中英双语）：工具列表从 7 个更新为 14 个，明确披露 `get_lint_findings`/`run_affected_tests` 会执行仓库内命令这一新的运行时行为
- [ ] 13.4 更新 `README.md` 的 Design Lineage 章节，补充本轮"地面真值信号"相对 OCR 的差异化定位说明

## 14. 验证

- [ ] 14.1 运行 `npm run build`，确认 TypeScript 编译无误
- [ ] 14.2 运行 `npm test`，确认新增测试通过且现有测试无回归
- [ ] 14.3 运行 `openspec validate review-ground-truth-expansion` 确认变更产物仍有效
