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

| platformKey    | 模式           | 证据（platform suite 实测）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 未验证范围                                                                                                                                               |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `darwin-arm64` | `autonomous`   | `node scripts/test-continuous.mjs --suite platform`（2026-10-05 首测；2026-10-06 CT-16 固定运行时复核，Node 25.8.0，均 exit 0）：路径（空格/Unicode/大小写按真实 FS 敏感性折叠/symlink 逃逸拒绝/traversal 拒绝）、进程树取消（kill(-pgid) 三层树整棵消失）、worktree（含空格/Unicode 仓库与受管根、幂等复用）、SQL（含空格/Unicode db 路径上复合 FK/部分唯一索引/租约 epoch 跨重开单调）、命令限制（argv 逐字节直传不经 shell；未声明变体拒绝；observe_only 全拒）。证据 JSON 随每次 suite 执行写入 `os.tmpdir()/continuous-ct10-*` 并打印路径。CT-16 另在 electron-builder unpacked `.app`（真实打包形态）内真实通过暂停/退出/恢复/停止/本地提交边界与生产无测试桥（packaged suite，见测试文档「本次实际结果」） | dmg/zip 安装器分发形态未测（--dir unpacked .app 已测）；darwin-x64 未测；Node 版本以 mise.toml `>=24` 下限为准（本机无 mise，系统 Node 25.8.0 满足下限） |
| `win32-*`      | `observe_only` | 无。本仓库执行环境无 Windows 机器，`--suite platform` 未在该平台运行过。评估函数 fail closed：`platform_not_verified`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 全部（路径/进程树取消 taskkill 分支/worktree/SQL/命令限制均未实测）                                                                                      |
| `linux-*`      | `observe_only` | 无。同上，无 Linux 机器。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 全部                                                                                                                                                     |

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
2. 开启前置（装配清单，CT-08/09 记录的已知边界——CT-12 已实施 Host 侧装配）：
   - Host 侧构造 Continuous 栈：tasks-index 存储上的 repository、supervisor/recovery/
     预算账本/健康监控、模板来源（shared `continuous-templates` 注册表）——**已实施**
     （`ZCODE_CONTINUOUS_HOST_ENABLED=1` 开启，默认关闭）；
   - Host 注册 `ContinuousCommandService` 到 `ServiceChannels.Continuous`（命令面 + 查询面
     单实现类），并注册 `continuousWakeRouter` 处理器接 scheduler 唤醒——**已实施**；
   - CLI 侧执行端口经 v4 `continuousManagedCycle` 桥接（`continuousManagedCycles.enabled`
     开 + Host 按 runId 登记预算/决策闸门）——**已实施**（登记经专用命令
     `continuousRegisterManagedRun`，CLI 侧对未登记 run fail closed）；
   - 装配时经 `assessContinuousPlatformExecution({platform, arch})` 评估平台模式并注入
     supervisor 启动门与执行策略（本表第 1 节的登记表为唯一事实源）——既有（CT-10）；
   - Host 启动核对（`recoverAllOnStartup`：重启先核对未结束 Cycle 再调度未来轮，D2）与
     打包形态验收——**已实施**（CT-16；packaged suite 在 electron-builder unpacked
     `.app` 内真实通过）。
3. 开启条件（测试文档 §4 步骤 G release gate）：核心 U/I/R/E 真实通过、普通功能回归通过、
   发布平台证据齐全（本表）、live 验收单独完成（无测试身份凭据时 blocked，不能模拟通过）、
   生产 build 无测试故障接口（E-28）。核心失败或必需 live blocked 时，自主实施 flag 保持
   关闭，可交付明确标识的只读观察能力。
   当前状态（CT-16 后）：本 ticket 实测通过 packaged（真实打包 app 9 用例）、platform
   （darwin-arm64）、services/bootstrap 包级全量与 host 项目类型检查；unit/integration/
   recovery/e2e/regression 由统一 runner 在门禁复跑（见测试文档「本次实际结果」的分工
   说明）；live blocked（无测试凭据）与手机链路（E-21，外部 relay）未完成——
   **自主实施 flag 保持关闭**。

## 2.1 遗留问题修复进度（2026-10-05）

本次修复分支为 `codex/continuous-release-gaps`，基于 GLM 的 `feature/continuous-mvp`。
**源代码接缝已经修复，完整产品仍未达到开启条件。** 后续工作与验收见
[tickets/continuous-release-gaps.md](../tickets/continuous-release-gaps.md)。

| 原问题                                    | 本次处理                                                                                                                                                                                                                                                                                                              | 仍需完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CT-02 策略没有实际执行点                  | 受管 actor 的实际文件/执行端口和模板 `world` 端口均包装；角色、候选路径、符号链接及命令检查进入 IO 调用路径；child runtime 不再用原始端口覆盖检查端口。未支持的递归搜索、后台工具、任意 shell/MCP 和未证明隔离的命令明确拒绝。                                                                                        | CT-11 已落地（2026-10-05，见 tickets/records/CT-11.md）：受限递归搜索、fd 级 symlink 竞态收敛、受控 argv 测试执行（darwin seatbelt 自证隔离）、工具端口证据与可信提交端口（模板 v2 移除 world.run git add/commit）、变更量上限同轮挂起。完整产品装配与真实 E2E 仍待 CT-12…16。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 预算拒绝使 Run errored，继续后循环确认    | 配置暂停端口的预算闸门释放并发席位并等待；用户授权后同一 acquire 重新预留，不增加 provider 尝试次数。真实 SQLite + DWF 引擎测试证明 Run 保持 running，并由同一 actor 完成。停止信号可以取消等待。旧 errored Run 明确拒绝继续；已完成 Run 只结算。Host 先保存 running，再唤醒 CLI。                                    | CT-13 已落地（2026-10-05，见 tickets/records/CT-13.md）：预留/结算/拒绝通知的传输严格校验（身份/leaseEpoch/价格版本/请求键幂等）、拒绝携带真实 limitKind 与已用/预留/unknown/限额/需求、并发超限合并一条确认、retry_limit 继续授权语义、回答幂等（异答/旧 version 拒绝）、旧 errored 轮显示不可恢复并可结束旧轮/显式新开轮（账本与历史保留）。真实 UI 的产品入口呈现归 CT-15。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 探活没有调用者，也没有真实证据            | supervisor 的同一监督循环每 15 秒探测；CLI 从 journal 的 sequence/timeCreated 读真实动作时间，不刷新查询时间。全部运行节点都具有落库 backoff 原因与期限才承认正常等待。有效时间/卡死触发同轮继续确认，不调用 stop；失联保存 interrupted。健康字段采用 running + leaseEpoch 条件原子更新，不能覆盖取消状态或报告游标。 | CT-14 已落地（2026-10-06，见 tickets/records/CT-14.md）：测试/工具操作的实际等待登记（owner/run/epoch、原因、真实期限、取消/完成通知；过期与旧 epoch 移除）；登记与 journal backoff 共同按运行节点覆盖判定整轮 normal_wait（任一 actor 工作仍计有效时间）；读操作（inspect/inspectHealth/readReports）通信期限（结构化 execution_unreachable，消息带期限事实）；失联冻结不发 wire 挂起、保存 interrupted+证据事件、不覆盖新 epoch/游标。真实 UI 的一小时与 hang 场景归 CT-15。                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 预算登记与本地准入没有装配                | 产品 submit/resume/continue 在预算（含暂停与本地探针）、决策、IO 登记缺失或 worktree 不符时拒绝；预算和 IO 可使用执行适配器同一 `waitForAdmission`。新增独立 interrupt 命令，退出取消引擎并等待收尾，保留 interrupted 恢复语义；已暂停轮也会结束进程内执行并保留确认。                                                | CT-12 已落地（2026-10-05，见 tickets/records/CT-12.md）：Host 装配（env 门）+ 专用登记命令 + CLI→Host 预留/结算/拒绝通知/决策请求 + 能力协商（含 interrupt）+ 退出/恢复重建登记。CT-13 已落地（2026-10-05，见 tickets/records/CT-13.md）：真实预算通信的拒绝观测细节与旧 errored 轮产品入口（详见上行）。CT-15（2026-10-06）在真实桌面链路暴露并修复 5 处装配缺陷（session/create 外部 id 守卫、registration store 漏传、金丝雀 Electron 形态悬挂、DWF actor 会话 task link 的父会话 FK、shutdown interrupt 顺序）；e2e suite 真实通过（9 passed/21 如实 blocked，见 tickets/records/CT-15.md）。CT-16（2026-10-06，见 tickets/records/CT-16.md）：打包形态（electron-builder unpacked .app）内暂停/退出/恢复/停止/本地提交边界与生产无测试桥真实通过（packaged suite 9 passed/0 blocked）；打包链路暴露并修复重启恢复缺陷 3 处（Host 启动核对未接线、wire 会话路由实例内丢失、租约接管 stop 毒化同 Run 恢复）；live 如实 blocked（无测试凭据）。 |
| 固定运行时、安装包与真实模型验收（CT-16） | 按 mise.toml Node `>=24` 下限复跑类型检查/Lint/全部自动 suite 并记录实际 Node 版本；真实打包 app 内重复暂停/退出/恢复/停止/本地提交；其他平台逐一真实机器证据才登记 autonomous；live 走显式 `--allow-live`；生产 build 无测试故障接口（E-28）。                                                                       | **已完成（2026-10-06，见 tickets/records/CT-16.md 与测试文档「本次实际结果」）**：Node 25.8.0（满足 mise.toml `>=24` 下限；本机无 mise）下 packaged suite 真实通过（9 passed/0 failed/0 blocked）、platform suite（darwin-arm64）exit 0、live `--allow-live` 如实 blocked（无 ZCODE_E2E_LIVE_PROVIDER_KEY，退出码 0、状态 blocked，§10 语义）；regression/e2e 等其余 suite 由统一 runner 复跑（见测试文档）。**自主实施 flag 保持关闭**：live 验收 blocked（无真实模型证据）与手机链路（E-21，外部 relay）未完成，release gate 未满足。                                                                                                                                                                                                                                                                                                                                                                                                           |

Node 版本口径（CT-16 更正）：`mise.toml` 为 Node `>=24` 下限（`e941526` 放开），非固定
24.14.0；本机未安装 mise，实际使用系统 Node 25.8.0（满足下限，pnpm 10.33.2 与 mise 一致）。
上表各 suite 均在该版本执行并写入 results.json 的 `nodeVersion`。

（CT-12 阶段的中间验证记录——「e2e 30 场景 blocked、regression E-28 断言失败」等——已由
CT-15/CT-16 的真实结果取代，历史原文见 git 历史；当前结论一律以测试文档「本次实际结果」
与各 tickets/records/CT-\*.md 为准。）

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
