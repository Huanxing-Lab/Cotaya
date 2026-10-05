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

1. 关闭机制（已在代码中）：Host 未装配 `ServiceChannels.Continuous` → renderer capability
   探测无响应（未注册 channel 的请求被 ChannelServer 排队挂起，availability 停留
   checking）→ Automations 页只有「自动化/工作流」两个 tab、ContinuousSection 不挂载不查询
   （E-24/E-27 的真实产品行为；评审修复：原描述「accessor.continuousService 缺席即隐藏」
   不成立——RPC accessor 的 lazy getter 恒返回 ProxyChannel 代理，tab 门已改为 capability
   探测驱动）；scheduler 对缺表旧库返回空查询、Host 唤醒处理器缺席时
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

## 2.1 遗留问题修复进度（2026-10-05）

本次修复分支为 `codex/continuous-release-gaps`，基于 GLM 的 `feature/continuous-mvp`。
**源代码接缝已经修复，完整产品仍未达到开启条件。** 后续工作与验收见
[tickets/continuous-release-gaps.md](../tickets/continuous-release-gaps.md)。

| 原问题                                 | 本次处理                                                                                                                                                                                                                                                                                                              | 仍需完成                                                                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CT-02 策略没有实际执行点               | 受管 actor 的实际文件/执行端口和模板 `world` 端口均包装；角色、候选路径、符号链接及命令检查进入 IO 调用路径；child runtime 不再用原始端口覆盖检查端口。未支持的递归搜索、后台工具、任意 shell/MCP 和未证明隔离的命令明确拒绝。                                                                                        | CT-11 已落地（2026-10-05，见 tickets/records/CT-11.md）：受限递归搜索、fd 级 symlink 竞态收敛、受控 argv 测试执行（darwin seatbelt 自证隔离）、工具端口证据与可信提交端口（模板 v2 移除 world.run git add/commit）、变更量上限同轮挂起。完整产品装配与真实 E2E 仍待 CT-12…16。 |
| 预算拒绝使 Run errored，继续后循环确认 | 配置暂停端口的预算闸门释放并发席位并等待；用户授权后同一 acquire 重新预留，不增加 provider 尝试次数。真实 SQLite + DWF 引擎测试证明 Run 保持 running，并由同一 actor 完成。停止信号可以取消等待。旧 errored Run 明确拒绝继续；已完成 Run 只结算。Host 先保存 running，再唤醒 CLI。                                    | CT-12/13：Host 预算预留、拒绝原因、确认持久化、授权结果经真实通信装配；旧失败轮提供结束并显式新开轮的产品入口。                                                                                                                                                                |
| 探活没有调用者，也没有真实证据         | supervisor 的同一监督循环每 15 秒探测；CLI 从 journal 的 sequence/timeCreated 读真实动作时间，不刷新查询时间。全部运行节点都具有落库 backoff 原因与期限才承认正常等待。有效时间/卡死触发同轮继续确认，不调用 stop；失联保存 interrupted。健康字段采用 running + leaseEpoch 条件原子更新，不能覆盖取消状态或报告游标。 | CT-14：覆盖声明测试、工具和其他真实长等待的可取消操作登记；失联探测有界响应；真实 UI 的一小时与 hang 场景。                                                                                                                                                                    |
| 预算登记与本地准入没有装配             | 产品 submit/resume/continue 在预算（含暂停与本地探针）、决策、IO 登记缺失或 worktree 不符时拒绝；预算和 IO 可使用执行适配器同一 `waitForAdmission`。新增独立 interrupt 命令，退出取消引擎并等待收尾，保留 interrupted 恢复语义；已暂停轮也会结束进程内执行并保留确认。                                                | CT-12/13：window-scoped Local Host 的真实登记和启动/恢复/退出装配；登记检查不能替代这项工作。                                                                                                                                                                                  |

本次验证使用 Node 25.8.0；仓库要求 Node 24.14.0，当前机器没有 mise 与对应安装。
因此下面结果不替代固定 Node 版本或打包平台验收：

- 单元、集成、恢复、当前 macOS 平台 suite 与根/CLI 类型检查、Lint：见测试文档的本次记录。
- 真实 Electron E2E runner 已运行并构建 CLI/Desktop：30 个场景 blocked、0 passed、0 failed。
  实际 capability 预检停在窗口未就绪，不能声称观察到了 Continuous tab 的隐藏。
  源码另确认 Host 尚无 Continuous 装配；多数 E 用例当前直接报告 blocked，还没有真实交互实现。
- regression 实测失败：E-26/E-27 通过；E-28 production 无法打开 Automations 页面，断言失败。case 报告漏记该失败，但统一 runner 正确返回 failed/exit 1。修复导航及报告归 CT-15。
- 自主实施仍默认关闭；手机、真实模型、其他平台与安装包未在本次验收。

## 3. 回滚顺序（有序执行；不得靠删表回滚）

1. 停止调度与唤醒：还原 scheduler 的 continuous wake 接线（`packages/desktop/src/scheduler/
continuousWake.ts` 接入点）与 Host 唤醒处理器注册——无新唤醒，重复 wake 由 trigger key
   UNIQUE 幂等吸收。
2. 撤销新请求与新写入：立即停止在飞 Cycle（`stopCurrentCycle`：撤销准入 → cancel → 等待
   停止），CLI 侧关闭 `continuousManagedCycles.enabled`（模型准入/执行端口拒绝新调用）。
3. 等待停止或保存 interrupted：正常退出走 `interruptCyclesForShutdown`
   （interrupt：冻结准入、以 interrupted 取消引擎、等待收尾；保存 interrupted、lease 保留持久化占用）；强制退出依赖下次
   启动的恢复核对（先未结束 Cycle、后到期 Program）。
4. 回退入口：隐藏/还原 Continuous tab（capability 探测控制入口；RPC accessor 的 lazy getter 不能作为可用性证明）、还原
   `ServiceChannels.Continuous` 注册；旧产品入口（普通 Workflow/Automation/Goal/权限确认）
   不受影响（E-26 回归）。
5. 保留 DB、worktree、用户改动和历史：不删除 `continuous_*` 表、Program worktree
   （`~/.cotaya/continuous-worktrees/<program-id>`）、已验证提交与审计事件；旧版本忽略
   新表；unknown 预留不清零。

停止证明的取证面：E-19/E-11/R-06/R-09 用例记录的「旧 epoch 副作用拒绝、stop+
waitForQuiescence 后才接管、退出保存 interrupted」；regression suite 的 E-27 用例重跑
recovery suite 并核对本文回滚步骤在场。
