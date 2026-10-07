// 一期未决 4（capability 探测堆积）的修复：功能默认关闭时，Host 不再用「channel 未注册」
// 表达关闭——那会让 renderer 的 capability 探测在 ChannelServer 的 pendingRequests 里永久
// 排队（未注册 channel 的请求只缓存、等该 channel 将来注册才冲刷，关闭态永远不会来），
// 用户每次打开 Automations 页新增 1-2 条，缓慢累积且无上界。改为在关闭态注册本 stub：
// capability() 立即以结构化错误拒绝（消息含 continuous_not_enabled 标记——同进程读
// error.code，跨 RPC 读消息标记），其余命令与查询同样 fail closed（不退回普通 prompt
// 自主执行）。
//
// 产品语义（与 UI 三态对齐，勿混）：「未开启」≠「不支持」——未开启（默认关闭）是正常
// 产品形态，tab 整体缺席（availability=disabled，隐藏）；「不支持」（旧 CLI/远程/平台
// 只读）才进 tab 展示解释面（availability=unsupported）。因此本 stub 不能回答
// supported:false（那会被 UI 判为 unsupported、让关闭态多出一个 tab，破坏 E-24 关闭态
// 断言与「默认关闭 = 隐藏」回滚位），必须以「未开启」错误落定到 disabled 隐藏态。
//
// 本类无 repository/clock/进程依赖——注册它不产生任何业务状态或副作用，「功能默认关闭」
// （规格 §13）的语义不变，只是把「沉默」换成「明确说不」。

import type { IContinuousServiceFacade } from "../contract-interfaces.js";

/** 关闭态 capability 拒绝的稳定标记（error.code 同进程用；消息标记跨 RPC 用）。 */
export const CONTINUOUS_NOT_ENABLED_CODE = "continuous_not_enabled";

function notEnabled(method: string): never {
  throw Object.assign(
    new Error(`${CONTINUOUS_NOT_ENABLED_CODE}: Continuous 功能未开启（${method} 拒绝，默认关闭）`),
    { code: CONTINUOUS_NOT_ENABLED_CODE },
  );
}

/**
 * 关闭态的 ServiceChannels.Continuous 应答者（与 ContinuousCommandService 同一 facade 形状）。
 * renderer 侧版本错配（旧 Host 无本 stub）由 useContinuousAvailability 的探测超时兜底。
 */
export class ContinuousDisabledService implements IContinuousServiceFacade {
  async capability(): Promise<never> {
    return notEnabled("capability");
  }

  async snapshot(_params: unknown): Promise<never> {
    return notEnabled("snapshot");
  }

  async createProgram(_params: unknown): Promise<never> {
    return notEnabled("createProgram");
  }

  async runNow(_params: unknown): Promise<never> {
    return notEnabled("runNow");
  }

  async pauseProgram(_params: unknown): Promise<never> {
    return notEnabled("pauseProgram");
  }

  async resumeProgram(_params: unknown): Promise<never> {
    return notEnabled("resumeProgram");
  }

  async stopCurrentCycle(_params: unknown): Promise<never> {
    return notEnabled("stopCurrentCycle");
  }

  async resolveDecision(_params: unknown): Promise<never> {
    return notEnabled("resolveDecision");
  }

  async dismissDecision(_params: unknown): Promise<never> {
    return notEnabled("dismissDecision");
  }

  async archiveProgram(_params: unknown): Promise<never> {
    return notEnabled("archiveProgram");
  }

  async resolveContinuation(_params: unknown): Promise<never> {
    return notEnabled("resolveContinuation");
  }

  async listTemplates(_params: unknown): Promise<never> {
    return notEnabled("listTemplates");
  }

  async programDetail(_params: unknown): Promise<never> {
    return notEnabled("programDetail");
  }
}
