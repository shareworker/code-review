## 1. Types

- [x] 1.1 在 `src/types.ts` 新增 `EvidenceRef` 接口（`path`、可选 `startLine`/`endLine`、必填 `snippet`）
- [x] 1.2 扩展 `ReflectInput`，新增可选字段 `evidence?: EvidenceRef[]`
- [x] 1.3 扩展 `CheckResult["name"]` 枚举，新增 `"evidence_valid"`
- [x] 1.4 新增 `SearchCodeInput`/`SearchMatch`/`SearchCodeResult`、`ReadFileContextInput`/`ReadFileContextResult` 类型

## 2. `search_code` 工具

- [x] 2.1 新建 `src/search-code.ts`：实现 `searchCode(repo, input)`，基于 `git grep -n` 检索
- [x] 2.2 按 `diffRef` 判断搜索源：workspace（`"HEAD"`）搜工作区并加 `--untracked`；range/commit 搜对应 revision
- [x] 2.3 应用 `.code-review/rules.json` 的 `filters.exclude`（复用 `filter.ts` 现有加载逻辑）过滤结果路径
- [x] 2.4 实现 `maxResults`（默认 50）截断与 `truncated`/`totalMatches` 计算
- [x] 2.5 处理非 git 仓库、无效 pattern、无匹配三类场景，返回空结果 + `reason`，不抛异常
- [x] 2.6 新增 `src/__tests__/search-code.test.ts`：覆盖 workspace/range 搜索源差异、排除规则、截断、无匹配、非法输入

## 3. `read_file_context` 工具

- [x] 3.1 新建 `src/read-file-context.ts`：实现 `readFileContext(repo, input)`
- [x] 3.2 实现锚点模式（`anchorLine` + `before`/`after`）和显式区间模式（`startLine`/`endLine`）两种范围解析，二选一校验
- [x] 3.3 复用 `git.ts` 现有的 ref-then-worktree 回退逻辑读取文件内容
- [x] 3.4 实现 `maxLines`（默认 200）截断与 `truncated` 标记
- [x] 3.5 处理文件在 ref 和 worktree 均不存在、范围参数缺失两类错误场景
- [x] 3.6 新增 `src/__tests__/read-file-context.test.ts`：覆盖锚点模式、显式区间、截断、ref/worktree 回退、文件不存在、参数缺失

## 4. `reflect_comment` 扩展

- [x] 4.1 在 `src/reflect.ts` 新增 `checkEvidenceValid(evidence, repo, diffRef)`：`evidence` 为空/未提供时返回 `passed=true`（not applicable）
- [x] 4.2 对每条 `evidence` 校验 `path`/`snippet` 是否齐备，缺失则该条判定失败
- [x] 4.3 复用 `checkExistingCodeFound` 的规范化连续行匹配逻辑，校验 `snippet` 是否存在于对应 `path` 的文件内容
- [x] 4.4 将 `evidence_valid` 纳入现有 "any check fails → drop" 的 verdict 汇总逻辑
- [x] 4.5 扩展 `src/__tests__/reflect.test.ts`：evidence 缺省时向后兼容（现有测试不变）、evidence 命中、evidence 未命中、evidence 条目格式错误

## 5. 语言专属规则表

- [x] 5.1 在 `src/rules.ts` 将 `BUILT_IN_DEFAULT_RULE`（单条）改为规则表结构：`{ pattern: string; rule: string }[]`，保留原通用规则作为兜底项
- [x] 5.2 原创撰写首批语言/文件类型规则内容（不复制 OCR 文本）：TS/JS/TSX/JSX、JSON、YAML、GitHub Actions workflow（`.github/workflows/**`）、`package.json`
- [x] 5.3 在 `matchRules` 中新增查找顺序：用户规则 → 内置语言专属规则表 → 内置通用默认规则，保持 `usedDefault` 语义（命中内置表或通用默认均为 `true`）
- [x] 5.4 扩展 `src/__tests__/rules.test.ts`：语言专属规则命中、多规则按扩展名区分、无匹配回退通用默认

## 6. MCP 工具注册

- [x] 6.1 在 `src/index.ts` 的 `ListToolsRequestSchema` 处理器中新增 `search_code`、`read_file_context` 的工具定义（含 JSON Schema 参数描述）
- [x] 6.2 在 `src/index.ts` 的 `CallToolRequestSchema` 处理器中新增对应 `case` 分支，调用 `searchCode`/`readFileContext`
- [x] 6.3 更新 `reflect_comment` 的工具参数 JSON Schema，新增可选 `evidence` 字段说明
- [x] 6.4 新增/扩展 `src/__tests__/e2e.test.ts`，覆盖新工具的端到端 MCP 调用

## 7. 文档更新

- [x] 7.1 更新 `skills/code-review/SKILL.md`：新增"怀疑跨文件影响时先用 `search_code`/`read_file_context` 取证并在 `reflect_comment` 中附带 `evidence`"的指引
- [x] 7.2 更新 `skills/code-review/SKILL.md`：新增 `position_comment` 返回 `locatedBy: "failed"` 时的恢复流程（重新 `read_file_context` 取上下文、重写 `existing_code`、重试一次）
- [x] 7.3 更新 `skills/code-review/SKILL.md`：新增多文件重复问题的宿主侧去重要求
- [x] 7.4 更新 `README.md`（中英双语）：工具列表从 5 个更新为 7 个，补充 `search_code`/`read_file_context` 说明

## 8. 验证

- [x] 8.1 运行 `npm run build`，确认 TypeScript 编译无误
- [x] 8.2 运行 `npm test`，确认新增测试通过且现有测试（`cli.test.ts`、`package.test.ts`、`bundler.test.ts`、`position.test.ts`、`filter.test.ts`、`git.test.ts`、`diff-parser.test.ts`）无回归
- [x] 8.3 运行 `openspec validate review-quality-evidence-baseline` 确认变更产物仍有效
