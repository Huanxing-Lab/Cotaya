// Continuous 到期唤醒的 Host 路由缝（CT-07）。
//
// Host 进程（host/index.ts）收到 main 转发的 ContinuousWake 消息后经本模块分发到已注册的
// 处理器（Continuous supervisor/恢复服务的唤醒入口）。本文件只是路由：不保存业务队列、
// 不创建 Cycle、不碰 tasks-index——执行编排全部在注册进来的处理器（services 侧）。
//
// 处理器缺席（功能未装配/默认关闭）时 dispatch 抛错，由消息入口回执 ok=false——
// scheduler 在仍到期时重发；绝不退回普通 prompt 自主执行。

/** ContinuousWake 消息的最小路由载荷（身份字段按 workspace identity 规则原样传递）。 */
export interface ContinuousWakeDispatch {
  programId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 到期时刻（Program 持久化的 nextCycleAt）；仅日志关联，trigger key 由处理器派生。 */
  dueAt: number;
}

export type ContinuousWakeHandler = (wake: ContinuousWakeDispatch) => Promise<void>;

let handler: ContinuousWakeHandler | null = null;

/** Host 装配 Continuous 服务时注册（CT-08 接线；默认无人注册 = 功能关闭）。 */
export function registerContinuousWakeHandler(next: ContinuousWakeHandler): void {
  handler = next;
}

export function clearContinuousWakeHandler(): void {
  handler = null;
}

/** 分发一次唤醒；无处理器时抛错（结构化回执由消息入口负责）。 */
export async function dispatchContinuousWake(wake: ContinuousWakeDispatch): Promise<void> {
  if (handler === null) {
    throw new Error("continuous wake handler not assembled (feature disabled)");
  }
  await handler(wake);
}
