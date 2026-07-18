## Context

上一轮变更（`review-quality-evidence-baseline`）给 `code-review-mcp` 加上了跨文件文本证据获取（`search_code`/`read_file_context`）和证据真实性校验（`evidence_valid`），把确定性层从"只看 diff"升级为"能取证"。本轮进一步利用**项目自身工具链产出的地面真值信号**——lint/typecheck 诊断、真实测试执行结果、secret 正则命中、依赖元数据、git 历史统计——这些信号比宿主 LLM 的语义推断更可靠，且是 alibaba/open-code-review 的 agent loop 也未利用的信号源。同时补齐与 OCR 确定性层的既有差距：跨文件依赖检索（`get_importers`）、评论去重（`dedupe_comments`）、定位鲁棒性（模糊匹配兜底）、大 diff 的 token 预算（按密度排序截断）、语言规则覆盖度（第二批）。

本轮首次让 server 执行仓库内命令（`get_lint_findings` 跑 lint 工具、`run_affected_tests` 跑 `npm test`），这是相对此前"只读 git 数据"的行为升级，需要在设计中明确信任边界和执行护栏。

## Goals / Non-Goals

**Goals:**
- 用真实工具输出（lint/typecheck、测试执行、secret 正则、git log、依赖清单 diff）替代宿主对这些领域的语义猜测。
- 补齐 `search_code` 之外的另一种跨文件检索需求——"谁引用了这个文件/模块"（`get_importers`），用模块级 import 图，不引入 AST。
- 把"评论去重"从 SKILL.md 的软约束变成 server 侧确定性工具（`dedupe_comments`）。
- 提升 `position_comment` 的定位成功率（模糊匹配兜底），且仍是确定性逻辑。
- 把 `get_file_bundle` 的硬字符截断升级为按改动密度的智能截断，`i18n_variants` bundle 新增 key 一致性硬校验。
- 扩展内置语言规则覆盖 Python/Go/Java/SQL mapper/Dockerfile。
- 明确执行仓库命令（lint/测试）的安全边界，并在文档中披露。

**Non-Goals:**
- 不做 AST/符号解析——`get_importers` 用正则解析 import 语句，接受漏报（如动态 `require(variable)`）换取零新增依赖。
- 不做依赖新鲜度的网络查询（npm registry/PyPI API 调用）——`check_dependency_diff` 只做本地可判定的检查（未锁定版本、新增/移除清单），避免引入网络请求这一新的运行时行为类别。
- 不接受宿主为 `run_affected_tests` 传入任意命令字符串或测试文件路径过滤——只读取 `package.json` 的 `test` script 并原样执行，降低命令注入面。
- 不做 license 数据库对比——`check_dependency_diff` 不判断 license 合规性，只做版本约束检查。
- 不引入 agent loop、不让 server 调用 LLM 做语义反思/重定位/去重判断——`dedupe_comments` 用确定性文本相似度，不用语义相似度。

## Decisions

### 1. `get_lint_findings`：检测已配置工具并执行，不强制安装新工具

**决策**：按文件存在性检测项目已配置的 lint/typecheck 工具（`.eslintrc*`/`eslint.config.*` → eslint；`tsconfig.json` → `tsc --noEmit`；`pyproject.toml`/`ruff.toml` → ruff；`.golangci.yml` 或 `go.mod` → `go vet`；`Cargo.toml` → `cargo clippy`），通过项目本地 `node_modules/.bin/`（Node 生态）或系统 PATH（Python/Go/Rust 生态）调用，解析各自的 JSON/文本输出格式为统一的 `LintFinding[]`。检测不到任何已知配置时返回空结果 + `reason`，不报错、不代为安装工具。

**备选方案**：让 server 自己捆绑固定版本的 linter 并统一跑。

**理由**：捆绑 linter 违反"零新增运行时依赖、小体积"的项目定位，且会与项目自己的 lint 配置产生双重标准冲突（例如项目自定义了 eslint 规则，server 又跑一套默认规则会产生噪音）。检测+调用项目已有配置更贴近"揭示项目自己已经知道但没跑"的信号，而不是发明新标准。

### 2. `scan_secrets`：基于正则 + 简单熵值，不接入外部 secret 扫描服务

**决策**：内置一组已知密钥模式的正则（AWS Access Key `AKIA[0-9A-Z]{16}`、私钥头 `-----BEGIN...PRIVATE KEY-----`、JWT 三段式、常见 `api_key=`/`token=`/`password=` 赋值模式），加一个轻量 Shannon 熵值检测（对疑似字符串字面量计算熵，超过阈值且长度超过一定字符数才报告，减少误报）。只扫描 diff 的新增行（不扫描整个文件，避免对历史遗留的 secret 反复报告造成噪音）。

**备选方案**：接入 `detect-secrets`（Python 工具）或 `gitleaks`（Go 二进制）作为子进程。

**理由**：这些工具需要额外安装/下载二进制，与"零新增运行时依赖"冲突；内置的正则+熵值方案覆盖最高频的意外泄露场景（云服务商 key、私钥、token），且实现和维护成本可控。规则集可以后续增量扩展，不需要引入外部工具依赖。

### 3. `check_dependency_diff`：只做本地可判定检查，不查网络

**决策**：对比 `package.json`/`requirements.txt`/`go.mod` 在 `diff_ref` 前后的解析结果，输出新增依赖列表、移除依赖列表、以及新增依赖里版本约束是否为"未锁定"（`*`、`latest`、无版本号、npm 的裸 `>=`/无上界范围）。

**备选方案**：调用 npm registry/PyPI API 查询包的实际发布时间，判断是否"发布不到 7 天"。

**理由**：网络请求会让 MCP server 从"纯本地确定性工具"变成"依赖外部服务可用性"的工具，一旦网络不可用或被限流，行为退化为不确定；对于一个以"零配置、离线可用"为卖点的项目，本地可判定的版本约束检查已能覆盖多数供应链风险信号（未锁定版本本身就是风险），网络新鲜度检查作为后续可选迭代，不放进本轮。

### 4. `run_affected_tests`：只读取 package.json 的 test script，不接受宿主自定义命令

**决策**：读取仓库 `package.json` 的 `scripts.test` 字段，用 `child_process.execFile`（不经过 shell，避免注入）以 `npm run test` 的等价方式执行（Windows 下经由 `npm.cmd`），默认超时 60 秒（可通过输入覆盖），返回 `{ exitCode, stdout, stderr, timedOut }`。超时或非零退出码原样返回给宿主，不重试、不吞异常、不修改任何文件。非 Node 生态（无 `package.json`）返回空结果 + `reason`。

**备选方案 A**：允许宿主传入任意命令字符串。
**备选方案 B**：允许宿主传入测试文件路径列表，工具负责拼接成受支持测试框架（vitest/jest/pytest/go test）的过滤参数。

**理由**：方案 A 是明显的命令注入面，即使是"host 是可信 agent"的场景，也不应该让 MCP 工具成为可以执行任意 shell 命令的通道。方案 B 需要为每个测试框架实现参数拼接逻辑，增加了框架耦合度和维护成本；本轮选择最小可行版本——只跑项目已声明的完整 `test` script，接受"可能比只跑受影响测试慢"的代价，换取更小的攻击面和实现复杂度。这与用户明确选择的执行策略一致。

### 5. `get_importers`：正则解析 import 语句，不引入 AST/tree-sitter

**决策**：对 `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` 文件用正则提取 `import ... from "..."`、`require("...")`、`export ... from "..."` 语句里的模块路径，解析相对路径为绝对路径后建立"文件 → 引用它的文件列表"的反向索引；调用 `get_importers(path)` 时返回命中列表。

**备选方案**：引入 tree-sitter 做真正的 AST 解析，能处理动态 import、条件 require 等边界情况。

**理由**：与 `design.md`（上一轮）里对 `search_code` 的决策一致——AST 方案需要按语言维护解析器，与"小依赖、多语言、快维护"定位冲突。正则方案覆盖绝大多数静态 import 场景（这是"谁引用了这个文件"场景里的主体），动态 import/条件 require 的漏报可接受，作为已知局限记录在 Risks。首批只覆盖 TS/JS 生态（与 Prong A 的既有语言规则覆盖度一致），其他语言的 import 语法留给后续迭代。

### 6. `dedupe_comments`：规范化文本相似度，不用语义相似度

**决策**：对每条评论的 `content` 做规范化（小写、去标点、分词），用 Jaccard 相似度（词集合交集/并集）判断两条评论是否重复，超过阈值（默认 0.6，可配置）且 `existing_code` 规范化后完全一致或高度重叠时判定为重复，保留其中 `path` 字母序最先的一条。

**备选方案**：用 embedding 向量做语义相似度。

**理由**：embedding 需要调用一个模型（即使是本地小模型也是新的运行时依赖和"事实上调用了 LLM/ML 模型"），违反核心约束。Jaccard 相似度是纯字符串统计，零依赖，且"同一个问题在多个相似文件里重复出现"的典型场景（如 i18n 变体文件、CRUD 模板代码）通常措辞高度重叠，词级相似度已能覆盖。

### 7. `position_comment` 模糊匹配兜底层

**决策**：在现有 text_match → hunk_align 两级之后新增第三级：对 `existing_code` 和文件每个等长窗口计算规范化后的 Levenshtein 距离，距离/长度比低于阈值（默认 0.15，即 85% 相似）时接受为匹配，`located_by` 标记为新增值 `"fuzzy_match"`。

**备选方案**：调用宿主 LLM 重新定位（OCR 的方案）。

**理由**：与本项目"server 不调 LLM"的边界一致；模糊匹配能覆盖"变量重命名/小幅格式调整导致的精确匹配失败"这一类高频场景，且始终是确定性、可测试的逻辑。

### 8. `get_file_bundle` 按改动密度排序截断 + i18n key 一致性

**决策**：计算每个文件的"改动密度" = (`insertions + deletions`) / 该文件 diff 文本字符数，按密度降序排列后再应用现有 20000 字符 cap（密度高的文件优先保留完整内容，密度低的文件在预算不足时优先被截断或移出当前 bundle）。对 `bundleReason === "i18n_variants"` 的 bundle，额外解析每个文件的顶层 JSON key 集合，计算两两之间的 `missing_keys`/`extra_keys`，附加在 bundle 结果里。

**备选方案**：保持文件出现顺序不变，只是排队"顺序截断"。

**理由**：现有硬截断按文件枚举顺序（本质是 git diff 的输出顺序），与"这个文件改动有多密集/多值得审查"无关；按密度排序能让预算优先分配给真正值得深度审查的文件。i18n key diff 是纯 JSON 解析对比，零成本地把"哪个语言少了个 key"这种人工目测容易漏的问题变成确定性输出。

## Risks / Trade-offs

- **[风险] `get_lint_findings`/`run_affected_tests` 执行仓库内命令，是本项目首次执行代码而非只读 git 数据** → 缓解：`run_affected_tests` 只读取 `package.json.scripts.test` 字段本身（不解释其内容、不做命令拼接），且使用 `execFile`（不过 shell）执行；`get_lint_findings` 只调用检测到的、项目自己声明要用的 lint/typecheck 二进制。两者的信任边界等价于"运行 `npm install && npm test`"本身已隐含的信任级别，在 README/SKILL.md 中需要用醒目的段落披露这一行为变化。
- **[风险] `run_affected_tests` 跑全量 `test` script 而非仅受影响测试，可能较慢** → 缓解：这是本轮明确选择的权衡（避免为每个测试框架实现过滤参数拼接），60 秒默认超时提供硬上限；后续迭代可在此基础上加框架特定的过滤支持。
- **[风险] `scan_secrets` 的正则+熵值方案可能漏报新型密钥格式或误报高熵的非密钥字符串（如 hash、UUID）** → 缓解：只扫描 diff 新增行减少总体噪音；熵值阈值可调；记录为已知局限，规则集可增量扩展。
- **[风险] `get_importers` 的正则解析无法处理动态 import (`import(variablePath)`)、条件 require、路径别名（如 tsconfig `paths` 映射）** → 缓解：首批只处理相对路径的静态 import/require，别名解析作为已知局限；比完全没有该能力仍是净增益。
- **[风险] `check_dependency_diff` 不做网络新鲜度查询，可能漏掉"版本号锁定但发布时间很新"的供应链风险** → 缓解：Non-Goal 已明确排除；锁定版本本身已经是可接受的风险管理实践，网络查询可作为独立后续迭代。
- **[风险] `dedupe_comments` 的 Jaccard 阈值可能误判措辞不同但语义相同的评论为不重复，或误判措辞相似但指向不同问题的评论为重复** → 缓解：阈值可配置；默认阈值经验设定为 0.6，倾向"宁可漏判重复，不误删有效评论"（阈值设高一些，牺牲部分去重召回率换取精确率）。
- **[风险] 新增 7 个工具后总工具数达到 14 个，可能增加宿主 LLM 的工具选择负担** → 缓解：每个工具描述都明确写明"何时用"，SKILL.md 编排协议明确指定每个工具在 pipeline 哪个阶段调用，减少宿主自主判断的负担。

## Migration Plan

- 纯新增/扩展，无破坏性变更：新工具是新增注册；`get_file_bundle`/`position_comment` 的响应结构是新增字段（`density_rank`、`key_diff`、`located_by: "fuzzy_match"` 新枚举值），不移除现有字段。
- **需要明确的行为变化披露**：`get_lint_findings`/`run_affected_tests` 会执行仓库命令，属于新的运行时行为类别（此前只读 git 数据）。发布时需要在 CHANGELOG/README 顶部披露这一点，供已安装用户知晓升级后的行为变化。
- 部署方式不变：随下一个 npm 版本发布，宿主重启 MCP 连接即可获得新工具。
- 回滚：新工具/字段未被调用则无副作用；若 `run_affected_tests` 或 `get_lint_findings` 在某些环境执行异常（如 CI 沙箱禁止子进程），可发布补丁版本移除注册，不需要数据迁移。

## Open Questions

- `get_lint_findings` 首批支持的工具集（eslint/tsc/ruff/golint/clippy）后续是否需要扩展到更多生态（如 Java 的 checkstyle、C# 的 Roslyn analyzers），留给实现后的独立迭代按用户反馈决定。
- `dedupe_comments` 的 Jaccard 阈值 0.6 是否需要针对真实评论语料调优，留给 Benchmarking 阶段（Phase 5，未在本轮范围内）验证。
