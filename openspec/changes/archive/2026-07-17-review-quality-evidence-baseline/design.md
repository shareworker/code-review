## Context

`code-review-mcp` 暴露 5 个确定性工具，宿主 LLM 负责所有推理。对标 alibaba/open-code-review（OCR）发现的核心质量差距：OCR 自带 agent loop，能在 review 过程中反复调用 `code_search`/`file_read` 获取跨文件证据，并用语言专属规则文档压低误报；本项目目前只给宿主 diff + 单条通用规则，跨文件取证完全依赖宿主自身能力，`reflect_comment` 只验证评论定位真实性，不验证评论引用的跨文件证据是否真实存在。

本设计不引入 agent loop 或 LLM 调用——那会破坏"server 不调 LLM、host-agnostic"的核心定位，等于把项目变成一个更差的 OCR。而是把"证据获取"和"证据真实性校验"做成两个新的确定性工具/检查项，让宿主在现有 LLM 循环里调用即可获得等价能力。

## Goals / Non-Goals

**Goals:**
- 提供文本/路径级跨文件证据获取工具（`search_code`、`read_file_context`），host-agnostic、无新增运行时依赖。
- 让 `reflect_comment` 能校验评论引用的跨文件证据是否真实存在（`evidence_valid` 检查），且完全向后兼容现有调用。
- 把内置规则从单条通用规则升级为按路径匹配的语言/文件类型专属规则表，降低误报率。
- 更新 `SKILL.md`，让宿主知道何时取证、如何处理定位失败、如何去重。

**Non-Goals:**
- 不做 AST/符号解析（definitions/callers/callees）——文本级检索已能覆盖多数跨文件线索获取场景，且不需要引入语言分析基础设施。
- 不做 agent loop、plan/batch/token 预算、跨 bundle 去重——这些属于"大 PR 覆盖率"问题，是独立的后续迭代，与本次"证据优先"的质量基线目标正交。
- 不做 suggestion-diff 渲染——体验性功能，优先级低于质量基线。
- 不校验证据与评论内容的语义相关性——只验证证据本身真实存在，语义判断仍是宿主职责。

## Decisions

### 1. 跨文件证据检索：文本/路径级，而非 AST 符号解析

**决策**：`search_code` 基于 `git grep`，`read_file_context` 基于现有 ref/worktree 文件读取逻辑。

**备选方案**：引入语言级符号索引（definitions/callers/callees），可显著提升跨文件召回率。

**理由**：AST 方案需要按语言适配解析器、维护索引/缓存，把一个轻量 MCP server 变成语言分析平台，与项目"小依赖、多语言、快维护"的定位冲突。文本级检索零新增依赖（复用已有 `simple-git`），多语言通用，且已能覆盖 OCR 规则文档里大部分"用 code_search 确认调用方/数据源"场景。AST 能力可作为独立的后续迭代按需引入。

### 2. `search_code` 的搜索源随 `diff_ref` 自适应

**决策**：workspace 模式搜工作区（含 `--untracked`），range/commit 模式搜对应 revision。

**备选方案**：始终搜工作区（实现更简单）。

**理由**：证据必须和被审查的代码版本一致，否则宿主可能引用一段已被后续提交修改/删除的代码作为"证据"，产生误导性评论。这个约束和现有 `position.ts`/`reflect.ts` 已经遵循的"diff_ref 决定读取版本"原则一致，不是新引入的复杂度。

### 3. `reflect_comment` 扩展而非新增独立工具

**决策**：给 `reflect_comment` 加可选 `evidence` 输入字段和 `evidence_valid` 检查项，不新增 `validate_comment_evidence` 之类的独立工具。

**备选方案**：新增独立证据校验工具。

**理由**：独立工具会让"一条评论的确定性判定"分裂成两次调用两个 verdict，宿主需要自己合并 keep/drop 逻辑，增加编排复杂度且违反现有"一次 reflect 得到最终 verdict"的心智模型。扩展现有工具、`evidence` 字段可选，完全向后兼容——已有调用方（未传 `evidence`）行为不变。

### 4. 语言规则内容原创撰写，不复制 OCR 的 `rule_docs/*.md`

**决策**：内置规则表的内容参考 OCR 规则文档的分类结构（如"死代码检测""线程安全反例"）原创改写，不逐句复制。

**备选方案**：直接移植 OCR 的 Apache-2.0 规则文档文本。

**理由**：OCR 是 Apache-2.0 许可，本项目是 MIT；实质性内容复制会带来 Apache-2.0 的署名保留义务，增加许可证合规复杂度。原创改写规避此风险，且可以针对本项目实际工具能力（无 code_search 时如何措辞"确认"类指令）做适配。

## Risks / Trade-offs

- **[风险] `git grep` 在超大仓库上可能较慢** → 缓解：`max_results` 硬上限（默认 50）快速截断；不做全仓库索引，接受单次调用的性能上限。
- **[风险] 文本级检索的跨文件召回率不如 AST 方案** → 缓解：这是本迭代的既定取舍（Non-Goals 已说明），后续迭代可在此工具接口之上叠加符号级能力，不需要推翻现有设计。
- **[风险] `evidence` 字段增加宿主的编排负担（要在生成评论后额外组装证据）** → 缓解：字段可选，宿主可以完全不使用；`SKILL.md` 只建议在"怀疑跨文件影响"时使用，不强制每条评论都带证据。
- **[风险] 语言规则表内容原创改写的质量可能不如 OCR 经过实战验证的规则文本** → 缓解：首批只覆盖高频场景（TS/JS/JSON/YAML/GitHub Actions/package.json），后续可根据实际误报反馈迭代规则内容；规则表结构本身支持增量扩展。

## Migration Plan

- 纯新增/扩展，无破坏性变更：新工具是新增注册；`reflect_comment`/`match_rules` 的扩展字段/规则表均向后兼容现有调用方和现有 `.code-review/rules.json` 配置。
- 部署方式不变：随下一个 npm 版本发布，宿主重启 MCP 连接即可获得新工具，无需用户侧配置迁移。
- 回滚：若新工具或检查项出现问题，可通过发布补丁版本移除注册（工具未被调用则无副作用），不需要数据迁移或状态清理（server 本身无状态）。

## Open Questions

- 语言规则表第二批（Java/Rust/C/C++/Kotlin 等）的内容和排期，留给实现后的独立迭代决定，不阻塞本次基线交付。
- `search_code` 是否需要支持正则表达式还是仅字面量查询，将在 tasks 阶段结合 `git grep` 的实际参数能力确定，不影响本设计的架构决策。
