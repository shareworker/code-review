## Context

通用 agent（Claude/Codex/Devin）做 code review 时存在漏文件、行号漂移、质量波动问题。open-code-review 已验证"确定性工程 × agent 混合"架构能解决，但它自带 LLM，与 host session 的 LLM 和 agent 循环重复。本设计把确定性工程层抽成 MCP server，host agent 在自己的 LLM 循环里调用 5 个工具，server 不碰 LLM。

完整设计细节见 `docs/superpowers/specs/2026-07-02-code-review-mcp-design.md`。架构决策记录见 `docs/adr/0001-deterministic-core-as-mcp-server.md` 和 `docs/adr/0002-server-does-not-call-llm.md`。本文档只记录 openspec 实现阶段的关键技术决策与权衡。

## Goals / Non-Goals

**Goals:**
- 暴露 5 个确定性工具，覆盖文件选择、智能打包、规则匹配、评论定位、评论反思。
- `diff_ref` 在管线中显式流转，保证三种 mode（workspace/range/commit）下所有工具读同一个 diff。
- 零配置分发：`npx -y @shareworker/code-review-mcp` 即用，约定式路径发现 `.code-review/rules.json`。
- server 无状态、不崩溃、跨平台（Windows 路径/非 ASCII 文件名/CRLF）。
- MVP 可在 Claude Code 跑通完整 review，同一 PR 跑 3 次文件覆盖率 100%、定位准确率 > 80%。

**Non-Goals:**
- server 不调 LLM（语义级反思由 host 自审）。
- 不做 open-code-review benchmark 对比（后续迭代）。
- 不做 Codex/Devin 适配（验证通过后再做）。
- 不做 CLI shell（后续为 CI 集成加）。
- 不做 > 100 文件并发优化（MVP 串行读 diff）。
- 不做 plan phase（用 bundle 字符上限替代）。

## Decisions

### D1: TypeScript/Node + `@modelcontextprotocol/sdk`

**选择**: TypeScript/Node 实现，用官方 MCP SDK。
**理由**: MCP 生态首推 TS SDK；host agent（Claude/Codex/Devin）生态对 Node stdio 子进程支持成熟；`npx -y` 零预安装分发天然适配 Node 包。
**备选**: Go（照搬 open-code-review 技术栈）——但 host 侧装 Go runtime 不现实，且 MCP SDK Go 版成熟度低于 TS。

### D2: `simple-git` + `diff` 库分工

**选择**: `simple-git` 做 git 操作（diff/status/show），`diff` 库的 `parsePatch` 做 unified diff 解析，`simple-git` 的 `diffSummary` 提取文件级元数据（rename/binary/mode）。
**理由**: `simple-git` 处理跨平台引号和 `core.quotepath`；`diff` 库的 `parsePatch` 成熟稳定，避免手写 hunk 正则。文件级元数据用 `diffSummary` 而非解析 diff 头，减少 edge case。
**备选**: 纯手写 diff 解析——重复造轮子，rename/binary/mode 边界 case 多。

### D3: `diff_ref` 显式流转（非隐式默认）

**选择**: `get_review_targets` 输出规范 `diff_ref`（workspace→`"HEAD"`、range→`"<from>..<to>"`、commit→`"<commit>^..<commit>"`），host 必须传给 `get_file_bundle`/`position_comment`/`reflect_comment`。工具默认 `"HEAD"` 仅为 workspace 便利。
**理由**: 修复 range/commit 模式下下游工具默认用 `HEAD` 导致静默读错 diff 的结构性缺陷。显式流转保持工具无状态，不依赖前序调用的隐式状态。
**备选 A**: `get_file_bundle` 直接接收 `get_review_targets` 的 `files[]`（含 diff）——工具间耦合上升，MCP 消息体变大。
**备选 B**: 靠 skill prompt 指示 host 传正确 `diff_ref`——回到 prompt 乞求问题，违背 ADR 0001 的硬约束原则。

### D4: `get_file_bundle` 重读 diff（冗余换无状态）

**选择**: `get_file_bundle` 接收 `files: string[]` + `diff_ref`，自己用 `simple-git` 重读 diff，不接收 host 传来的 diff 文本。
**理由**: 保持每个工具无状态、不依赖前序工具输出结构；保证 bundler 和管线其他部分读同一个 diff。冗余读一次 diff 在 MVP 可接受（statelessness 优先于性能）。
**备选**: 接收 host 传来的 diff——耦合 + 消息体膨胀，且 host 可能截断 diff。

### D5: `reflect_comment` 纯确定性，三项检查

**选择**: `reflect_comment` 只做 `line_in_hunk`/`existing_code_found`/`existing_code_in_diff` 三项确定性检查，返回 `keep`/`drop` 二元 verdict，不返回 `revise`。语义级反思由 host LLM 自审。
**理由**: 守住 ADR 0002 的"server 不碰 LLM"边界，系统可测试、可 benchmark。确定性逻辑只能判断"成立/不成立"，"需要修正"是语义判断不在工具能力内。
**备选**: server 内部调 LLM 做语义反思——违背方案 C 前提，引入 LLM 配置，与方案 A 边界模糊。

### D6: bundle 字符上限 20000，按文件整体切分

**选择**: 20000 字符/ bundle，只计 diff 文本（与 `total_chars` 字段一致）。加下一个文件会超限时关闭当前 bundle 开新 bundle，不在文件中间切。单文件 diff 独自超限则独占一个 over-cap bundle，不丢弃。
**理由**: 无 tokenizer 依赖，近似可控。按文件整体切分避免拆坏单个文件的 diff 上下文。不丢弃保证覆盖率（与"不漏文件"目标一致）。
**备选**: 用 tokenizer 精确计 token——引入 tokenizer 依赖，MVP 过度设计。

### D7: `position_comment` 三级策略

**选择**: 文本匹配优先（从 `existing_code`/`suggestion_code` 提取代码行，normalize 后在 hunk new-side → old-side → 全文件依次搜索连续匹配）→ hunk 对齐（无代码片段但有 `hint_line` 时用 hunk 行号映射）→ 兜底 `0,0,"failed"`。
**理由**: 照搬 open-code-review `resolver.go` 已验证的策略。文本匹配对"评论引用了哪段代码"最可靠；hunk 对齐兜底覆盖 host 只给粗略行号的情况。
**备选**: 只用 `hint_line`——host LLM 行号经常漂移，正是本工具要解决的问题。

## Risks / Trade-offs

- **[风险] `simple-git` 在某些 git 版本上 `diffSummary` 行为不一致** → 用 `git diff --no-color` 拿原始文本 + `diff` 库解析做交叉校验；MVP 限定支持 git ≥ 2.20。
- **[风险] 文本匹配在重复代码块上定位错位** → 优先 hunk new-side（改动行）匹配，降低命中未改动重复块的概率；`reflect_comment` 的 `line_in_hunk` 检查兜底丢弃定位到未改动行的评论。
- **[风险] host 不传 `diff_ref` 导致 range/commit 模式静默失败** → skill 硬约束明写"必须传 `diff_ref`"；工具默认 `"HEAD"` 仅在 workspace 模式安全。这是 prompt 层约束，不是代码层硬约束——可接受的局部波动（影响定位准确性，不影响文件覆盖率）。
- **[权衡] `get_file_bundle` 冗余读 diff** → 换取工具无状态和管线一致性。> 100 文件场景耗时上升，MVP 不优化，后续可加 `Promise.all`。
- **[权衡] `reflect_comment` 抓不了语义问题** → "评论建议技术上是否正确"由 host LLM 自审。skill 编排写明 `reflect_comment` 返回 `keep` 后 host 可做语义自审。
- **[权衡] 20000 字符上限是近似值** → 不精确对应 token 数，但无 tokenizer 依赖、跨 host 模型一致。对超长 diff 的 bundle 可能略大于 host 上下文窗口，host 自行截断。
