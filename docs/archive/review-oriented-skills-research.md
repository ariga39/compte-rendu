# 代码审查 Skill 调研：宽覆盖、浅深度的现有资产

> Archived research, not current product policy. The topic-skill proposals below
> were explored and prototyped but were not shipped. PR #222 adopts only the
> general `code-review` skill, drawing on OpenCode, Codex, Vercel and Sentry.
> The shared prompt owns scope, permissions, orchestration and output; the skill
> supplies review methods. See [current design](../design.md) for the implemented contract.
> Historical recommendations and validation notes below describe their original
> research stage, not the current skill inventory or a review-quality benchmark.

> 范围：主动核查 `sanyuan0704/sanyuan-skills` 与 `awesome-skills/code-review-skill`；`gstack`、`wshobson`、`Sentry` 采用 primary 已确认事实及 `/tmp` 缓存，未另扩搜索。固定于 2026-10-20 HEAD；仅研究，未安装、未改编。

## 采用标准

- 主题之间覆盖设计与开发的主要方面；每个主题内部也保留尽量广泛的检查方向，不限制为三到五条。
- 精简的是每个方向的解释、示例和教程，不是覆盖面。每条简短指出检查什么、什么情形可能有问题即可。
- 按变更相关性加载主题；清单用于发现问题，不要求逐项输出，也不把未采用某种模式自动视为缺陷。
- 共享 prompt 唯一负责整体原则、工具边界、编排和最终输出；skill 只补充主题审查知识。

## 结论

- 本次核查的候选中，没有单一资产同时满足“完整 skill + 11 个主题宽覆盖 + 低耦合可移植”。
- 完整 skill 中，sanyuan 最紧凑、review-first 最清晰，但主题缺口最大；awesome 的语言与主题面最宽，是完整 skill 的覆盖底本，但测试、API、数据迁移、运维仍偏薄。
- gstack 的主题骨架最完整，但它是 review reference 集合而非 SKILL.md，且绑定 JSON/severity/auto-fix/编排与硬编码路径；只能借目录与问题，不能原样移植。
- wshobson 是完整 skill，但入口偏反馈与模板；Sentry 太短。二者可补观点，不足以做主题骨架。

## 候选与类型

| 资产                            | 类型                                     | 规模                                                                   | 许可                      | 固定版本  |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------- | --------- |
| sanyuan code-review-expert      | 完整 skill（入口 + 4 refs + agent.yaml） | 156 + 365 行                                                           | MIT © 2025 sanyuan0704    | `08b6572` |
| awesome code-review-skill       | 完整 skill（入口 + 35 refs + 2 assets）  | 232 + 24,000 行；24 语言/框架 + 11 跨领域                              | MIT © 2025 awesome-skills | `4850184` |
| gstack review references        | review reference 集合（非 SKILL.md）     | security/perf/API/data/state-machine + 主清单 + design + plan sections | MIT © 2026 Garry Tan      | `c580561` |
| wshobson code-review-excellence | 完整 skill（入口 + 2 refs）              | 266 + 179 + 86 行                                                      | MIT © 2024 Seth Hobson    | `0874a27` |
| Sentry code-review              | 完整 skill（短）                         | 102 行                                                                 | Apache-2.0                | `f57ada2` |

## 主题覆盖矩阵

`●` 表示有多组检查面、可作宽覆盖骨架；`◐` 表示部分覆盖；`○` 表示缺失。此处只评估检查面的覆盖；部分上游参考含大量深入示例，不适合全文搬入。`●` 不代表深度或正确性已达标。

| 主题      | sanyuan | awesome | gstack | wshobson | Sentry |
| --------- | ------- | ------- | ------ | -------- | ------ |
| 设计/架构 | ●       | ●       | ●      | ◐        | ◐      |
| 正确性    | ◐       | ●       | ●      | ◐        | ◐      |
| 安全      | ●       | ●       | ●      | ◐        | ◐      |
| 性能      | ◐       | ●       | ●      | ◐        | ◐      |
| 错误处理  | ●       | ●       | ◐      | ◐        | ◐      |
| 边界条件  | ●       | ●       | ◐      | ◐        | ◐      |
| 测试      | ○       | ◐       | ◐      | ◐        | ◐      |
| API       | ○       | ◐       | ●      | ○        | ○      |
| 数据/迁移 | ◐       | ◐       | ●      | ○        | ○      |
| UI        | ○       | ◐       | ●      | ○        | ○      |
| 运维      | ◐       | ◐       | ●      | ○        | ○      |

## 逐项证据

### sanyuan `08b6572`

- 实际覆盖：安全含 XSS/注入/SSRF/路径遍历、AuthN/AuthZ、JWT、秘密与 PII、供应链、CORS/头、运行时风险、密码学、竞态、数据完整性；质量含吞错/过宽 catch/异步错误、CPU/IO/缓存/内存、null/空集合/数值/字符串/Unicode 边界；另有 SOLID、代码坏味、删除与迭代计划。
- 缺口：测试仅“补测试/删测试”的附带动作，没有测试设计；API 仅提示查 contracts，无兼容/版本/错误契约；数据无 schema/migration/回滚/锁/回填；UI 无；运维无 CI/部署/可观测，仅有超时、限流、告警/监控提示。
- 事实错误：`solid-checklist.md` 的 LSP 写成“weaken preconditions or strengthen postconditions”为违规，方向反了。合法替换允许弱化前置、强化后置；违规是强化前置/弱化后置。不可原样复用。
- 风格冲突：OCP 要求 plugin/hook，DIP 要求抽象，长方法以 >30 行为坏味；这些是启发式，直接当规则会与“简单优先”冲突。
- 安全检查多为“待验证假设”，没有证据门槛或置信度；不能把条目自动变成 findings。
- 流程强绑定：P0–P3、APPROVE/REQUEST_CHANGES/COMMENT、结尾追问“如何修复”、`::code-comment` 指令；均不应复制。
- 可移植性：依赖 `git`/`rg` 与相对 `references/`，需保留目录；命令假设当前工作树。优点是短、上下文成本低、review-first 边界清楚，适合作为最小完整底本。

### awesome `4850184`

- 实际覆盖：架构指南（SOLID、耦合/内聚、分层、反模式）、通用质量（复用、参数膨胀、泄漏抽象、嵌套条件、字符串类型化、TOCTOU、冗余状态）、安全（SQLi/XSS/CSRF/SSRF/IDOR/命令注入/秘密/加密/依赖）、性能（Web Vitals、N+1、索引、复杂度、内存、缓存、分页、bundle、渲染）、错误处理（7 语言）、异步并发（7 语言）、逐语言常见 bug、测试清单、API 基础设计。
- 测试覆盖是清单级：行为而非实现、边界、错误路径、确定性、外部依赖；缺属性测试、变异测试、契约测试、测试数据/夹具策略。
- API 仅资源命名、方法、状态码、分页、限流、校验；缺版本策略、弃用/日落、向后兼容、错误响应 schema、文档漂移。
- 数据有 SQL/事务/索引/N+1/时区，缺迁移可逆性、数据丢失、锁时长、回填、多阶段部署。
- UI 偏框架/CSS/渲染，缺设计系统、可访问性、i18n、交互状态；运维有 CI 状态、日志/监控、依赖审计、限流，缺部署顺序、回滚、SLO/可观测性。
- 冲突：命名、注释和魔法数需区分语义缺陷与风格偏好，不能仅凭出现在清单中就报告；6 种标记与“3 个严重度层级”并存（L178 有澄清），消费方必须自行折叠；24k 行渐进披露在宿主不按需加载时会撑爆上下文。
- 可移植性：README 称支持 Cursor/Claude/Codex/OpenCode，但 `allowed-tools`、相对引用、`scripts/pr-analyzer.py` 均依赖宿主与目录布局；工具白名单只读，不等于所有宿主强制只读。
- 定位：完整 skill 中主题与语言面最宽，适合当覆盖底本，但需补齐上述缺口。

### gstack `c580561`（reference，不是 skill）

- 骨架价值：security 覆盖输入边界、认证/授权绕过、SQL 之外的注入、密码学误用、秘密、XSS 逃逸口、反序列化；performance 覆盖 N+1、索引、复杂度、bundle、渲染、分页、异步阻塞；API 覆盖破坏性变更、版本、错误一致性、限流/分页、文档漂移、兼容；data-migration 覆盖可逆、数据丢失、锁、回填、索引、多阶段安全；另有状态机与主清单的 SQL/竞态/LLM 信任/gate/CI 检查。
- 所选 specialist/reference 文件不是独立 skill；这不表示 gstack 仓库没有 skill 入口。specialist 文件自带 scope、逐行 JSON、CRITICAL/INFORMATIONAL、confidence、fingerprint、fix/test_stub；主清单依赖 `gstack-*` 可执行文件、`~/.claude/skills/gstack/bin`、ASK/AUTO-FIX 与 approval class。直接移植会把编排和输出协议一起带进来。
- 事实错误：data-migration 写“大表 `ALTER TABLE` 不加 `CONCURRENTLY`（PostgreSQL）”。PostgreSQL 没有通用的 `ALTER TABLE ... CONCURRENTLY`；合法的是 `CREATE INDEX CONCURRENTLY`，以及用 `NOT VALID` + `VALIDATE CONSTRAINT` 等减锁模式。不可照抄。
- 性能过度断言：把 `React.memo`/`useMemo`/`useCallback`、缺索引直接当必改项，未要求 workload、query plan 或基准；应降级为问题。
- 定位：最佳主题分类骨架，但每条都要重新验证，且只借标题/问题，不借 severity/JSON/auto-fix/路径。

### wshobson `0874a27`

- 266 行入口 + patterns/techniques。真审查内容含架构问题、Python/TS 语言模式、测试质量（行为而非内部状态）、安全基础、性能基础。
- 入口大量是心态、反馈话术、模板与 verdict；API 只在“Review Scope”声称，参考文件中没有系统 API 审查；无数据迁移、UI、运维。广度明显小于 awesome。
- 定位：反馈与测试质量补充，不是主题骨架。

### Sentry `f57ada2`

- 102 行，覆盖运行时错误、性能、向后兼容、ORM、安全、设计、测试，附 3 段代码示例；每项仅一两句，无 references。适合轻量清单，不适合宽覆盖底本。

## 冲突、缺陷与可移植性

- 严重度不可混用：sanyuan 用 P0–P3；awesome 用 3 层 + 3 个非阻断标记；gstack 用 CRITICAL/INFORMATIONAL + confidence。改编时删除来源自带的分级指令，继续由共享 prompt 定义输出，避免重复定级。
- 流程冲突：sanyuan 明确 review-only 后追问是否修；awesome 工具白名单只读但不保证宿主强制；gstack 有 auto-fix、ASK、approval、gate；wshobson 偏团队反馈。不能同时继承“先问再改”和“自动修”。
- 输出协议冲突：sanyuan 的 verdict + `::code-comment`，awesome 的 6 标记模板，gstack 的逐行 JSON，wshobson 的 Summary/Verdict 模板互不兼容；应只保留自有输出。
- 证据标准不同：sanyuan/awesome 多为提示式清单，gstack 有 confidence/fingerprint/gate。宽覆盖不等于可直接产出高置信 findings，需另加“证据/复现/影响”门槛。
- 路径与宿主：所有引用都是相对路径，安装必须保留目录树；gstack 还硬编码 `~/.claude` 与可执行文件；awesome 的 Python 分析脚本与 `allowed-tools` 依赖宿主。sanyuan 的 `agent.yaml` 自称 agent-agnostic，但命令与评论指令仍有环境假设。
- 许可：MIT/Apache-2.0 均为宽松许可，但再分发需保留版权与许可声明；本次未复制代码或参考全文。

## 建议（研究结论，非改编）

- 要“完整 skill 起点”：sanyuan 适合最小 review-first 底本；awesome 适合最宽语言/主题底本；wshobson 补反馈与测试质量；Sentry 只作轻量清单。
- 要“宽而浅的主题骨架”：以 gstack 的 security/performance/API/data-migration 分类为骨架，用 sanyuan 的安全/质量/边界清单与 awesome 的架构/正确性/语言清单补面；不要从任何单一来源直接生成规则。
- 不要复制任何来源的 severity/verdict/ask-user/auto-fix/JSON 输出协议；这些是产品决策，不是审查知识。
- 复用前先修正可验证错误：LSP 方向、PostgreSQL `ALTER TABLE ... CONCURRENTLY`、无 workload 的 memo/index 强制项；其余条目按假设处理。
- 每个主题保留多组检查面（宽），但只要求浅层问题与证据，不把清单条目自动升级为 finding。

## 来源（固定到 commit）

- sanyuan：[SKILL.md](https://github.com/sanyuan0704/sanyuan-skills/blob/08b6572ef108f22d4e8a3ecf9182a4bbef097744/skills/code-review-expert/SKILL.md)、[solid-checklist](https://github.com/sanyuan0704/sanyuan-skills/blob/08b6572ef108f22d4e8a3ecf9182a4bbef097744/skills/code-review-expert/references/solid-checklist.md)、[security-checklist](https://github.com/sanyuan0704/sanyuan-skills/blob/08b6572ef108f22d4e8a3ecf9182a4bbef097744/skills/code-review-expert/references/security-checklist.md)、[code-quality-checklist](https://github.com/sanyuan0704/sanyuan-skills/blob/08b6572ef108f22d4e8a3ecf9182a4bbef097744/skills/code-review-expert/references/code-quality-checklist.md)、[LICENSE](https://github.com/sanyuan0704/sanyuan-skills/blob/08b6572ef108f22d4e8a3ecf9182a4bbef097744/LICENSE)
- awesome：[SKILL.md](https://github.com/awesome-skills/code-review-skill/blob/4850184dfd7765ea7b3c5c4e9b6cf8e0815ee7cb/SKILL.md)、[architecture](https://github.com/awesome-skills/code-review-skill/blob/4850184dfd7765ea7b3c5c4e9b6cf8e0815ee7cb/reference/architecture-review-guide.md)、[security](https://github.com/awesome-skills/code-review-skill/blob/4850184dfd7765ea7b3c5c4e9b6cf8e0815ee7cb/reference/security-review-guide.md)、[performance](https://github.com/awesome-skills/code-review-skill/blob/4850184dfd7765ea7b3c5c4e9b6cf8e0815ee7cb/reference/performance-review-guide.md)、[review-checklist](https://github.com/awesome-skills/code-review-skill/blob/4850184dfd7765ea7b3c5c4e9b6cf8e0815ee7cb/assets/review-checklist.md)、[LICENSE](https://github.com/awesome-skills/code-review-skill/blob/4850184dfd7765ea7b3c5c4e9b6cf8e0815ee7cb/LICENSE)
- gstack：[commit c580561](https://github.com/garrytan/gstack/tree/c580561e8a5ac08e6cbdd52c7a0ce521ab6310a5)；wshobson/Sentry 分别固定于 `0874a27`、`f57ada2`（primary 核查，本地缓存 `/tmp/topic-skills/expanded/wshobson`、`/tmp/review-skills-expanded-sources`）。

## 与官方 review 命令对照

本节重新检验引入 skill 的增量价值。核查的是公开 prompt/官方文档，不是同一 PR 上的质量基准。

- **OpenCode v2.0.32**：实际内置模板要求阅读变更文件完整上下文，关注逻辑/边界/竞态/安全/错误处理、结构、明显性能问题与行为变化；要求真实触发场景、先调查后定性、避免风格教条与奉承。已经提供很强的通用审查基础，没有必要用更长的 skill 重复这些原则。[固定模板](https://github.com/anomalyco/opencode/blob/843a6c514e606b436a7fe713422ace0a93ad3d61/packages/core/src/plugin/command/review.txt)
- **Codex**：官方文档确认 `/review` 审查工作树；公开 rubric 强调新引入、独立可修复、符合项目实际严谨程度、无需猜测意图的缺陷，影响其他代码必须指出实际受影响位置；无有效发现可返回空，评论简短。它主要约束 finding 的可信度与表达，并非领域检查百科。自带 JSON schema、优先级和规则文件权限约定不能直接覆盖本产品协议。[官方命令文档](https://developers.openai.com/codex/cli/slash-commands)；[固定 rubric](https://github.com/openai/codex/blob/464add49587a7cb6032d5ab04faa8a1585947853/codex-rs/prompts/templates/review/rubric.md)
- **Claude Code 内置命令**：当前官方文档把 `/review` 记为 `/code-review` 的别名，检查 diff 的 correctness bugs，可指定 PR、使用 `--fix`，`ultra` 为云端多 agent review。文档证明入口与行为，不能据此声称已读其完整内置 prompt。[官方命令参考](https://code.claude.com/docs/en/commands)
- **Claude Code 官方 code-review 插件（与内置命令分开）**：公开命令包含并行规则/bug 审查，再对发现逐项起 agent 验证；强调低误报，但明确排除依赖特定输入或状态的问题。此排除会漏掉我们关心的授权、并发和错误路径问题；逐项覆核也与已决定的独立审查后直接汇总不符。[固定插件命令](https://github.com/anthropics/claude-code/blob/a6e289a2e772a17b3614a9ef43303003de5cd887/plugins/code-review/commands/code-review.md)
- **Claude Code 官方 PR Review Toolkit**：按 comments/tests/errors/types/code/simplify 分工，提供的是专门审查视角；其编排、修复、输出和表扬模板不适合搬入。测试、错误和类型不变量的知识可作为 topic 内容来源。[固定命令](https://github.com/anthropics/claude-code/blob/a6e289a2e772a17b3614a9ef43303003de5cd887/plugins/pr-review-toolkit/commands/review-pr.md)

### 修正后的选择原则

共享 prompt 负责通用审查方法与证据标准，优先借鉴 OpenCode/Codex 的简洁做法，保留本产品对需求必要性、实现轻便性及简洁结论的要求。主题 skill 只有补充具体领域的遗漏检查面才值得加载；不能以篇幅、检查条目数或上游身份证明价值。每个主题仍覆盖广泛方向，但不重复通用审查流程。现有四项方案不应因已经实现就直接合并；本次未改运行时，未实测哪个 prompt 的 review 质量更好。

## 最终决策

用户选择取消主题 skill，改为一个通用 `code-review` skill，综合 OpenCode 与 Codex 的方法。以上候选比较保留为历史研究，非当前安装清单。通用 skill 负责审查方法与发现标准，共享 prompt 负责范围、权限、编排及最终输出；原四项不再交付。保留来源 credit、固定 revision、MIT/Apache-2.0 许可及改编说明。

### Vercel / Sentry 方法补充

按用户追加要求阅读两份完整 skill，仅补充原则，无代码示例或新编排。

- [Vercel open-agents](https://github.com/vercel-labs/open-agents/blob/cf865e94de7729751c747171785b6ce57e7b178c/.agents/skills/code-review/SKILL.md)：大部分与 OpenCode 模板重合；增量是沿输入、存储、网络、渲染等真实信任边界追踪，检查授权/校验在实际执行边界而非仅在 UI 或调用方，并以攻击者可控输入、缺失控制、具体影响说明安全发现。不采用无法核实可达性就假定外部可达的规则。MIT © 2026 Vercel, Inc.
- [Sentry](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/code-review/SKILL.md)：补充组件交互/副作用、测试对需求与交互的对应关系、重要 schema/API/框架依赖选择的长期影响。按风险选择测试层次，不强制每个 PR 都有全部层次；不搬入资深工程师升级流程、具体代码例子或独立批准规则。Apache-2.0。

四个来源均在最终 skill 中 credit、固定版本并保留上游许可。没有因新增来源增加工具权限、额外审查轮次或最终输出字段。
