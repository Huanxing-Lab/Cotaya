// ============================================================
// workflow actor 的模型面（persona 声明 / run 选择 / journal pin → AgentRuntime 模型配置）
// ============================================================
//
// persona 的模型面有过两代。第一代是档位（`model?: "main" | "lite"`），已退场——宿主在 provider
// 重构后没有 lite 模型来源，"lite" 与 "main" 早已同路。第二代是现在的最高档：`agent()` 的
// persona 可声明完整模型引用（`providerId/modelId[$reasoningLevel]`，语法与 `subagent_model`
// 完全一致），让一个工作流的不同 actor 跑不同 provider 的不同模型。
//
// 声明与事实在此分家：persona.model 是**脚本作者**的声明——随 persona 冻结、随 journal 的
// `dwf_actor.persona_json` 落库、resume 时脚本重放自动重建；`dwf_actor.resolved_model` 仍是
// **宿主事实**（权威 `runtime.getSessionModelSelection()`），兼下一次 resume 的 pin。两个字段
// 作者不同、生命周期不同，互不吞并：声明解释「为什么跑这个模型」，事实记录「实际跑在哪个模型」。
//
// 于是本模块只回答一个问题：**这个 actor 的会话该跑在哪个模型上**。四个来源按优先级排：
// persona 声明 > 本 run 的 `subagentModel`（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`）> resume pin（journal 里上一次实际跑的模型）> 父会话当前模型。
// 与 workflow-actor-tools.ts 是同一个接缝上的姊妹模块：一个给出工具面，一个给出模型面，
// 都由 driver 侧的 runtime 工厂在造 AgentRuntime 时展开。

import type { ModelSelection } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** 解析模型面需要的宿主侧事实。 */
interface WorkflowActorModelHost {
  /**
   * 父会话**当前**的模型选择（`runtime.getSessionModelSelection()`）。只在没有 run 级选择时
   * 有用：与 pin 比对（判断「钉住的模型是否就是现在的主模型」，从而决定 pin 分支要不要真的
   * 覆盖）。父会话尚无选择时缺席。
   */
  parentSelection?: ModelSelection | undefined;
  /**
   * 本 run 自己的子代理模型（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`，从 journal
   * 的 `run-launched` 事件读回）。**整条选择**，含 reasoning
   * 档位——用户说「未声明模型的子代理跑 GLM-5.3-Flash$high」时那个档位是选择的一部分，不能在这里掉。
   *
   * 位置：**次高**（persona 声明之下）。它是用户对这一次 run 里**未在 persona 里声明模型的子代理**
   * 的显式表态；在场时 pin 与父模型都只是它本来要替换的缺省（见下面的函数注释）。主代理不受它
   * 影响——它只描述子代理。
   */
  runSelection?: ModelSelection | undefined;
}

/** AgentRuntimeConfig 的模型面切片。 */
interface WorkflowActorModelPolicy {
  /**
   * 展开进 AgentRuntimeConfig 的覆盖项。**空对象即「不覆盖」**：child runtime 的基线本就是
   * 父会话的模型选择（script-workflow-child-runtime.ts），所以没有 run 选择也没有 pin 时什么
   * 都不写，就是继承父模型。
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
}

/**
 * 钉住的模型无法构造时抛出。带上 pin 本身：排查的人需要知道 journal 里钉的是哪个模型，
 * 而不是从一条「模型引用非法」的通用消息里猜。
 */
export class WorkflowActorPinnedModelError extends Error {
  readonly pinnedModel: string;

  constructor(pinnedModel: string, cause?: unknown) {
    super(`Cannot construct the model pinned for this subagent: ${pinnedModel}`);
    this.name = "WorkflowActorPinnedModelError";
    this.pinnedModel = pinnedModel;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * persona 声明的模型无法解析时由**装配层**（create-app 的 createActorRuntime，经
 * `resolveModelReference` 解析 persona.model）抛出，随 actor 会话创建失败 → ask 失败 → run 失败，
 * 绝不静默回落。带上声明原文与原因（not_found / ambiguous / disabled / reasoning_level_unknown）：
 * 脚本作者需要知道是哪一条 `agent()` 声明、为什么失败，而不是从一条「模型引用非法」的通用消息里猜。
 * 本纯函数只收**已解析**的选择（保持不引 Registry/catalog），解析失败发生在它上游，故不在本函数内抛。
 */
export class WorkflowActorPersonaModelError extends Error {
  readonly declaredModel: string;
  /**
   * 跨包标记（结构类型，引擎侧 describeCause 按字段名识别，不 import 本类型）：
   * reason 是 `resolveModelReference` 的 message，`not_found` 自带可用模型候选清单
   * （spec §2.4 要求完整送达，与 `subagent_model` 经 ToolHandlerFailure 直返全文的失败面一致）。
   * 引擎错误通道的 300 字符一行上限会把多行清单拦腰截断，模型作者按半份清单猜不出可用模型，
   * 所以 describeCause 见到此标记时原样放行、不截断。
   */
  readonly unboundedCauseMessage = true;

  constructor(declaredModel: string, reason: string) {
    super(
      `Cannot resolve the model declared by this subagent's persona: ${declaredModel} (${reason})`,
    );
    this.name = "WorkflowActorPersonaModelError";
    this.declaredModel = declaredModel;
  }
}

/**
 * 把 persona 声明、run 选择与 journal 里的 pin 映射成 AgentRuntime 的模型配置。纯函数。
 *
 * `personaSelection` 是 `agent()` 的 persona 里 `model` 声明解析出的整条选择——装配层用
 * `resolveModelReference`（与 `subagent_model` 同一套语法与失败面）解析后传入；解析失败在装配层
 * 就以 {@link WorkflowActorPersonaModelError} 大声失败，本函数只会见到解析成功的形态。
 * `pinnedModel` 是这个 actor 在 journal 里记下的 `resolvedModel`（`providerId/modelId`），
 * 只有 resume（含 amend-resume 从前驱承袭的种子）会带上它。
 *
 * 优先级：**persona 声明 > 本 run 的 `subagentModel` > resume pin > 父会话当前模型**。
 *
 * | persona 声明 | run 选择 | pin | 解析结果 |
 * |---|---|---|---|
 * | 有 | 任意 | 任意（含畸形，不解析） | 覆盖成 persona 声明（整条，含 reasoning 档位） |
 * | 无 | 有 | 任意（含畸形，不解析） | 覆盖成 run 选择（整条，含 reasoning 档位） |
 * | 无 | 无 | 无 | 不覆盖（父会话当前模型） |
 * | 无 | 无 | = 父会话当前模型 | 不覆盖（钉的就是现在的主模型） |
 * | 无 | 无 | ≠ 父会话当前模型 | 覆盖成 pin 解析出的选择 |
 * | 无 | 无 | 畸形（缺 provider 段） | {@link WorkflowActorPinnedModelError} |
 *
 * **声明与事实分离。** persona 声明的作者是脚本作者：他在写 `agent(name, { model })` 时就定下
 * 这个 actor 的身份，随 persona 冻结、随 `dwf_actor.persona_json` 落库、resume 时脚本重放自动
 * 重建。而 journal 里的 `resolved_model`（即这里的 pin 来源）是宿主事实，权威是造出来的 child
 * runtime 自己——见函数尾的说明。两个字段作者不同、生命周期不同，互不吞并。
 *
 * persona 声明排在 run 选择之上，理由与 run 选择排在 pin 之上同源：**声明是显式表态，pin 只守
 * 没有显式选择时的隐式缺省**。run 级 `subagentModel` 说的是「未声明模型的子代理跑在 X」——一个
 * 已经在 persona 里点名模型的 actor 不在它的覆盖范围里，声明在场时 pin 连解析都不做（见函数体）。
 * 反过来，改声明是有代价且可见的：amend 修订脚本里某 actor 的 `model` 会让该 actor 的
 * persona 冻结内容变化、缓存导入候选被弃、全新重跑，其余 actor 照常导入。
 *
 * **省略即继承，显式值即替换。** resume / amend 的 `resolveInput` 对 `subagentModel` 与
 * `max_concurrency` 已经是这条规则；pin 是同一条规则用在**隐式缺省**上：一个没有 `subagentModel`
 * 的 run，其子代理的缺省不是「父会话此刻的模型」，而是「这个子代理上次实际跑的模型」。run 有了
 * `subagentModel`，就没有缺省可继承，pin 便无话可说。所以 pin 排在 run 选择之下——它守的是
 * 静默漂移，而 `AmendWorkflow` 带 `subagent_model` 恰是那个显式、用户看得见的决定（确认窗与
 * 工具输出都写着「Subagents run on …」）。之前 pin 排在 run 选择之上，结果每个
 * 带 live 工作的续跑子代理都跑在前驱的模型上，而 `run-launched` 与确认窗说的是另一个。
 * 换模型这段历史不会丢：新 run 自己的 `dwf_actor` 行记下新选择，前驱的行仍是旧模型，lineage
 * 因此保留了「在哪一次 run 换过」。
 *
 * 为什么要有 pin——它是 **persona 冻结不变式的持久化那一半**：persona 在 `agent()` 时冻结，
 * 而 resume 会从 journal 重建 actor。没有 pin，父会话在两次运行之间换了主模型，就会在一条
 * actor transcript 中途**悄悄改掉一个已冻结的身份**：前半段的 ask 由模型 X 产出、resume 之后的
 * 由模型 Y 产出，而没有任何地方记下身份变过。
 *
 * **v1 的 pin-miss 策略（无 persona 声明、无 run 选择的路径）：宁可失败，绝不静默换模型。**
 * pin 指向宿主再也构造不出的模型时（provider 没了、模型下线），本函数**不回退**到父会话模型——
 * 那恰好就是 pin 要防的那次静默身份变更。畸形的 pin 在这里就以
 * {@link WorkflowActorPinnedModelError} 失败；而一个「格式合法但宿主已经没有」的模型在建会话
 * 这一刻查不出来（要查得动宿主的 Registry，那是本纯函数刻意不引入的机器），它会在**第一次 ask**
 * 的模型调用上以 node 级错误浮出来——这是有意接受的：晚一点大声失败，也好过悄悄换一个模型继续跑。
 * 要在 resume 时换模型，路有两条：amend 修订脚本里该 actor 的 persona `model` 声明（该 actor
 * 缓存被弃、全新重跑），或 `AmendWorkflow` 带上 `subagent_model`（run 选择这一支，只覆盖未声明
 * 模型的子代理）。
 *
 * 本函数**不产出**「最终跑在哪个模型上」这条事实：它要落 journal，而权威是造出来的 child
 * runtime 自己（`runtime.getSessionModelSelection()`）。让 runtime 来说，就不会出现「策略以为
 * 选了 A、runtime 实际跑着 B」这类两处各算一遍才会有的偏差。落库见
 * dynamic-workflow-run-launch.ts 的 `journalActorResolvedModel`。
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  pinnedModel?: string,
  personaSelection?: ModelSelection,
): WorkflowActorModelPolicy {
  // persona 声明在场：整条覆盖，run 选择与 pin 连解析都不做——它们只是声明本来要替换的缺省。
  // 与 run 选择在场时对 pin 的处理同款、理由同源：声明是脚本作者的显式表态，其余来源只守
  // 没有显式选择时的隐式缺省。
  if (personaSelection !== undefined) {
    return { configOverrides: { modelSelection: personaSelection } };
  }
  // run 选择在场：整条覆盖，pin 连解析都不解析——它只是本 run 要替换掉的那个缺省。
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection } };
  }
  if (pinnedModel === undefined) return { configOverrides: {} };
  const pinned = parsePinnedModel(pinnedModel);
  // 钉的就是父会话现在的模型：交给 child runtime 的基线自己表达。「不覆盖」是**更强**的
  // 表达——基线连 reasoning 选项一起继承，而按身份覆盖会把选项换成一个少了 options 的等价物。
  if (host.parentSelection !== undefined && sameModelIdentity(pinned, host.parentSelection)) {
    return { configOverrides: {} };
  }
  // 父会话在两次运行之间换了主模型。仍然钉住 pin——静默换模型正是 pin 要防的事；要换，
  // 走 AmendWorkflow 的 subagent_model（上面那一支）。
  // reasoning 选项在这条路径上不重算：pin 守的是**模型身份**（providerId/modelId），journal 里也只记这两段。
  return { configOverrides: { modelSelection: pinned } };
}

/** pin 比对只看身份两段：journal 只记 `providerId/modelId`，options 不是身份的一部分。 */
function sameModelIdentity(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * 解析 journal 里的 pin。**不带默认 provider**：pin 是本机写出的 `providerId/modelId`，
 * 缺了 provider 段就说明这条记录不是这个格式写的（或被改过），此时拿父会话的 provider 去补
 * 等于猜出一个新身份——正是 pin 要防的事。宁可大声失败。
 */
function parsePinnedModel(pinnedModel: string): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(pinnedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(pinnedModel);
  return parsed;
}
