# 扩展评审技能研究：专项与综合

> 后续实现：本次比较之后，Runner 已接入 `test-quality`、`error-handling`、
> `github-actions-security` 与 `security-misuse-resistance` 四项改编，
> 随包携带 credits、LICENSE 和 NOTICE。边界见 [当前设计](../design.md)。
> 已用 OpenCode 2.0.32 与本地合成模型端点验证四项的发现和原生加载；
> 尚未做真实 PR 审查质量对比。以下保留初次研究阶段的候选取舍。

> 研究日期 2026-10-20。范围：在既有 sharp-edges、Supabase、Web Interface Guidelines 三项之外，比较可补充“综合评审 + 正确性/测试/性能/错误处理”的候选。只判断方法与适配，不按 star、厂商或“官方”身份评分。未安装技能、未改运行时。外部内容固定在下列 commit。此前的三项只作对照，不重复发现过程。

## 结论

1. **综合类可供选择，但暂不建议默认增加一层**：Sentry `code-review` 的短清单可作为只读综合检查表的起点，但与现有 prompt 重合较多。`differential-review` 不整体采用，只借它的风险分级、blast radius、历史回归和测试缺口问题；`code-review-excellence` 不采用。
2. **优先试用四个专项**：`test-quality`、`error-handling`、`github-actions-security`、`security-misuse-resistance`（许可可接受时）。`postgres-review` 与 `web-accessibility` 同为场景候选，按实际 PR 涉及的技术与行为选用，没有默认全加载的必要。
3. **不要整体采用 Sentry `security-review`**：它明确不检查“需要先登录才能到达”的路径，会漏掉认证后的 IDOR、越权和租户隔离；其参考内容还带有 OWASP CC-BY-SA 义务。只可借“先追数据流、确认 attacker-controlled、查框架缓解”的方法。
4. **许可不是形式问题**：Trail of Bits 为 CC-BY-SA-4.0；Sentry 仓库为 Apache-2.0，但部分参考内容来自 OWASP CC-BY-SA-4.0；`pr-review-toolkit` 的 README 写 MIT，根目录和插件 `LICENSE` 实际是 Apache-2.0，本文记录 LICENSE 的 Apache-2.0 声明，vendoring 前需解决该不一致。
5. **运行时编排可改，不是自动淘汰理由**：`differential-review`、GHA、toolkit 都带 Task/Bash/写文件/固定报告等限制，但其中一部分方法仍可静态化。真正不可接受的是新的输出契约、第二套 severity、执行仓库代码或写文件。

## 判断标准

- 共享 prompt 仍是唯一输出/决定来源：精确 revision、finding 门槛、finding 证据要求、decision、JSON 包装及其中的 Markdown、`TLDR:` 与最多五条。
- 专项只增加领域问题、失败模式和证据路径；不新增工具、执行、网络、写入、发布，也不要求每条规则都产出 finding。
- 适用性按行为面判断，不按扩展名或语言分发。
- 方法必须能落到静态证据；需要运行测试、`EXPLAIN`、浏览器、复现利用链的部分只能作为证据限制或待验证项。
- 不增加新的运行时安全策略；拒绝把“所有空 catch 都 critical”“所有静默错误都 critical”这类绝对化规则带入产品。

## 候选比较

| 候选                                                 | 可用的方法                                                                                                  | 阻塞/缺陷                                                                                                                              | 结论                                       | 许可                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------- |
| Trail of Bits `differential-review`                  | 风险分级、baseline 对照、对删除的安全代码做 `git blame`、blast radius、测试覆盖缺口、显式 coverage limits   | 要求 `Write`/`Bash`、subagent、固定报告文件、独立 severity；示例偏智能合约；baseline 需 checkout                                       | 只作方法来源，不作技能                     | CC-BY-SA-4.0                  |
| wshobson `code-review-excellence`                    | 测试应验证行为而非内部状态；少量架构/安全问题                                                               | 大量语气、praise、sandwich、固定模板和 emoji；2–3 分钟阶段、超过 400 行建议拆分等流程常数；输出/严重度与共享 prompt 冲突；正确性证据浅 | 拒绝；测试问题由更专门的 test-quality 覆盖 | MIT                           |
| Sentry `code-review`                                 | 紧凑通用清单：runtime errors、side effects、backward compatibility、test coverage、design、long-term risk   | 非常浅；Sentry/Django/React 语境；tone/approval 文案；没有 finding 证据标准                                                            | 可作唯一综合方法，删掉反馈/决定/输出部分   | Apache-2.0                    |
| Sentry `gha-security-review`                         | 外部攻击者威胁模型；pwn request、表达式注入、凭证升级、权限/secret、供应链；给 PoC 要素；先排除安全写法     | `Bash`/`Task` 和固定报告/severity；“safe patterns”表是范围化启发式，不是保证，见下文                                                   | 高价值专项，需收窄和纠偏                   | Apache-2.0                    |
| Sentry `security-review`                             | 先追 source→sink、确认 attacker-controlled、查框架缓解；confidence 分层；引用了具体漏洞类别                 | 第 46 行排除“需要先认证”的路径，直接漏掉认证后越权；OWASP 参考为 CC-BY-SA；输出/severity 是第二套契约                                  | 不整体采用                                 | Apache-2.0 + CC-BY-SA 参考    |
| `pr-review-toolkit`（test-quality / error-handling） | 行为契约覆盖、具体回归、负例、并发/异步、既有集成覆盖；错误传播、fallback 是否掩盖问题、cleanup、retry 耗尽 | 1–10 评分和固定输出；静默错误一律 critical、空 catch 一律禁止；`logError`/Sentry/Statsig/`errorIds.ts` 是项目专属                      | 采用两个 lens，全部去项目化                | Apache-2.0（README 误写 MIT） |
| Trail of Bits `sharp-edges`                          | 误用友好性/不安全默认值、类型混淆、配置悬崖、静默安全失败                                                   | 需把“写代码验证”改为静态追踪；启发式规则和自带 severity 不能替代共享门槛                                                               | 条件采用（既有结论）                       | CC-BY-SA-4.0                  |
| Supabase Postgres + Vercel WIG（既有）               | Postgres 约束/索引/RLS/锁/池；Web 可访问性/焦点/表单/语义                                                   | 面向编写代码的触发描述、Supabase 专属规则、WIG 的 WebFetch/输出格式与品牌偏好                                                          | 各收窄为一个专项                           | MIT / MIT                     |

## 关键证据与规则取舍

### `differential-review`：方法好，产品形态不合

- 它明确把风险、证据、自适应深度、诚实 coverage 和“总是生成报告文件”列为核心原则（[SKILL.md L13–L17](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L13-L17)），并要求 `Read Write Grep Glob Bash`（[L4](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md#L4)）。
- 有价值的静态问题：baseline 的 invariant/trust boundary、删除代码的 `git blame`、调用者计数、修改代码是否有测试（[methodology L9–L40](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/methodology.md#L9-L40)、[L96](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/methodology.md#L96)）。
- 不可用的部分：`git checkout` baseline（[methodology L13](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/methodology.md#L13)）、强制报告结构和独立 severity（[reporting L9](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/reporting.md#L9)）。这些不能进入技能；只把前三类问题并入综合检查表。

### `code-review-excellence`：软技能多，可复用规则少

- 测试部分仍有一条扎实规则：测试应描述行为而不是实现状态（[review-patterns L120–L145](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/developer-essentials/skills/code-review-excellence/references/review-patterns.md#L120-L145)）。
- 但主体是反馈语气、praise、固定 severity 标签和模板（[SKILL L41–L163](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/developer-essentials/skills/code-review-excellence/SKILL.md#L41-L163)），还给出独立 verdict/模板（[L234](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/developer-essentials/skills/code-review-excellence/SKILL.md#L234)）。这些会直接覆盖共享 prompt，本轮没有证据证明它会提高 bug 发现率。结论：不采用。

### Sentry `code-review`：可作为精简综合检查表的起点

- 清单本身覆盖 runtime errors、performance、side effects、backward compatibility、test coverage、long-term impact（[SKILL L12–L47](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/code-review/SKILL.md#L12-L47)）。这些与共享 prompt 有重叠，但适合作为遗漏检查。
- 它没有证据门槛，且以“只差小问题就 approve”作为语气建议（[L49–L59](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/code-review/SKILL.md#L49-L59)）。必须删除 approval/tone 文案，只保留问题清单，并让共享 prompt 决定 finding 与 decision。
- 若需要一份短综合清单，可以从它开始；若需要更深的安全回归方法，则参考 `differential-review`。两者都应删去与共享 prompt 重复的编排和输出规定，不能仅凭内容比较断言哪种审查效果更好。

### Sentry `gha-security-review`：高价值，但“安全写法”表必须降级为假设

- 真正有价值的是攻击路径分解：外部攻击者、entry/payload/execution/impact/PoC，以及按 trigger 选择 pwn request、表达式注入、凭证、供应链参考（[SKILL L34–L42](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/SKILL.md#L34-L42)、[L66–L133](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/SKILL.md#L66-L133)）。参考文件对 pwn request、表达式注入、权限/secret、供应链有具体证据（[pwn-request](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/references/pwn-request.md)、[expression-injection](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/references/expression-injection.md)、[permissions-and-secrets](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/references/permissions-and-secrets.md)、[supply-chain](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/references/supply-chain.md)）。
- **具体缺陷**：“safe patterns”表把“`pull_request_target` 未 checkout 就不执行攻击者代码”“`with`/`env` 安全”“`pull_request` 只读”“first-party tag 可忽略”写成近似保证（[SKILL L135–L153](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/SKILL.md#L135-L153)）。实际仍需追踪：下游 action/composite action 是否消费了不可信值、reusable workflow 的权限、`env`/`with` 是否随后进入 shell、仓库/组织默认 token 权限、self-hosted runner、first-party action 是否被入侵。
- 它的 `workflow_dispatch` 排除是“外部攻击者”模型下的范围选择，不是“内部/被盗 token 无风险”的保证。采纳时保留“先追踪完整攻击链、证据不足则说明限制而不硬报”的纪律，删除固定 severity、报告模板和 `Task`/`Bash`。

### Sentry `security-review`：两个硬伤，不能整体采用

- 第 46 行把“需要先前认证才能到达的代码路径”列入不报，只建议记录 auth 要求（[SKILL L40–L46](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/security-review/SKILL.md#L40-L46)）。这会系统性漏掉 authenticated IDOR、角色/租户隔离、对象级授权和权限提升。对当前产品这是 fail-open，不是可接受的取舍。
- 第 9 行说明参考材料基于 OWASP Cheat Sheet Series（CC BY-SA 4.0）（[L9](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/security-review/SKILL.md#L9)），而仓库 LICENSE 是 Apache-2.0（[LICENSE](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/LICENSE)）。可借“先追数据流、确认 attacker-controlled、查框架缓解”（[L90–L185](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/security-review/SKILL.md#L90-L185)），但不应复制参考文本。
- 另有独立的 severity 与输出模板（[L175](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/security-review/SKILL.md#L175)、[L243](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/security-review/SKILL.md#L243)），同样不能进入产品。

### `pr-review-toolkit`：两个 lens 可用，但要彻底去项目化

- `pr-test-analyzer` 要求评行为/契约而非实现、能抓真实回归、覆盖负例和并发/异步，并考虑既有集成测试（[L19–L49](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/pr-test-analyzer.md#L19-L49)）。这些比“有没有测试”更具体。
- `silent-failure-hunter` 的可用问题是：错误是否应向上传播、fallback 是否掩盖问题、是否影响 cleanup、retry 耗尽后是否告知（[L20–L97](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/silent-failure-hunter.md#L20-L97)）。
- 必须删除：1–10 评分、固定输出、positive observations；“所有静默错误 critical”“空 catch 绝对禁止”“每个错误都必须给用户可操作反馈”（[L10–L16](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/silent-failure-hunter.md#L10-L16)）；以及 `logError`/Sentry/Statsig/`errorIds.ts` 等项目专属规则（[L121–L128](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/silent-failure-hunter.md#L121-L128)）。
- 它们是 agent Markdown，不是 `SKILL.md`；方法可移植，但不能直接当作技能 vendoring。
- 许可冲突：README 写 MIT（[L303–L305](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/README.md#L303-L305)），实际根 [LICENSE](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/LICENSE) 和 [插件 LICENSE](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/LICENSE) 都是 Apache-2.0。记录许可证文件声明为 Apache-2.0，同时保留该冲突；本轮不复制或分发其技能文本。

### 另外两个可拆分的专题

- **类型与业务约束**：[type-design-analyzer](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/type-design-analyzer.md) 检查非法状态、字段关系、状态转移和修改入口。适用于状态机、领域类型或 API 合同变更；保留这些问题，删除 1–10 分评级别、固定报告以及“贫血模型就是反模式”的面向对象偏好，避免要求额外封装或重复校验。
- **注释与实现一致性**：[comment-analyzer](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/comment-analyzer.md) 对照参数、返回值、边界条件、示例和复杂度声明。适用于对外文档、注释承诺变化；保留事实核对，删除“必须给每条注释提改进”的倾向及单独输出模板。

二者也是 agent 定义，可整理成独立的主题 skill；与上述 toolkit 相同，许可证声明不一致需在复制前处理。它们不是必须新增的审查阶段。

### 既有三项

- `sharp-edges` 的误用友好性/category 仍是最有区分度的安全 lens；保留条件不变：把写代码验证改为静态追踪，且不接受其自带 severity。源：[SKILL](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md)、[LICENSE](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/LICENSE)。
- Supabase 是本轮具体、可用的 Postgres 静态规则来源；WIG 仍是 a11y/交互规则来源；两者都需要面向编写代码的触发描述 改写、去除输出格式，并限定行为面。源：[Supabase SKILL](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md)、[Supabase LICENSE](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/LICENSE)、[WIG command.md](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md#L12-L167)、[WIG LICENSE](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/LICENSE)。

## 与共享 prompt 的重叠

共享 prompt 已拥有：精确 revision/diff、调用者与历史、challenge premise、correctness/security/performance/tests、具体后果、confidence、decision、最多五条、`TLDR:` 输出。新增技能只能补下表右列。

| 技能                       | 共享 prompt 已覆盖            | 唯一增量                                                                           |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| comprehensive-review       | 通用检查、设计/安全/性能/测试 | 一张短遗漏清单；风险分级、blast radius、删除代码历史、测试缺口                     |
| test-quality               | “看测试”                      | 行为契约、具体回归、负例、并发/异步、既有集成覆盖、检查 mock 断言是否真正约束行为  |
| error-handling             | reliability/security          | 传播 vs 吞掉、fallback 是否掩盖、cleanup、retry 耗尽、fallback 到 mock 的生产风险  |
| github-actions-security    | 一般 security                 | workflow trigger/checkout/expression/permissions/secrets/action 供应链的具体攻击链 |
| security-misuse-resistance | 一般 security                 | 让不安全用法成为最省力路径的 API/配置/默认值/类型设计                              |
| postgres-review            | 一般 correctness/performance  | 约束、索引选择性、RLS、锁顺序、连接池、迁移的静态判断                              |
| web-accessibility          | UI 变更的一般检查             | 语义/焦点/键盘/表单错误/ARIA/动效/触控目标                                         |

## 推荐首发

**优先试用四个专项，另保留数据库、无障碍和综合类候选**。以下是候选的适配方向，尚未实现；不追求覆盖所有语言，不建立扩展名 dispatcher。

| 技能                                 | 触发（行为面）                                                                   | 保留                                                                                                                | 删除/限制                                                                             | 许可                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `comprehensive-review`（可选，唯一） | 需要通用遗漏检查且专项都不适用时                                                 | Sentry 的 runtime/side-effect/backward-compat/test/design 清单；differential 的风险、调用者、删除代码历史、测试缺口 | feedback/tone/approval、固定 verdict、报告文件、独立 severity；不执行代码             | Sentry 为 Apache-2.0；若改编 differential 文本还需处理 CC-BY-SA-4.0 |
| `test-quality`                       | diff 新增/修改测试，或新增难测分支/并发/错误路径                                 | 行为契约、具体回归、负例、并发/异步、既有集成覆盖                                                                   | 1–10 评分、固定输出、positive observations；不要求覆盖所有行                          | Apache-2.0                                                          |
| `error-handling`                     | diff 涉及 try/catch、fallback、retry、超时、cleanup、错误映射                    | 传播/吞掉、fallback 正当性、cleanup、retry 耗尽、用户可见性是否恰当                                                 | “所有静默错误 critical”、空 catch 绝对禁止、项目专属日志/errorIds、固定 severity      | Apache-2.0                                                          |
| `github-actions-security`            | diff 触及 `.github/workflows/`、`action.yml`、本地 composite action、CI 配置     | 外部攻击者链、pwn request、表达式注入、权限/secret、第三方 action 供应链、逐条追踪下游                              | `Task`/`Bash`、报告模板、固定 severity；safe-pattern 表只作待验证假设                 | Apache-2.0                                                          |
| `security-misuse-resistance`         | authn/authz、session/token、secret、crypto、安全默认值、让调用者选安全策略的 API | 误用友好性、配置悬崖、类型混淆、静默安全失败                                                                        | 写代码验证、subagent/report、自带 severity；规则只作 hypothesis                       | CC-BY-SA-4.0，需接受义务                                            |
| `postgres-review`                    | Postgres schema/migration、约束、索引、查询、RLS/grant、事务/锁、连接池          | 约束/索引/RLS/锁顺序/池化/迁移的静态规则                                                                            | 面向编写代码的触发描述、Supabase 专属规则泛化、live `EXPLAIN`/统计视图、固定 severity | MIT                                                                 |

其他场景与限制：

- `web-accessibility`：UI、表单、键盘和焦点行为变更时选用 WIG 子集，与 Postgres 同为按领域使用的候选，不因项目当前页面框架而排除。
- Sentry `security-review`：与 general security 重叠且有两个硬伤；若将来需要，只重写为“认证后对象级授权必须检查”的独立 lens，并单独处理 OWASP 许可。
- `differential-review`、`code-review-excellence`：不作为技能；前者只贡献方法，后者不采用。
- 通用性能：本轮没有找到比 Supabase 数据库性能更值得首发的通用来源；框架/React 性能专项暂缓，避免用语言或框架猜适用性。

## 限制

- 未运行任何技能，也未用真实 PR 做质量/成本基准；适配结论来自静态内容和当前 `apps/runner/src/review-prompt.ts` 契约。
- 只完整阅读了各候选的 `SKILL.md` 和代表性参考，未逐文件审阅所有语言/框架参考。
- `pr-review-toolkit` 是 agent 定义而非 SKILL；其 rating/输出/项目规则不可直接移植。
- 许可观察不是法律意见。特别是 Sentry 的 Apache-2.0 仓库与 OWASP CC-BY-SA 参考、toolkit 的 README/LICENSE 冲突，vendoring 前必须单独确认。
- 运行时编排（subagent、Task、Bash、报告文件）可在实现层改造，但本文没有验证改造后的行为；“可改造”不等于“已适配”。

## 固定来源

- Trail of Bits：commit [`5c99c03`](https://github.com/trailofbits/skills/commit/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0)，[differential-review](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/differential-review/skills/differential-review/SKILL.md)，[sharp-edges](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md)，[LICENSE](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/LICENSE)。
- wshobson：commit [`0874a27`](https://github.com/wshobson/agents/commit/0874a27b17a22e2b7c2e2bcd725768e0803cad06)，[code-review-excellence](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/plugins/developer-essentials/skills/code-review-excellence/SKILL.md)，[LICENSE](https://github.com/wshobson/agents/blob/0874a27b17a22e2b7c2e2bcd725768e0803cad06/LICENSE)。
- Sentry：commit [`f57ada2`](https://github.com/getsentry/skills/commit/f57ada2d0b640406ea7e25b11d636c530e77c58b)，[code-review](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/code-review/SKILL.md)，[gha-security-review](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/SKILL.md)，[security-review](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/security-review/SKILL.md)，[LICENSE](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/LICENSE)。
- `pr-review-toolkit`：commit [`a0b04d9`](https://github.com/anthropics/claude-plugins-official/commit/a0b04d9ddccaabe1976645f68b0eda50f74e7022)，[pr-test-analyzer](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/pr-test-analyzer.md)，[silent-failure-hunter](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/silent-failure-hunter.md)，[README](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/README.md)，[LICENSE](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/LICENSE)。
- Supabase：commit [`c9be0e9`](https://github.com/supabase/agent-skills/commit/c9be0e931b7930f7d02126d04774d904c381e7d7)，[SKILL](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices/SKILL.md)，[LICENSE](https://github.com/supabase/agent-skills/blob/c9be0e931b7930f7d02126d04774d904c381e7d7/LICENSE)。
- Vercel WIG：commit [`434b7f9`](https://github.com/vercel-labs/web-interface-guidelines/commit/434b7f91364665f2f733b310ec54809bf8f37937)，[command.md](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md)，[LICENSE](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/LICENSE)。
