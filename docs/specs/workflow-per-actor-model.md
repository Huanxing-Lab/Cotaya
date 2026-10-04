# 规格 workflow-per-actor-model：dynamic workflow 的 per-actor 模型声明

| 项       | 值                                              |
| -------- | ----------------------------------------------- |
| 状态     | 已与用户对齐，规则先于实现（本文即规格）         |
| 分支     | `feature/workflow-per-actor-model`               |
| 日期     | 2026-10-03                                       |
| 行号基准 | 本规格撰写时的工作区（见各 `path:line` 引用）     |

---

## 1. 背景与目标

dynamic workflow 引擎（`apps/zcode-cli/packages/dynamic-workflow` 等）目前模型选择只有 run 级单值：`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model` 经 core 包 `resolveModelReference` 解析（`apps/zcode-cli/packages/core/src/tool/handlers/model-reference.ts:57`），随 journal 的 `run-launched` 事件落库；每个 actor 会话创建时由 bootstrap 包的 `workflowActorModelPolicy` 纯函数决策（`apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-model.ts:106`）：run 选择 > resume pin（journal `dwf_actor.resolved_model`）> 父会话当前模型。一个 run 里所有子代理只能同吃一个模型。本特性给 `agent()` 的 persona 对象新增 `model?: string` 声明：**一个工作流的不同 actor 可以跑不同 provider 的不同模型**，声明在场时压过 run 级选择与 resume pin；解析失败大声失败，绝不静默回落。声明（作者写的）与事实（宿主跑的）分字段落库，互不吞并。

## 2. 产品规则

### 2.1 脚本 API

`agent(name?, persona?)` 的 persona 对象新增可选成员：

```ts
declare interface AgentPersona {
  /** System prompt describing the actor's role. */
  system?: string;
  /** 模型声明，语法同 subagent_model：providerId/modelId[$reasoningLevel]。 */
  model?: string;
}
```

- `model` 是**该 actor 一个人的**声明：只决定这一个 actor 的会话模型，主代理与其他 actor 一概不受影响（与 `subagent_model` 的"主代理不受影响"同姿态）。
- persona 在 `agent()` 调用时冻结（现状不变，`apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts:416` 的 `createActor` 规范化后冻结）；`model` 随 persona 一起冻结。
- persona 是运行期值（`agent()` 的实参可以是动态表达式，`engine.ts:413` 附近已有裁决），因此 `model` 的解析发生在 **actor 会话创建时**，不在提交/确认窗阶段——这与 `subagent_model` 在 `resolveInput`（确认窗之前）解析不同，是位置差异，不是规则差异。确认窗与 `run-launched` 事件仍只描述 run 级选择，actor 级声明不进确认窗。

### 2.2 模型引用语法

与 `subagent_model` **完全一致**（同一函数 `resolveModelReference`，三档匹配、大小写不敏感）：

- 全称 `providerId/modelId`，可带档位后缀 `providerId/modelId$reasoningLevel`；**跨 provider 全称是主推形态**。
- 裸 `modelId` 在**恰好唯一 provider 命中**时可用；挂在多个 provider 下且无当前会话那一条时即 `ambiguous` 失败——歧义即失败，不猜。
- `$level` 在场必须是该模型的合法档位（否则 `reasoning_level_unknown`）；缺席取注册表默认档。

### 2.3 优先级

新最高档插入后，单个 actor 会话的模型决策完整优先级表：

| persona.model 声明 | run 级 subagentModel | resume pin | 解析结果 |
| --- | --- | --- | --- |
| 有 | 任意 | **任意（连解析都不做）** | 覆盖成声明解析出的选择（整条，含 reasoning 档位） |
| 无 | 有 | 任意（含畸形，不解析） | 覆盖成 run 选择（现状行，不变） |
| 无 | 无 | 无 | 不覆盖（继承父会话当前模型，child runtime 基线） |
| 无 | 无 | = 父会话当前模型 | 不覆盖（钉的就是现在的主模型） |
| 无 | 无 | ≠ 父会话当前模型 | 覆盖成 pin 解析出的选择 |
| 无 | 无 | 畸形（缺 provider 段） | `WorkflowActorPinnedModelError`（现状，不变） |

要点：

1. **声明在场时 pin 连解析都不做**——与"run 选择在场时 pin 不解析"（`workflow-actor-model.ts:110-113`）同款处理。pin 守的是隐式缺省的静默漂移；显式声明在场，就没有缺省可守。
2. 声明同样压过 run 选择：该 actor 不吃 `subagent_model`，`subagent_model` 只落在**未声明模型的子代理**上（见 2.7 文案收窄）。
3. 决策点唯一：bootstrap `create-app.ts` 的 `createActorRuntime` 闭包（`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:591-626`）。声明是字符串，先经 `resolveModelReference` 解析成 `ModelSelection`，再交给 `workflowActorModelPolicy`（纯函数维持"收已解析的选择、不引 Registry"的接缝，`workflow-actor-model.ts:96`）。

### 2.4 失败语义

解析失败（`not_found` / `ambiguous` / `disabled` / `reasoning_level_unknown`，判别联合见 `model-reference.ts:24-31`）必须**大声失败**：

- 抛错点在该 actor 会话创建（`createActorRuntime` 闭包）→ 该 ask 失败 → 整个 run 失败。
- 失败信息必须携带 `resolveModelReference` 的 `message`（`not_found` 自带可用模型候选清单，`model-reference.ts:171-189`）与 actor 定位（名字 / siteId），排查的人不需要从一条通用错误里猜是哪个 actor 的哪个声明炸了。
- **绝不静默回落**：不落 run 选择、不落 pin、不落父会话模型。与 pin 的 v1 策略（"宁可失败，绝不静默换模型"，`workflow-actor-model.ts:93-99`）同一原则——声明指着一个宿主给不出的模型时，换一个模型继续跑恰恰是这次要防的事。

### 2.5 声明与事实分离

两个字段，两个作者，互不吞并：

| 字段 | 作者 | 语义 | 生命周期 |
| --- | --- | --- | --- |
| persona 的 `model`（journal `dwf_actor.persona_json` 列内，`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal.ts:263,279`） | **脚本作者** | 声明：作者要这个 actor 跑什么 | 随 persona 在 `agent()` 时冻结、随 `persona_json` 落库、resume 时脚本重放自动重建 |
| `dwf_actor.resolved_model`（`ActorRecord.resolvedModel`，`apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts:775`） | **宿主** | 事实：这个 actor 实际跑在哪个模型上 | 权威是造出来的 child runtime 自己（`runtime.getSessionModelSelection()`），由 `journalActorResolvedModel` 落库（`apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch.ts:504-527`），兼作**下一次 resume 的 pin** |

- 声明不吞并事实：即使声明解析成功，落库的 `resolved_model` 仍以 runtime 自报为准（现状规则，`workflow-actor-model.ts:101-104` 的"策略不产出最终事实"裁决不变）。
- 事实不吞并声明：`persona_json` 原样记作者的字符串（含档位），不回写 canonical 形、不按落库结果改写。
- resume 时声明重放重建，声明在场 ⇒ pin 不参与（2.3 表第一行）；声明所指模型在两次运行之间从宿主消失 ⇒ 会话创建大声失败（2.4）。

### 2.6 amend-resume 缓存语义

`matchImportedActor` 按**有效名**查表、`canonicalJson(spec) !== canonicalJson(candidate.persona)` 即弃候选（`apps/zcode-cli/packages/dynamic-workflow/src/engine/imported-cache.ts:212-223`）。`model` 并入 persona 后，这条既有比对**零代码自动生效**：

- 修订时改某 actor 的 `model` ⇒ 该 actor 的 persona 规范化值变 ⇒ 导入候选被弃 ⇒ 该 actor **全新重跑**；
- 其余 actor 的 persona 未变 ⇒ 缓存照常导入，已完成工作不重跑。

### 2.7 run 级文案收窄

`subagent_model` 的语义从"子代理跑在 X"收窄为"**未声明模型的子代理**跑在 X"：

- 工具结果文案：`describeWorkflowSubagentModel`（`model-reference.ts:113-116`，现文 "Subagents run on {canonical}…"）收窄为"未声明模型的子代理"口径；
- skill 文档：`apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md` 的 `subagent_model` 描述（约 960-963、1426-1428 行）同步收窄；内嵌 facade-dts 副本（`SKILL.md:975` 起，含 `AgentPersona`，988-991 行）必须与 `FACADE_DTS` 常量同步——单一事实源在 `apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts`，副本不手抄漂移；
- GUI i18n：`packages/ui/src/i18n/locales/en-US.ts:5579-5582`（label / tooltip）与 `:5824`（`chat.permission.workflow.subagentModel`，"Subagents run on {model}"）、`zh-CN.ts:5337-5341` 与 `:5572`（"子代理运行在 {model}"）同步收窄为"未声明模型的子代理"口径。

## 3. 状态所有者与事件顺序

四个写入者、一条决策链。箭头是事件顺序，括号是落点：

```
脚本作者                用户（run 发起人）              宿主（bootstrap）
    |                        |                             |
    | agent(name, {system,   |                             |
    |   model: "p/m$high"})  |                             |
    v                        v                             v
[1] persona 冻结          [2] CreateWorkflow/AmendWorkflow
    siteId,name,persona       的 subagent_model
    |                        |
    | engine.createActor     | resolveInput（确认窗之前）
    | -> journal             |   -> resolveModelReference
    v                        |   -> canonical 形
 dwf_actor.persona_json <────┘   |
 (声明落库，作者=脚本)             |
    |                            |
    |                            v
    |                         [3] 确认窗 Allow -> run 启动
    |                            -> journal `run-launched` 事件
    |                               (run 级选择落库，作者=用户)
    |                            |
    |                            v
    +-------------------------> [4] actor 会话创建（唯一决策点：
    |                             create-app 的 createActorRuntime 闭包）
    |                             persona.model 在场?
    |                               是 -> resolveModelReference(声明, catalog entries)
    |                                      ok   -> selection（整条，含档位）
    |                                      失败 -> 抛错 -> ask 失败 -> run 失败（不回落）
    |                               否 -> runSubagentModel 在场? -> 用 run 选择
    |                               否 -> pinnedModel（journal dwf_actor.resolved_model）
    |                                      解析与比对见 2.3 表
    |                             -> workflowActorModelPolicy
    |                             -> configOverrides.modelSelection
    |                             -> createScriptWorkflowAgentRuntime
    v                                      |
 [5] AgentRuntime 建成，自报事实            |
    runtime.getSessionModelSelection()     |
    -> journalActorResolvedModel           |
    v                                      |
 dwf_actor.resolved_model                  |
 (事实落库，作者=宿主；兼作下一次 resume 的 pin)
```

所有权一句话：**作者管 `persona_json` 里的声明，用户管 `run-launched` 里的 run 选择，宿主管 `resolved_model` 里的事实；三者只在 [4] 这一个决策点相遇，唯一真相读回自 runtime 自报 [5]。**

## 4. 接口清单（7 处代码改动）

| # | 文件 | 职责 |
| --- | --- | --- |
| 1 | `apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts` | `AgentPersona`（30-33 行）新增 `model?: string` 成员及注释；`agent()`（65 行）文档补声明语义。`FACADE_DTS` 是编译器 typecheck 的单一事实源，改这里即改脚本可见 API。 |
| 2 | `apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts` | `PersonaSpec`（65-68 行）新增 `model?: string`；改写两段旧裁决注释——58-64 行"模型档位已退场"（persona 现在有了模型面：作者声明，非档位枚举）与 761-775 行 `ActorRecord.resolvedModel`"为什么不塞进 persona"（保留两字段两作者裁决，补声明与事实的新关系）。 |
| 3 | `apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-model.ts` | 优先级表插入最高档：persona 声明（已解析的 `ModelSelection`）在场时整条覆盖且 pin 不解析；维持纯函数、收已解析选择、不引 Registry 的接缝；中文注释改写说明新裁决。 |
| 4 | `apps/zcode-cli/packages/core/src/tool/handlers/model-reference.ts` | `describeWorkflowSubagentModel`（113-116 行）文案收窄为"未声明模型的子代理"；`resolveModelReference` 本体零改动（声明解析复用它）。 |
| 5 | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | `createActorRuntime` 闭包（591-626 行）：persona.model 在场时先经 `resolveModelReference` 解析（catalog entries 来自 `modelCatalogPort`，722-725 行创建；闭包惰性执行可直接引用，若 TS 报 use-before-declaration 则在闭包内就地构造 catalog），失败即抛（2.4），成功则作为声明选择传给 `workflowActorModelPolicy`。 |
| 6 | `apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts` | 修正 469 行的类型谎言：`message.persona as string | undefined` 改为忠实的 `string | PersonaSpec | undefined`（协议侧 `protocol.ts:50` 本就是 `unknown`，引擎 `createActor` 本就收 `string | PersonaSpec`，`engine.ts:416`）——`PersonaSpec.model` 必须能带着类型检查过桥。 |
| 7 | `apps/zcode-cli/packages/core/src/index.ts` | 选择性 re-export `resolveModelReference`（当前未从 core 公开导出，已核实 `core/src/index.ts` 无此导出；bootstrap 需经公开入口引用，遵守跨包公开入口规则）。 |

文案/文档同步件（随规则 6 一起落，不属上述 7 处代码接口）：`packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`（见 2.7 所列 key 与行号）、`apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md`（facade-dts 副本 + `subagent_model` 两处描述）。

## 5. 验收场景

1. **三 actor 混布各就各位**：脚本声明 `agent("a", {model: "p1/m1"})`、`agent("b", {model: "p2/m2$high"})`、`agent("c")`（不声明），以 `subagent_model: "p3/m3"` 发起 run。三个 actor 全部完成后，journal `dwf_actor` 三行的 `resolved_model` 互不相同且分别为 `p1/m1`、`p2/m2`、`p3/m3`——声明的两个 actor 不吃 run 级选择，未声明的吃；`run-launched` 事件仍是 `p3/m3` 的 canonical 形。
2. **声明未知模型，run 失败含候选列表**：`agent("x", {model: "no-such-model"})` 发起 run，该 actor 会话创建时 `resolveModelReference` 回 `not_found`，actor 会话创建抛错 → 首个 ask 失败 → run `failed`；failure 信息包含该 actor 定位与"Available models:"候选清单；过程中没有任何 actor 静默落到 run 选择或父会话模型。
3. **崩溃 resume 不改脚本，各 actor 跑原模型**：多 actor run 中途崩溃，父会话随后**换了主模型**，ResumeWorkflowRun 不改脚本重放：声明在场的 actor 仍按声明解析（声明重建自 persona 重放，与 `persona_json` 一致）；未声明且已有 `resolved_model` 的 actor 被自己的 pin 钉回原模型，不跟着父会话漂移。
4. **amend 改单 actor model，仅该 actor 重跑**：对已完成 run 做 `AmendWorkflow`，脚本只把 `agent("reviewer")` 的 persona.model 从 `p1/m1` 改为 `p4/m4`：`matchImportedActor` 的 `canonicalJson` persona 比对仅对 "reviewer" 失配 → reviewer 导入候选被弃、全新重跑并落新 `resolved_model`；其余具名 actor 的缓存照常导入，不产生新的模型解析或 token 消耗。

## 6. 上游同步影响

本仓库是 `zai-org/ZCode` 的低 diff 商业 fork，上述 7 处均为上游拥有的文件（fork 初始化于 `29628c9` = `v3.14.3`，见 `UPSTREAM-SYNC.md:166-167`）。改动全部落在"新增可选成员 + 一处装配 + 文案"的补丁形态，过 `UPSTREAM-SYNC.md:156-162` 五问的口径如下。行数为**规划估算**（规则先于实现，落地时以实际 diff 为准）：

| 文件 | 估计改动 | 移除性 |
| --- | --- | --- |
| `dynamic-workflow/src/facade/dts.ts` | +8~12 行 | 纯增量：删掉 `model` 成员与注释即回到原 facade；无逻辑分支。 |
| `dynamic-workflow/src/engine/types.ts` | 净 +15~25 行（注释为主） | 删字段+还原两段注释即移除；注释改写不引行为。 |
| `bootstrap/src/app/workflow-actor-model.ts` | +40~60 行 | 新最高档是自足的独立分支：删掉该分支与配套注释，优先级表即回到三档现状；不动既有 pin 语义。 |
| `core/src/tool/handlers/model-reference.ts` | ±3 行 | 一句文案收窄，revert 即还原。 |
| `bootstrap/src/app/create-app.ts` | +15~25 行 | 闭包内一段装配：删掉 persona.model 解析与传参即回到现状接线。 |
| `dynamic-workflow-runtime/src/harness.ts` | ±2 行 | 类型修正，与行为正交，revert 即还原。 |
| `core/src/index.ts` | +1~3 行 | 一条选择性 re-export，删行即移除。 |

合计约 100~140 行。易重贴性：补丁全部小、局部、与无关产品逻辑分离，五问回答——(1) 不能整个做成新模块（persona 类型与优先级表在上游文件内），但产品逻辑（解析装配）集中在 create-app 一处闭包；(2) 已用 adapter 姿态（`modelCatalogPort` 注入宿主事实，纯函数不引 Registry）；(3) 集成点已最小（7 处均为必要接缝）；(4) 决策逻辑留在 `workflowActorModelPolicy` 纯函数，上游文件只做接线；(5) 上游若改这些文件的相邻区域，重放补丁不依赖上下文大段重排。文案同步件（i18n ×2、SKILL.md）为独立资源文件，merge 冲突面小且与代码补丁互不牵连。

---

### 撰写自查（对照已对齐的产品规则 1-6）

- 规则 1（API 与语法）：2.1 + 2.2，语法= `subagent_model`、裸 id 歧义即失败、跨 provider 全称主推——一致。
- 规则 2（优先级）：2.3 表，新最高档压 run 选择与 pin，声明在场 pin 连解析都不做（同款处理）——一致。
- 规则 3（失败语义）：2.4，四类失败 → 会话创建抛错 → ask 失败 → run 失败，绝不静默回落——一致。
- 规则 4（声明与事实分离）：2.5，两字段两作者、`persona_json` 落声明、`resolved_model` 落事实兼 pin——一致。
- 规则 5（amend 缓存）：2.6，canonicalJson 比对零代码自动生效，改 model ⇒ 仅该 actor 弃候选重跑——一致。
- 规则 6（文案收窄）：2.7，三处口径（工具文案 / skill 文档 / GUI i18n）——一致。

无自创规则：确认窗不展示 actor 级声明（2.1 末段）是"persona 是运行期值 + 解析在会话创建"的既有事实推论，非新规则。
