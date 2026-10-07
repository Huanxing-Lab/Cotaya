// ============================================================
// Dynamic Workflow Run Service：受控 submitOnce（Continuous managed cycle，CT-03）
// ============================================================
// 规格来源：docs/specs/continuous.md §10（执行 ID 在提交前保存；新增内部 submitOnce 只允许
// 受控调用指定身份；已存在时检查 parent、script hash、args；不同内容同 ID 拒绝；不预插
// dwf_run，占用其 Engine 创建权）。
//
// 与普通 submit（dynamic-workflow-run-submit.ts）方向不同、绝不共用语义：
//   - submit 铸随机 ID，永远全新；重试 = 新 run（用户面的既有契约，一字不改）。
//   - submitOnce 用调用方（Host 侧 ContinuousService）在提交前持久化的稳定 runId：
//     ACK 丢失 / 崩溃后重发**同一个身份**，必须命中同一个 run，绝不铸第二个（R-01/R-02）。
//
// 为什么不在 `DynamicWorkflowRunPort` 上：那是引擎/工具层的窄端口，加上受控身份提交等于
// 让每个端口实现（含 stub）都为一件只有 managed cycle 才做的事负责；它与 countLiveRuns /
// close 一样是宿主生命周期面，落在 service 类型上（dynamic-workflow-run-service.ts）。
//
// 复用 vs 拒绝的裁决表（journal 行存在时）：
//   owner（parentSessionId）不同  → owner_mismatch     （execution_identity_mismatch）
//   scriptText  不同              → script_mismatch    （execution_identity_mismatch）
//   args 不同                     → args_mismatch      （execution_identity_mismatch）
//   三者全同 + 本进程活条目        → reused: true（不铸第二 run，ACK 丢失安全）
//   三者全同 + completed          → completed          （completed 不 resume / 不重跑，R-05）
//   三者全同 + errored            → errored            （errored 拒绝恢复，规格 §10）
//   三者全同 + stopped(superseded)→ superseded         （superseded 拒绝恢复）
//   三者全同 + stopped(其余)      → stopped            （恢复走 resume()，不是 submitOnce）
//
// 同 ID 同内容的比较基于 journal 行的**原文**（scriptText / args / parentSessionId）：行上的
// scriptHash 本就由同一文本派生（compileOnce 的所有权），比较文本即比较 hash，且不吃解码
// 差异。journal 行不存在而注册表有条目（submit → createRun 的微任务间隙）时按活条目判同，
// 两条路径同一套裁决。

import type { TraceContext } from "@zcode/contracts";
import type { RunRecord } from "@zcode/dynamic-workflow";
import { startNewRun, type DynamicWorkflowRunEntryContext } from "./dynamic-workflow-run-submit.js";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";

/** 受控提交的拒绝词表（结构化、稳定；映射到规格 §11 的执行错误码见 continuous-execution-adapter.ts）。 */
export type ManagedRunSubmitRejection =
  | "owner_mismatch"
  | "script_mismatch"
  | "args_mismatch"
  | "completed"
  | "errored"
  | "superseded"
  | "stopped";

/** 受控提交请求：身份由调用方在提交前持久化（规格 §10「执行 ID 在提交前保存」）。 */
export interface ManagedRunSubmitRequest {
  /**
   * 调用方铸的稳定 runId。字符集必须与 mintRunId 的产物一致（`[A-Za-z0-9-]`）：它会进 actor
   * 会话 id、URL、文件路径与日志，含 `#`/`@`/`/` 的 id 会在下游炸出离得很远的失败。
   */
  runId: string;
  scriptText: string;
  cwd: string;
  /** 本 run 的执行会话（dwf_run.parent_session_id 的值）：owner 检查与崩溃恢复的身份基准。 */
  parentSessionId: string;
  args?: Record<string, unknown>;
  name?: string;
  /**
   * 评审修复（CT-12 遗留缺口）：冻结配置的并发上限（budget.maxConcurrentActors，默认 10）
   * 传入引擎 caps——此前 managed submit 不带并发请求，run 的 caps 起于 CPU 天花板
   * （min(16, availableParallelism−2)），在 ≥12 核机器上会越过「最多 10 个 actor 并发」
   * 的固定产品规则（ticket CT-12：「不能退回 CPU 默认值」）。机器天花板更低时仍按
   * clampRunConcurrency 钳制（上限不是保证，§9「不能隐藏较低的机器限制」）。
   */
  maxConcurrency?: number;
  trace: TraceContext;
}

export type ManagedRunSubmitResult =
  | {
      ok: true;
      runId: string;
      /** true = 命中已接受的同一身份，本次没有启动新执行。 */ reused: boolean;
    }
  | { ok: false; reason: ManagedRunSubmitRejection };

/** runId 的安全字符集（与 mintRunId 的产物一致；见 ManagedRunSubmitRequest.runId）。 */
const MANAGED_RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/**
 * 内部 submitOnce：同 ID 同内容复用，不同 hash/args/owner 拒绝；全新身份经 {@link startNewRun}
 * （与普通 submit 同一条启动路：编译一次、注册先于启动、fire-and-forget）。
 *
 * 检查与启动之间没有 await（compileOnce / startNewRun 全同步），单进程内不存在「两次并发
 * submitOnce 都看到行不存在」的窗口；跨进程的竞态由引擎 createRun 的主键约束兜底（第二个
 * 进程的 createRun 抛错、结算 errored，行不被覆盖），跨进程单执行者纪律归 Host 的 workspace
 * lease（规格 §10，CT-07）。
 */
export function submitManagedDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: ManagedRunSubmitRequest,
): ManagedRunSubmitResult {
  const { deps, runs } = ctx;
  if (!MANAGED_RUN_ID_PATTERN.test(request.runId)) {
    // 不是业务拒绝而是接线错误：id 来自 Host 的持久化字段，形状不对说明上游构造被绕过。
    throw new Error(
      `managed dynamic workflow submit received an unsafe runId: ${JSON.stringify(request.runId)}`,
    );
  }

  const record = deps.journal.getRun(request.runId);
  const entry = runs.get(request.runId);

  // ── 已存在：身份核对，然后按状态裁决 ──
  if (record !== undefined) {
    const identity = checkManagedRunIdentity(
      {
        args: record.args,
        parentSessionId: record.parentSessionId,
        scriptText: record.scriptText,
      },
      request,
    );
    if (identity !== undefined) return { ok: false, reason: identity };
    // 本进程活条目 = 已接受的执行仍在飞：幂等复用（R-02 ACK 丢失重发命中这里）。
    if (entry !== undefined && entry.terminal === undefined) {
      return { ok: true, runId: request.runId, reused: true };
    }
    // 行非终态而本进程无活条目：执行属于另一进程（或死进程的遗物）。**同身份复用**——
    // 行就是那个 Run，绝不铸第二个引擎（createRun 会撞进引擎的 resume 分支）。它是否
    // 真的活着由 inspectHealth.reachable 回答；死进程的核对/接管/interrupted 归档是
    // Host 恢复流程的职责（规格 §10 恢复顺序，CT-07）。
    if (record.status === "pending" || record.status === "running") {
      return { ok: true, runId: request.runId, reused: true };
    }
    return { ok: false, reason: terminalRejectionOf(record) };
  }

  // ── journal 行不存在 ──
  // 活条目在场 = submit → createRun 的微任务间隙内的重发：同一身份按条目判同并复用。
  if (entry !== undefined) {
    const identity = checkManagedRunIdentity(
      {
        args: undefined,
        parentSessionId: entry.parentSessionId,
        scriptText: entry.scriptText,
      },
      request,
    );
    if (identity !== undefined) return { ok: false, reason: identity };
    if (entry.terminal === undefined) return { ok: true, runId: request.runId, reused: true };
    // 条目已结算而行还没落：引擎的 createRun 是结算链的一环，行迟到片刻即到；按已结算拒绝，
    // 调用方重试一次就会走 journal 分支拿到准确状态。
    return { ok: false, reason: terminalRejectionOfEntry(entry) };
  }

  // ── 全新身份：与普通 submit 同一条启动路 ──
  // parentSessionId 用执行会话（不是本 app 的会话）：孤儿收敛只收敛本 app 会话的行，
  // managed run 的中断恢复由 Host 按原身份核对（规格 §10 恢复顺序），不被误标死。
  startNewRun(ctx, {
    runId: request.runId,
    scriptText: request.scriptText,
    cwd: request.cwd,
    parentSessionId: request.parentSessionId,
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.name === undefined ? {} : { name: request.name }),
    // 冻结配置的并发上限（评审修复：不能退回 CPU 默认值，见 ManagedRunSubmitRequest 注释）。
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    trace: request.trace,
  });
  return { ok: true, runId: request.runId, reused: false };
}

/** journal 行/注册表条目上的身份三元组；缺席字段按「调用方也缺席」比较。 */
interface ManagedRunIdentity {
  parentSessionId?: string;
  scriptText?: string;
  args?: Record<string, unknown>;
}

/** 身份不一致返回对应拒绝；一致返回 undefined（可进入状态裁决）。 */
function checkManagedRunIdentity(
  existing: ManagedRunIdentity,
  request: ManagedRunSubmitRequest,
): ManagedRunSubmitRejection | undefined {
  if (existing.parentSessionId !== request.parentSessionId) return "owner_mismatch";
  // scriptText 缺席 = 建行早于 script_text 列的远古行：managed run 都是新建的，理应在场；
  // 按不同内容拒绝（保守侧），不拿未知的文本冒充相同。
  if (existing.scriptText !== request.scriptText) return "script_mismatch";
  if (!sameArgs(existing.args, request.args)) return "args_mismatch";
  return undefined;
}

/**
 * args 的同值判定。Host 重发的是它持久化的同一袋实参，键序稳定；JSON 序列化比较因此足够，
 * 且与落库形态（args_json）同源。深比较的工具（zod.equals 等）在这里只会引入一份第二套
 * 相等语义——同一个对象图两处判等，迟早分叉。
 */
function sameArgs(
  existing: Record<string, unknown> | undefined,
  requested: Record<string, unknown> | undefined,
): boolean {
  if (existing === undefined || requested === undefined) return existing === requested;
  return JSON.stringify(sortedArgs(existing)) === JSON.stringify(sortedArgs(requested));
}

/** 键排序后的浅拷贝：让比较对键序免疫（Host 的持久化往返不保证键序）。 */
function sortedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(args)
      .sort()
      .map((key) => [key, args[key]]),
  );
}

/** journal 行的终态裁决（行存在且已终态；pending/running 在调用方先行复用）。 */
function terminalRejectionOf(record: RunRecord): ManagedRunSubmitRejection {
  switch (record.status) {
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "stopped":
      // superseded 的未完结工作已归后继所有（resume 门的同一条论证）；其余 stopped 的恢复
      // 走 resume()——submitOnce 只负责「从未被接受的执行」，不负责重启已停下的执行。
      return record.stopReason === "superseded" ? "superseded" : "stopped";
    default:
      // 不可达（pending/running 已在调用方复用）；保守按 stopped 拒绝。
      return "stopped";
  }
}

/** 条目终态的同一裁决（journal 行尚未落地的间隙）。 */
function terminalRejectionOfEntry(entry: RunRegistryEntry): ManagedRunSubmitRejection {
  const terminal = entry.terminal;
  if (terminal === undefined) return "stopped";
  switch (terminal.status) {
    case "completed":
      return "completed";
    case "stopped":
      return terminal.reason === "superseded" ? "superseded" : "stopped";
    default:
      return "errored";
  }
}
