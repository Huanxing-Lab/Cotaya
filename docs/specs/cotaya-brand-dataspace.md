# 规格 cotaya-brand-dataspace：数据目录 ~/.cotaya 与 Cotaya 品牌

| 项       | 值                                                     |
| -------- | ------------------------------------------------------ |
| 状态     | 已与用户对齐（2026-10-04），规则先于实现（本文即规格） |
| 分支     | `feature/cotaya-brand`                                 |
| 日期     | 2026-10-04                                             |
| 行号基准 | 本规格撰写时的工作区（见各 `path:line` 引用）          |

---

## 1. 背景与目标

本机同时存在生产 ZCode 安装与 Cotaya fork 开发，两者共享 `~/.zcode`：供应商配置
（`~/.zcode/v2/provider_config.json`）、CLI 会话库（`~/.zcode/cli/db/db.sqlite`，
实测 850MB）、任务索引（`~/.zcode/v2/tasks-index.sqlite`）互相污染。Cotaya 作为独立
商业产品（见 `UPSTREAM-SYNC.md:3`）需要自有的数据根与用户可见品牌。

本次改动两条线：

1. **数据目录**：home 语义的数据根从 `~/.zcode` 改为 `~/.cotaya`，**不迁移旧数据**
   （全新开始——隔离生产数据正是目的）。
2. **品牌**：用户可见层 ZCode → Cotaya（UI 文案、app 身份、CLI 命令名、URL scheme）。

## 2. 产品规则

### 2.1 数据根

- 主数据根目录名为 `.cotaya`：`{dataBaseDir}/.cotaya`，其下沿用现有布局
  （`v2/`、`cli/`、`computer-use/`、`workspace/`、`server/`、`skills/` 等）。
- `dataBaseDir` 决策链不变：`setDataBaseDir()` > `ZCODE_DATA_BASE_DIR` env >
  `homedir()`（`packages/services/src/paths.ts:34`）。`ZCODE_DATA_BASE_DIR` 语义
  仍是"数据根的**父**目录"。
- `ZCODE_HOME` / `ZCODE_STORAGE_DIR` / `ZCODE_SESSION_DB_PATH` 等 env **名称与语义
  均不变**，只是默认回退值里的 `~/.zcode` 换成 `~/.cotaya`（`services/src/node.ts:1808`、
  `desktop/src/main/desktopRuntimeEnv.ts:498`、`apps/zcode-cli/packages/cli/src/env.ts`）。
- beta 存储根 `~/.zcode-beta` → `~/.cotaya-beta`；dev 数据根（mise）`~/.zcode-dev-home`
  → `~/.cotaya-dev-home`。
- **不做数据迁移**：`~/.zcode` 里的旧数据（生产 ZCode 的）保持原样、互不读写。

### 2.2 项目级 `.zcode/` 目录保持不变

`<project>/.zcode/`（MCP/hooks 的 workspace 配置、`.zcode/plans`、`.zcode/workflows`、
`.zcode/agents` 等，约 20 处代码引用）**继续叫 `.zcode`**：这是与上游共享的公开约定，
保持零行为分叉。区分标准：拼接在 `homedir()`/`dataBaseDir` 下的 `.zcode` 是 home 语义
（改），拼接在 workspace/project 路径下的 `.zcode` 是项目语义（不改）。

### 2.3 品牌身份

| 项                   | 值                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 展示名（production） | `Cotaya`（Preview: `Cotaya Preview`，dev 运行时名 `Cotaya Dev`）                                                                                                                                               |
| appId（production）  | `dev.cotaya.app`（preview: `dev.cotaya.app.preview`）                                                                                                                                                          |
| Windows dev AUMID    | `cn.cotaya.app`（原 `cn.aminer.zcode`）                                                                                                                                                                        |
| Linux 可执行/包名    | `cotaya` / `cotaya-preview`                                                                                                                                                                                    |
| CLI bin 命令         | `cotaya`（`apps/zcode-cli/packages/cli/package.json` 与 `packages/zcode-server-cli/package.json`；发行包 installer 写入的 wrapper 同名）                                                                       |
| URL scheme           | `cotaya://`（媒体 `cotaya-media://`、浏览器恢复 `cotaya-browser-restore://`）。**例外**：OAuth 回调 `zcode://oauth/callback` 保留，应用并列注册 `cotaya` + `zcode` 两个 scheme 并同时接受解析（见 2.4 开放项） |
| UI 文案              | 所有用户可见 "ZCode" 字符串 → "Cotaya"                                                                                                                                                                         |

### 2.4 明确不动（内部机械命名）

以下属于内部实现命名，改动的爆炸半径远超品牌收益且摧毁上游合并能力
（`UPSTREAM-SYNC.md:99-141`），**本次一律保留**：

- npm scope `@zcode/*`（30 个包、3300+ import、117 处依赖声明）
- `ZCODE_*` 环境变量前缀（54 个活跃 key）与 `__ZCODE_*__` 编译期宏（19 个）
- `window.zcode` preload 桥（`packages/desktop/src/preload/index.ts:247`）及其类型声明
- `zcode:*` IPC 通道名、`"ZCode Protocol/1"` wire header、`zcode-protocol`(-v4) 目录名
- 内部标识符（`zcodeAgent`、`ZCodeCopy`、`getZCodeCopy`、`useZCodeIntl`、
  `toggleZCodeStdioTap` i18n key 等）
- 构建产物名与发行布局：`zcode.cjs`（桌面按资源路径 spawn）、`bin/zcode.mjs`、
  `dist/zcode/`、`zcode-<version>.tar.gz`、`pnpm build:zcode` 脚本名
- `config/provider/zcode-builtin.json` 资产名与 CDN 缓存逻辑
- cua helper bundle id（`dev.zcode.cua-helper`，牵连签名体系，后续单独评估）
- electron-builder homepage（暂留原值，待 Cotaya 官网确定后更新——不编造 URL）

**实现期补充的保留项（指向 z.ai 上游基础设施或历史数据的名称，语义仍准确）**：

- OAuth redirectUri `zcode://oauth/callback` 与配套 client_id——在 z.ai/bigmodel 服务端
  注册，切换即断登录；应用侧双 scheme 注册 + 双 scheme 解析兜底
  （`desktopDeepLinkUrl.ts`、`desktopOAuthDeepLink.ts`、`desktopLinuxDeepLinkRegistration.ts`）。
  **开放项**：Cotaya 自有 client 注册完成后改为单 `cotaya://` 并下线 `zcode` scheme。
- 设置项标题 "ZCode Endpoint"、"ZCode Built-in" provider 目录名、`zcode.z.ai` 域名、
  "ZCode Computer Use" helper 权限文案——均指向 z.ai 后端/内置服务本体。
- `mcpUserDirectory/legacy.ts` 读取的 `Application Support/ZCode` 等旧版路径——语义就是
  导入历史数据。

## 3. 状态所有者

- **路径唯一权威**：`packages/services/src/paths.ts` 的 `getZCodeDataRootDir()`
  （32 个消费文件经它取 v2 数据面）；CLI 侧默认值权威是
  `apps/zcode-cli/packages/contracts/src/config/index.ts:302-303`。散落的
  `join(homedir(), ".zcode", ...)` 是对同一事实的局部复制，本次以字面量替换对齐，
  不新增第二条解析路径。
- **品牌身份唯一权威**：`packages/desktop/scripts/desktop-product-identity.mjs`
  （appId/productName/可执行名/AUMID 一处定义，构建与运行时都从这里取）。
- **运行时 app 名**：`packages/desktop/src/main/desktopRuntimeEnv.ts:63` →
  `app.setName()`（`main/index.ts:261`）。

## 4. 接口清单（改动面）

全部为局部字面量/常量替换，无逻辑变化：

- **services**：`paths.ts:44,232-233`（中心收口 + copyDataDirectory）；散落约 35 处
  （deviceMid、telemetryCore、settingService、skillsService、skillSync、settingsSync×9、
  hooks、commands、mcpSync、pluginSync、subagentStorage、subagentsService、
  zcodeAgentService、zcodeTaskServiceAdapter、modelTrajectoryFileTail、
  providerRuntimeResolver、node.ts:1076,1808、storage/adapters/rootsResolver.ts:9）。
- **desktop**：`main/index.ts:532`、两个 bootstrap 文件、`exportLogs.ts`（6 处，含归档
  前缀）、`desktopRuntimeEnv.ts:498`、`mcpUserDirectory`（segments 3 处）、
  `desktopCommandHandlers.ts:96` 文案。`mcpUserDirectory/legacy.ts` 不动（读的就是旧版
  历史路径）。
- **zcode-server-cli**：`src/runtime/paths.ts:24-26,82`。
- **apps/zcode-cli**：`adapters`（session-store/paths、shared-credentials、cli-device-mid、
  context、execution-utils、logging、runner-debug、workspace-hook-trust-store、
  workflow/index、skills/roots、commands/roots、file-config.adapter）、`cli`
  （clipboard-image、sea-runtime-tools、env.ts beta 根、provider-runtime-env）、
  `bootstrap`（create-app mailbox、script-workflow-utils:174、script-workflow-tool-port:318）、
  `telemetry/src/bootstrap.ts:228`、`debug/server/sources.ts`、
  `contracts/src/config/index.ts:302-303`。
- **品牌**：`desktop-product-identity.mjs`、desktop 与根 package.json 的产品名字段、
  bin 名 ×2、electron-builder（schemes、Linux icon、install manifest）、UI locales
  （约 190 条）+ UI 硬编码（约 58 处）+ 2 个 `index.html` 标题、CLI i18n（约 13 行）、
  README ×2、SKILL.md:1503（home 级 workflows 路径）。
- **脚本/配置**：`scripts/zcode-distribution/installer.mjs:8`、`scripts/dev/zcode-stdio-tap.mjs:56`、
  `scripts/zcode-distribution-smoke.mjs`、`apps/zcode-cli/scripts/shadow-replay.mjs:46`、
  `mise.toml:20`。

## 5. 验收场景

1. 不设 `ZCODE_DATA_BASE_DIR` 启动 `pnpm dev:desktop`：新建 `~/.cotaya/`，且
   `~/.zcode` 各路径 mtime 无变化（生产数据零写入）。
2. CLI 会话库落在 `~/.cotaya/cli/db/db.sqlite`；`~/.zcode/cli/db/db.sqlite` 不被打开。
3. 项目级配置仍生效：`.zcode/config.json`（MCP）、`.zcode/plans`、`.zcode/workflows`
   照常读写。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
5. UI 无 "ZCode" 残留：locales 与 UI 源码 grep 仅剩协议/内部标识符等 2.4 清单项。
6. scheme 一致性：electron-builder 注册的 scheme 与代码内引用同为 `cotaya://` 系前缀。
7. 回归测试：`getZCodeDataRootDir()` 以 `.cotaya` 结尾；项目级发现逻辑仍认 `.zcode`。

## 6. 上游同步影响（五问）

1. **能否实现为新模块？** 品牌身份已有收口文件（`desktop-product-identity.mjs`），
   改一处即可。数据目录名是散布在路径构造点的事实，没有可插入的运行时 seam——
   `ZCODE_DATA_BASE_DIR` env 覆盖机制保留，但"默认目录名"必须落在每个构造点。
2. **能否引入 adapter/hook？** 环境变量重定向（`ZCODE_DATA_BASE_DIR`）即是无侵入
   adapter，已保留；改名是产品级决策，不能用"所有用户都得设 env"来实现。
3. **集成点能否更小？** `services/paths.ts` 单点覆盖 32 个消费文件；其余每处为
   1 行字面量替换，无逻辑变化。
4. **产品逻辑能否留在这个上游文件之外？** 决策（目录名、品牌、不动清单）全部落在
   本规格；代码补丁纯机械，可独立 review。
5. **这次修改会不会让下一次上游 merge 不必要地更难？** 约 100 个上游文件各 1-2 行。
   冲突解法统一：在冲突块**重贴** `.zcode` → `.cotaya` 替换（home 语义行）。核对命令：
   `grep -rn '"\.zcode"' --include='*.ts' packages apps | grep -v node_modules`，
   逐行判断是 home 语义（应为 `.cotaya`）还是项目语义（保持 `.zcode`，见 2.2）。

**移除性**：反向替换（`.cotaya` → `.zcode`、`Cotaya` → `ZCode`）即可整体恢复，无状态、
无格式、无协议残留。

### 撰写自查（对照已对齐的产品规则 2.1-2.4）

- [x] `.cotaya` 主数据根、不迁移旧数据（2.1）
- [x] 项目级 `.zcode/` 保持（2.2，用户已确认）
- [x] 全面品牌替换含 CLI 命令名与 URL scheme（2.3，用户已确认）
- [x] 内部机械命名不动清单显式列出（2.4）
