# Continuous 发布记录：平台证据、默认关闭与回滚

| 项目 | 内容                                                              |
| ---- | ----------------------------------------------------------------- |
| 状态 | CT-10 记录；功能默认关闭（未装配即关闭，规格 §13）                |
| 规格 | [continuous.md](../specs/continuous.md)（§13 平台能力与发布条件） |
| 测试 | [testing/continuous.md](../testing/continuous.md)（§4 步骤 F/G）  |
| 日期 | 2026-10-05                                                        |

本文是 Continuous 的发布面事实记录：逐平台执行能力与证据出处、默认关闭到开启的路径、
以及有序回滚步骤。它与 shared 的已验证平台登记表
（`packages/shared/src/continuous-platform-protocol.ts` 的 `CONTINUOUS_VERIFIED_PLATFORM_EXECUTION`）
对应：登记表是代码侧唯一事实源，本文是证据与流程侧的展开；追加平台登记必须同时在本表
补该平台 suite 证据，不允许凭代码审查登记。

## 1. 逐平台证据表

| platformKey    | 模式           | 证据（platform suite 实测）                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 未验证范围                                                          |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `darwin-arm64` | `autonomous`   | `node scripts/test-continuous.mjs --suite platform`（2026-10-05，Node 25.8.0）：路径（空格/Unicode/大小写按真实 FS 敏感性折叠/symlink 逃逸拒绝/traversal 拒绝）、进程树取消（kill(-pgid) 三层树整棵消失）、worktree（含空格/Unicode 仓库与受管根、幂等复用）、SQL（含空格/Unicode db 路径上复合 FK/部分唯一索引/租约 epoch 跨重开单调）、命令限制（argv 逐字节直传不经 shell；未声明变体拒绝；observe_only 全拒）。证据 JSON 随每次 suite 执行写入 `os.tmpdir()/continuous-ct10-*` 并打印路径 | 打包形态（dmg/app）未测；darwin-x64 未测                            |
| `win32-*`      | `observe_only` | 无。本仓库执行环境无 Windows 机器，`--suite platform` 未在该平台运行过。评估函数 fail closed：`platform_not_verified`                                                                                                                                                                                                                                                                                                                                                                         | 全部（路径/进程树取消 taskkill 分支/worktree/SQL/命令限制均未实测） |
| `linux-*`      | `observe_only` | 无。同上，无 Linux 机器。                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 全部                                                                |

observe_only 平台的行为（规格 §13，服务与执行策略两层强制）：

- supervisor 启动门：`runNow`/周期启动/恢复重提交/继续挂起轮全部结构化拒绝
  `platform_execution_not_supported`，拒绝先于任何 workspace/提交动作（无文件与执行副作用）；
- 执行策略：一切写入/删除/声明测试命令/本地提交拒绝 `platform_read_only`（连 builder 也只读）；
  读与观察放行；
- 观察读面（snapshot/programDetail/队列/历史）不受影响；UI 经 capability.platform 解释
  「本平台仅提供观察、不开放自动实施」（稳定 test id `continuous-platform-read-only`）。

## 2. 默认关闭与开启路径

当前状态：**默认关闭，且尚未开启**。关闭的机制与开启所需步骤：

1. 关闭机制（已在代码中）：Host 未装配 `ServiceChannels.Continuous` → renderer
   `accessor.continuousService` 缺席 → Automations 页只有「自动化/工作流」两个 tab、
   ContinuousSection 不挂载不查询（E-24/E-27 的真实产品行为，CT-09 e2e 与 CT-10 regression
   均有 production build 探针证据）；scheduler 对缺表旧库返回空查询、Host 唤醒处理器缺席时
   wake 回执失败并重发（无业务副作用）；CLI 侧 `continuousManagedCycles.enabled` 未开时
   `continuousManagedCycleExecution` 不暴露，v4 命令面回答能力不支持。
2. 开启前置（装配清单，CT-08/09 记录的已知边界——尚未实施）：
   - Host 侧构造 Continuous 栈：tasks-index 存储上的 repository、supervisor/recovery/
     预算账本/健康监控、模板来源（bootstrap `continuous-templates` 注册表）；
   - Host 注册 `ContinuousCommandService` 到 `ServiceChannels.Continuous`（命令面 + 查询面
     单实现类），并注册 `continuousWakeRouter` 处理器接 scheduler 唤醒；
   - CLI 侧执行端口经 v4 `continuousManagedCycle` 桥接（`continuousManagedCycles.enabled`
     开 + Host 按 runId 登记预算/决策闸门）；
   - 装配时经 `assessContinuousPlatformExecution({platform, arch})` 评估平台模式并注入
     supervisor 启动门与执行策略（本表第 1 节的登记表为唯一事实源）；
   - capability/programDetail 读面走通后，按 CT-09 runner 的 capability 预检从真实 UI 驱动
     E-01…E-20/E-29…E-34（当前全部 blocked 的原因即此装配缺席，见 CT-09 记录）。
3. 开启条件（测试文档 §4 步骤 G release gate）：核心 U/I/R/E 真实通过、普通功能回归通过、
   发布平台证据齐全（本表）、live 验收单独完成（无测试身份凭据时 blocked，不能模拟通过）、
   生产 build 无测试故障接口（E-28）。核心失败或必需 live blocked 时，自主实施 flag 保持
   关闭，可交付明确标识的只读观察能力。

## 3. 回滚顺序（有序执行；不得靠删表回滚）

1. 停止调度与唤醒：还原 scheduler 的 continuous wake 接线（`packages/desktop/src/scheduler/
continuousWake.ts` 接入点）与 Host 唤醒处理器注册——无新唤醒，重复 wake 由 trigger key
   UNIQUE 幂等吸收。
2. 撤销新请求与新写入：立即停止在飞 Cycle（`stopCurrentCycle`：撤销准入 → cancel → 等待
   停止），CLI 侧关闭 `continuousManagedCycles.enabled`（模型准入/执行端口拒绝新调用）。
3. 等待停止或保存 interrupted：正常退出走 `interruptCyclesForShutdown`
   （suspendAtSafeBoundary，保存 interrupted、lease 保留持久化占用）；强制退出依赖下次
   启动的恢复核对（先未结束 Cycle、后到期 Program）。
4. 回退入口：隐藏/还原 Continuous tab（accessor 可选字段缺席即隐藏）、还原
   `ServiceChannels.Continuous` 注册；旧产品入口（普通 Workflow/Automation/Goal/权限确认）
   不受影响（E-26 回归）。
5. 保留 DB、worktree、用户改动和历史：不删除 `continuous_*` 表、Program worktree
   （`~/.cotaya/continuous-worktrees/<program-id>`）、已验证提交与审计事件；旧版本忽略
   新表；unknown 预留不清零。

停止证明的取证面：E-19/E-11/R-06/R-09 用例记录的「旧 epoch 副作用拒绝、stop+
waitForQuiescence 后才接管、退出保存 interrupted」；regression suite 的 E-27 用例重跑
recovery suite 并核对本文回滚步骤在场。
