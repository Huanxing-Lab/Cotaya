// Continuous 服务接口定义（CT-00 锁定；CT-08 拆出为叶子文件）。
// 拆分原因：continuousCommandService（实现）implements 这些接口，而 contract.ts 又要
// re-export 实现类——接口放 contract.ts 会形成 contract ↔ implementation 的 import 环
// （架构 forbidCycles 把 type-only import 也计入依赖边）。接口是叶子：不 import 任何实现。
// 对外公开路径不变：contract.ts 再导出（模块 publicEntrypoints 仍只有 contract.ts）。

import type { Cycle, Program } from "./domain/types.js";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ContinuousArchiveProgramParams,
  ContinuousCapabilityResult,
  ContinuousCreateProgramParams,
  ContinuousDismissDecisionParams,
  ContinuousPauseProgramParams,
  ContinuousProgramDetailParams,
  ContinuousProgramDetailResult,
  ContinuousResolveContinuationParams,
  ContinuousResolveContinuationResult,
  ContinuousResolveDecisionParams,
  ContinuousResumeProgramParams,
  ContinuousRunNowParams,
  ContinuousSnapshotParams,
  ContinuousSnapshotResult,
  ContinuousStopCurrentCycleParams,
  ContinuousTemplatesParams,
  ContinuousTemplatesResult,
} from "@zcode/shared";

/**
 * Continuous 服务接口（Host 持有唯一实例；业务写入唯一路径）。
 * 所有命令先过 capability 检查（supportsManagedCycles），旧 CLI/远程第一版返回
 * 结构化 capability_missing / remote_execution_not_supported，不回退普通 prompt 执行。
 * Pause 与立即停止本轮是两个命令：前者本轮结束后生效，后者撤销写入→取消→等待停止。
 */
export interface IContinuousService {
  /**
   * 声明 managed cycle capability；必须先查询，未支持时不得调用其余命令。
   * 评审修复：返回 Promise——本接口经 RPC ProxyChannel 消费，所有方法在 renderer 侧都
   * 返回 Promise；原同步声明让 UI 把 Promise 对象直接喂给 supportsManagedCycles（恒 false，
   * 装配后也会被判 unsupported）。Host 侧实现对齐为 async。
   */
  capability(): Promise<ContinuousCapabilityResult>;
  /** workspace 维度的事实快照；UI 只消费 snapshot，不在本地另建接受队列。
   * CT-08 起参数形与 wire schema 对齐（{context}；此前直接收 context——统一后 RPC 映射零特判）。 */
  snapshot(params: ContinuousSnapshotParams): Promise<ContinuousSnapshotResult>;
  /** 初次创建：绑定 Goal/Scope/Budget/Cadence/模板 hash 与首次授权（D4：仅本地 workspace）。 */
  createProgram(params: ContinuousCreateProgramParams): Promise<Program>;
  /** 手动触发一轮；requestId 幂等，重复触发不得创建第二个 Cycle。 */
  runNow(params: ContinuousRunNowParams): Promise<Cycle>;
  /** 本轮结束后暂停；不取消正在执行的候选。 */
  pauseProgram(params: ContinuousPauseProgramParams): Promise<Program>;
  /** 显式恢复（paused/failed）；suspended 资源暂停必须走继续确认，不走本命令。 */
  resumeProgram(params: ContinuousResumeProgramParams): Promise<Program>;
  /** 立即停止本轮：先撤销写入/请求许可，再取消并等待停止；必须携带当前 lease epoch。 */
  stopCurrentCycle(params: ContinuousStopCurrentCycleParams): Promise<Cycle>;
  /** 回答 Decision；version 防覆盖，resolution 只影响未来 Cycle（§8）。 */
  resolveDecision(params: ContinuousResolveDecisionParams): Promise<void>;
  /** 不授权实施；不自动扩大 forbidden 范围。 */
  dismissDecision(params: ContinuousDismissDecisionParams): Promise<void>;
  /** 归档前必须没有主动执行；不级联清除审计历史。 */
  archiveProgram(params: ContinuousArchiveProgramParams): Promise<void>;
  // ── CT-08 additive（协议小版本 1）：继续确认的回答 ──
  /**
   * 回答资源继续确认（§6.1 四选项）：version 防重复扩额；continue 类回答经 supervisor
   * 同 Cycle/Run 恢复，end_cycle 走立即停止链结算 cancelled 并保留已验证提交。
   */
  resolveContinuation(
    params: ContinuousResolveContinuationParams,
  ): Promise<ContinuousResolveContinuationResult>;
}

// ── CT-08 查询面（max-public-methods 拆分：命令面与查询面分接口，一个实现类同实现两者）──

/**
 * Continuous 查询面：与 IContinuousService（命令面）同一注册服务实现的另一半。
 * 两者都是快照读——UI 唯一事实来源，回答“现在是什么”，不承载状态迁移。
 */
export interface IContinuousQueryService {
  /** 创建授权表单的可用模板目录（版本化注册表经 Host 注入）。 */
  listTemplates(params: ContinuousTemplatesParams): Promise<ContinuousTemplatesResult>;
  /** Program 详情页唯一读面（§12）；UI 只消费该快照，不在本地另建接受队列。 */
  programDetail(params: ContinuousProgramDetailParams): Promise<ContinuousProgramDetailResult>;
}

// 同名 interface + const（类型与运行时描述符共用一个名字，offPeakTask 同款范式）：
// Host 侧 services.register(IContinuousService, implementation)；renderer 侧
// ProxyChannel.toService(IContinuousService.channelName)。channel 名在 @zcode/shared
// ServiceChannels.Continuous（"continuous"）。描述符类型用 Facade（命令面 + 查询面）——
// 一个 channel 一个实现类（ContinuousCommandService 同时实现两半）。
export const IContinuousService = createServiceDescriptor<IContinuousServiceFacade>(
  ServiceChannels.Continuous,
);

/** RPC 注册形状：命令面 + 查询面（一个 channel、一个实现类）。 */
export type IContinuousServiceFacade = IContinuousService & IContinuousQueryService;
