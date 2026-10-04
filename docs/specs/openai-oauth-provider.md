# 规格 openai-oauth-provider：OpenAI OAuth 登录接入

| 项       | 值                                                          |
| -------- | ----------------------------------------------------------- |
| 状态     | 已与用户对齐（2026-10-04），规则先于实现（本文即规格）      |
| 分支     | `feature/openai-oauth-login`                                |
| 日期     | 2026-10-04                                                  |
| 行号基准 | 本规格撰写时的工作区（见各 `path:line` 引用，均为实测行号） |

---

## 1. 背景与目标

Cotaya（ZCode 的商业 fork，见 `UPSTREAM-SYNC.md`）现有登录身份域只有 z.ai
（`zai` ↔ `bigmodel` 互删，`oauthService.ts:102-110`）。本次接入 OpenAI OAuth
登录，与现有 z.ai 登录等价，覆盖 Desktop / CLI / Web 三端，使 OpenAI
（ChatGPT 账号）成为与 z.ai 并列的可切换身份域：

1. **协议**：主流程＝官方 Codex CLI 同款授权码 + PKCE + loopback 回调
   （`http://localhost:1455/auth/callback`，端口 1455 为 OpenAI 端注册固定值）；
   设备码流程为 fallback。
2. **身份域并存**：OpenAI 与 z.ai 是不同身份域，互不删除对方凭据；全局仍是
   单一 `oauth:active_provider` 指针、切换式并存。
3. **模型通道**：`https://chatgpt.com/backend-api/codex`（`api.type=openai-responses`），
   凭据为登录换取的 access_token + `chatgpt-account-id` 头。

真实账号 E2E 由用户手动完成（工作流内无账号凭据，不尝试真实登录）。

## 2. 产品规则

### 2.1 三端登录入口

| 端   | 入口                                                                                                                                                                      | 流程                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 桌面 | Welcome 登录页新增 OpenAI 按钮（`WelcomeScreen.tsx:488-545` 按钮文案/排序处加分支），provider 列表来自 `OAuthService.getProviders()`                                      | loopback 主流程                                        |
| CLI  | `cotaya login openai`（`apps/zcode-cli/packages/cli/src/login-command.ts:16` 参数枚举扩展）+ command center `/login` 新选项（`command-center/login-flow.ts:12-79` items） | loopback 主流程；`--no-browser` 或无浏览器环境走设备码 |
| Web  | 分享页登录入口（`packages/web/src/main.tsx:170` onLogin）新增 openai 选项                                                                                                 | 设备码（浏览器无法监听 localhost loopback）            |

- 三端登录结果写同一套凭据 key（见 2.4），active provider 单指针语义一致。
- **deviation（review 修复补记）**：Web 分享页的 openai 登录入口**暂不支持私有分享
  授权**——服务端分享鉴权只认 zcode JWT，openai 身份（无 zcodejwttoken）登录后
  `getZCodeJwtToken()` 返回 null，私有分享 preview 仍为未认证。分享页登录卡片已
  明示该限制（`ConversationShareLandingPage.tsx` loginOpenAILimitationHint，中英
  双语）；若后续分享服务端支持 openai owner 身份，先在本节补定义再放开文案。
- 桌面与 CLI 的登录按钮/命令文案、图标（`oauthProviderIcon.tsx:5-11`，OpenAI
  图标先放简洁占位 svg，记入 deviations）、i18n（`packages/ui/src/i18n/locales/zh-CN.ts:789-800`
  一带与 en-US 对应处；CLI `apps/zcode-cli/packages/i18n/src/locales/`）同步补齐。

### 2.2 授权流程：loopback 主流程与设备码 fallback

**主流程（授权码 + PKCE + loopback）**，Desktop / CLI 默认：

- `client_id`：`app_EMoamEEZ73f0CkXaXp7hrann`（官方 Codex CLI 公开值；env
  `OPENAI_OAUTH_CLIENT_ID` 可覆盖）。
- authorize：`GET https://auth.openai.com/oauth/authorize`，参数 `client_id`、
  `redirect_uri=http://localhost:1455/auth/callback`（端口 1455 不可改）、
  `response_type=code`、`scope=openid profile email offline_access`、
  `code_challenge_method=S256`、`code_challenge`、`state`（本地随机 32 字节 hex）。
- `code_verifier` 本地随机生成（43-128 字符）。
- 换 token：`POST https://auth.openai.com/oauth/token`，
  `application/x-www-form-urlencoded`：`grant_type=authorization_code`、`code`、
  `redirect_uri`、`client_id`、`code_verifier` →
  `{access_token, refresh_token, id_token, expires_in}`；
  **refresh_token 或 id_token 缺失视为登录失败**。

**fallback（设备码）触发条件**（满足其一即降级，需向用户明示已切换方式）：

1. 1455 端口被占用（loopback server `EADDRINUSE`）；
2. 无浏览器环境（CLI `--no-browser`、打开浏览器失败、headless）；
3. Web 端（浏览器页面无法监听 localhost loopback）。

设备码流程：

- `POST https://auth.openai.com/api/accounts/deviceauth/usercode`，JSON body 仅
  `{client_id}` → `{device_auth_id, user_code, interval?, expires_in?}`。
- 用户打开 `https://auth.openai.com/codex/device` 输入 user_code（客户端展示
  user_code 与该 URL）。
- `POST https://auth.openai.com/api/accounts/deviceauth/token`，JSON body
  `{device_auth_id, user_code}` 按 interval 轮询：403/404＝继续等待、410＝过期
  （失败，允许重试新流程）、2xx＝`{authorization_code, code_verifier}`
  （**verifier 由服务端返回，非本地生成**）。
- 再 `POST oauth/token`（form 同上，`redirect_uri` 参数用
  `https://auth.openai.com/deviceauth/callback`）换 token。

端点常量（authorize/token/设备码/1455 回调）收敛在 shared 新模块；env 覆盖：
`OPENAI_OAUTH_CLIENT_ID`、`OPENAI_CODEX_BASE_URL`（originator/version 指纹头的
env 覆盖见 §2.7 deviation 补记）。

### 2.3 身份域并存：互不删凭据、单一 active provider 指针

- **身份域划分**：`zai` 与 `bigmodel` 同属 z.ai 域（域内互删语义保留）；`openai`
  为独立域。现 `resolveInactiveOAuthProvider`（`oauthService.ts:102-110`）返回
  "对方 provider" 的映射改为**按身份域**：openai → `null`（不删任何 z.ai 域
  凭据）；zai ↔ bigmodel 维持互删。
- `persistOAuthSession`（`oauthService.ts:379-436`）在 `inactiveProvider` 为
  `null` 时天然跳过 `clearProvider`（`:418 if (inactiveProvider)`）——openai
  登录只写 `oauth:openai:*` 与切换 `oauth:active_provider`，不动
  `oauth:zai:* / oauth:bigmodel:* / zcodejwttoken`。
- **active provider 单指针**：`oauth:active_provider`（`oauthCredentialRepo.ts:13`
  key、`:172-180` 写入）仍是全局唯一登录事实源；登录 openai 即写入
  `openai`，登录 z.ai 域 provider 即写回对应值。切换是**覆盖指针**，不是登出对方。
- 切回 z.ai 域：凭据若仍在（token 可能已过期），恢复语义按该域现有规则
  （zcode JWT exp）；openai 域按 2.4 的 token 过期 + refresh 恢复。不做跨域
  静默续期。
- `KNOWN_OAUTH_PROVIDER_IDS`（`oauthCredentialRepo.ts:16`）与
  `PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS`（`providerProvisioningSource.ts:22-31`）
  补 openai key 段（`oauth:openai:*` 白名单 `oauth:openai:*`）。
- `shouldClearZcodeJwtOnLogout`（`oauthCredentialRepo.ts:450-452`）不含 openai：
  openai 无 `zcodejwttoken`，登出不碰共享 JWT。
- **CLI `cotaya logout` 按域清理**（review 修复补记）：按 `oauth:active_provider`
  分域——active=openai 时仅清 `oauth:openai:*` 与指针（对齐 Desktop
  `clearActiveSession` 语义，条件事务守护）；active=zai/bigmodel 或缺省时维持 z.ai
  域清理（zai/bigmodel/zcodejwttoken/standalone coding-plan key），**不删
  `oauth:openai:*`**。JSON 输出的 `provider` 字段反映实际清理的域（`openai`/`zai`）。

### 2.4 token 存储与刷新轮换

- **存储 key**（与现有命名一致，三端同名）：`oauth:openai:access_token`、
  `oauth:openai:refresh_token`、`oauth:openai:user_info`，另需持久化过期时刻
  `oauth:openai:expires_at`（现有 `OAuthTokenSet.expiresAt` 字段
  `shared/src/oauth.ts:133-138` 已有，但 repo 的 `saveTokenSet/loadTokenSet`
  `oauthCredentialRepo.ts:292-340` 尚未落盘——本次为 openai 补该 key 的读写，
  收敛在 repo 内）。桌面文件 `~/.cotaya/v2/credentials.json` AES-GCM；CLI 侧
  `shared-credentials.ts:15-24` 同名 key（路径解析 `:280-290` 已指向
  `~/.cotaya/v2/credentials.json`）；Web 侧 localStorage key 段见 §4。
- **expires_in 缺省按 3600s**；`expiresAt = now + expires_in * 1000`。
- **refresh_token 轮换**：`POST oauth/token`，form：`grant_type=refresh_token`、
  `refresh_token`、`client_id`、`scope=openid profile email`。响应的新
  refresh_token **必须替换旧值并持久化**（一次性使用语义，旧值即刻丢弃）；
  同时更新 access_token 与 expires_at。
- **主动刷新**：过期前 60 秒。触发放请求鉴权解析
  `accountProviderRequestAuthService.ts:68-85` `resolveCurrent`（openai 新分支
  返回 `{apiKey: 刷新后 access_token, headers: {"chatgpt-account-id": <id>}}`，
  结构复用 `AccountRequestAuthMaterial` `:10-13`）；刷新本身带 per-provider
  互斥（single-flight），防并发双刷导致轮换竞态。
- **模型请求前经 `refreshBeforeModelRequest` 反向 RPC 每次取新材料**
  （`apps/zcode-cli/packages/core/src/runtime/methods/model-runtime-headers.ts:44`
  调用链；CLI 侧 `applyModelRequestAuth` 已支持合并 `requestAuth.headers`
  `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`），长会话天然
  覆盖，不引入定时器轮询的第二条刷新路径。
- id_token 处理：仅 base64url 解 JWT payload、**不验签**（复用
  `resolveJwtExpiration` 同等信任模型，`shared/src/oauth.ts:164-191`）。取
  `chatgpt_account_id`（顶层 claim 或 `https://api.openai.com/auth` 命名空间下）、
  `email`、`sub`。

### 2.5 401 / refresh 失效与重登引导

- **失效判定**：refresh 请求返回 HTTP 401/403，或错误码
  `refresh_token_expired` / `refresh_token_reused` / `refresh_token_invalidated`
  → 判定凭据失效。
- **模型通道 401**：模型请求每次都带刷新后材料，仍 401 即凭据真失效。
  `oauthUnauthorizedRequest.ts:21-65` `isCurrentOAuthCredentialRequest` 补
  openai 分支：active provider 为 openai 且请求命中
  `chatgpt.com/backend-api/codex`（按 `OPENAI_CODEX_BASE_URL` 解析 origin+path）
  且 authorization 为当前 openai access_token 时，401 视为当前凭据失效。
  - **deviation（review 修复补记）**：codex 模型通道请求由 CLI 子进程自己的 HTTP
    客户端发出，不经 host services 的 apiClient，因此该 openai 分支在桌面形态暂无
    触发路径（分支代码保留，供后续经反向 RPC 错误通道接入）。实际失效清理由
    refresh 失败路径等效承担（`openaiRequestAuthRefresher.onCredentialInvalid`，
    验收场景 4 即测该路径）；codex 401 不主动清凭据，待真实账号 E2E 后再决定是否
    打通 CLI → host 的 401 通知链路。
- **失效动作**（在 OAuthService 会话变更队列内复核后执行，遵循
  `oauthUnauthorizedRequest.ts:20` 既有注释约束）：仅清 `oauth:openai:*` 与
  （若 active）置回未登录态；**z.ai 域凭据与 zcodejwttoken 不动**。派生清理走
  `notifyProviderLogout("openai")`。
- **重登引导**：UI 走现有 `reauthentication-required` 路径
  （`OAuthCachedSessionRestoreResult` `shared/src/oauth.ts:147-150`；弹窗文案
  复用 `login.expired.*` `zh-CN.ts:801-804` 语义，openai 场景不触发"重启"
  分支——那是 zcode JWT 失效专属 `useRootOAuthEffects.ts:203-235`）。
- **启动恢复**：`restoreCachedSessionState`（`oauthService.ts:182-269`）现按
  共享 zcode JWT exp（`:211-226`）；openai 无 zcodejwttoken，改为按
  `oauth:openai:expires_at` 判断：未过期 → authenticated；已过期且有
  refresh_token → 尝试一次同步 refresh（成功即恢复，失败置
  reauthentication-required）；无 refresh_token → reauthentication-required。

### 2.6 账号展示字段

- `user_info.id = chatgpt_account_id`（`OAuthUserProfile.id`）。
- `username` / `displayName = email`，email 缺省回退 `sub`。
- `rawProfile` 保留 `{chatgpt_account_id, email, sub}` 原始 claim 供排查。
- 侧边栏/账号菜单展示 email；`chatgpt_account_id` 用于请求头与日志脱敏排查，
  不做主展示。头像无来源，留空（回退现有默认占位）。

### 2.7 模型通道与 provider 配置

- `baseUrl = https://chatgpt.com/backend-api/codex`（env `OPENAI_CODEX_BASE_URL`
  覆盖），`api.type=openai-responses`。
- 请求头：`Authorization: Bearer <access_token>`（动态，经请求鉴权下发）、
  `chatgpt-account-id: <chatgpt_account_id>`（动态，同上）、
  `originator: codex_cli_rs` 与 version 指纹头（**静态**，放 provider 规则
  `api.headers`，即 `zcode-builtin.json` openai 账号登录 providerRule）。
  - **deviation（review 修复补记，§2.8 落地后部分更新）**：模型请求链路的
    originator/version 仅以 zcode-builtin.json 静态值下发；原计划的
    `OPENAI_OAUTH_ORIGIN` env 覆盖从未接线（运行时解析链无消费方，已按未使用
    导出清理）。§2.8 目录拉取链路引入了
    `OPENAI_CODEX_ORIGINATOR`/`OPENAI_CODEX_CLIENT_VERSION` env 覆盖
    （shared `resolveOpenAICodex*`），但**只作用于目录拉取**，模型请求头的
    originator/version 仍以 builtin headers 为准——如需全链路 env 覆盖，
    随 provider 规则校准一并提供。
  - **校准记录（2026-10-04，真实 Plus 账号实测）**：version 静态值
    `0.142.5` 会被后端 `minimal_client_version` 门控拒绝——`gpt-5.6-*` 要求
    `0.144.0`、`gpt-6-sol/luna` 要求 `0.155.0`，实测返回
    `400 The 'gpt-5.6-terra' model requires a newer version of Codex`；已校准为
    `0.159.0`（同 cc-switch），实测 200。该值须随官方 Codex CLI 版本演进同步
    上调，模型 400 且报 requires a newer version 时优先怀疑此处。
- provider 配置：`provider-data-schema.ts:30-62` access 联合新增
  `chatgpt-account{accountType:"openai"}`（不动 `zhipu-account` 语义）；
  `provider-config.ts:36-112` 旁新增对应 access 类；`zcode-builtin.json` 现有
  openai **api-key** 模板在 `:323-353`（保持不动），新增
  `account:openai-plan` providerRule + 模型规则。
  - **模型清单校准（2026-10-04，`GET /models?client_version=0.159.0` 实测）**：
    取后端 `visibility=list` 的 8 个：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、
    `gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`
    （`gpt-reserve`、`codex-auto-review` 为 `visibility=hide`，不列）；原沿用
    api-key 模板的 `gpt-5.6`/`gpt-5.4*`/`gpt-5.3-codex` 后端不存在，已移除。
    同源实测：`context_window=272000`、支持图片输入，经
    `providerSiteRules`（`baseUrlMatch: https://chatgpt\.com/backend-api/codex/?`）
    单条规则下发，不动全局 `.*` 兜底（revision 32）。
  - **reasoning 档位校准（revision 33）**：全局 `.*` 兜底的
    `reasoningLevel: ["disabled","enabled"]`（空 map）不适用于 codex 模型；按
    `/models` 的 `supported_reasoning_levels` 逐模型配置真实档位（gpt-6-luna 到
    `max`、gpt-5.5 到 `xhigh`、其余到 `ultra`），map 用嵌套模板
    `{"reasoning":{"effort": reasoningLevel}}`（model-option-map 支持嵌套
    merge-patch，已实测展开正确）。用户不选时不下发，由后端
    `default_reasoning_level` 兜底。`max_context_window=872000` 与
    `verbosity` 暂未消费（无对应运行时选项），留待需要时接。
- 可用性：`codingPlanProviderAvailability.ts:129-163` 的 openai 版本**以本地
  token 有效性为 entitled**（无 zcode 后端套餐校验）；family 投影
  `accountProviderConnectionResolver.ts:94`（`["zai","bigmodel"]` 硬循环）加
  openai；family 排序 `packages/provider/src/resolver.ts:360-363` 补 openai。

### 2.8 账号模型目录动态同步（通用规则，openai 首个实现）

- **适用范围**：非 z.ai/bigmodel 渠道的账号 provider（即非 zcode 后端套餐体系的
  账号域）。z.ai/bigmodel 保持 zcode-builtin.json 静态清单为唯一事实源，不进入
  本流程。openai 是首个实现；后续新账号 provider 接入时必须实现同等的目录拉取。
- **数据流**：账号解析周期内 availability 校验携带目录端口
  （`validateOpenAIAccountProviderAvailability` → `openAIModelCatalog.resolveModelIds()`）
  → `GET {codex base}/models?client_version={version}`（头与模型请求同源：
  `Authorization`、`chatgpt-account-id`、`originator`、`version`）→ 过滤
  `visibility === "list"` 且 `minimal_client_version ≤ version` 的 slug →
  `availability.models` → connection → 账号层 overlay `builtinModelIds` 覆盖
  zcode-builtin 静态清单（复用 z.ai Start Plan 余额模型的既有通道，
  `account-provider-resolution.ts` / `accountProviderConnectionResolver.ts`）。
- **兜底语义**（三态）：`null`（未登录/未注入端口/拉取失败且无缓存）→ 不投影，
  静态清单生效；非空数组 → 覆盖静态清单；空数组 → 权威空清单（后端明确无可列
  模型）。缓存里的空清单不视为新鲜，下轮重新拉取。
- **缓存**：`{configDir}/model-catalog/openai.json`（schemaVersion 1，按
  `chatgpt_account_id` 作用域；换账号后旧缓存不得串用）。TTL 24h；拉取失败但存在
  同账号旧缓存（含过期）时回退旧缓存；并发解析共享单次 in-flight 请求。
- **能力元数据不动态化**：目录只决定「有哪些模型」。模型能力（contextWindow、
  图片输入、reasoning 档位）仍来自静态规则——`providerSiteRules`（baseUrl 作用域）
  覆盖全部打到 codex 后端的模型，新模型自动获得 ctx/图片默认；逐模型 reasoning
  档位需随校准更新 zcode-builtin.json（未校准的新模型回落全局 `.*` 兜底）。
- **版本指纹**：目录拉取使用 `resolveOpenAICodexClientVersion()` /
  `resolveOpenAICodexOriginator()`（shared 常量 `0.159.0` / `codex_cli_rs`，
  env `OPENAI_CODEX_CLIENT_VERSION` / `OPENAI_CODEX_ORIGINATOR` 覆盖）；
  version 与 zcode-builtin.json `api.headers.version` 是同一事实的两处表达，
  校准时同步（originator 覆盖仅作用目录拉取，见 §2.7 deviation）。
- **CLI standalone 运行时**暂不接目录同步（无 host 账号解析周期），静态清单
  兜底；接入时复用 `createOpenAIModelCatalogService`（已从 services 导出）。

## 3. 状态所有者与事件顺序

**状态所有者**：

- OAuth 凭据（`oauth:openai:*`、`oauth:active_provider`）唯一所有者：Desktop
  host 进程 `OAuthService` + `OAuthCredentialRepo`（单写路径，经
  `runSessionMutation` 串行）；CLI 登录进程经 shared credential store（同 key、
  文件锁 `withFileLock`）写同一文件——key 同名即同一事实源，不造双写路径。
- token 生命周期（expiresAt / 刷新轮换）所有者：host 进程
  `AccountProviderRequestAuthService.resolveCurrent`（openai 分支）；CLI 进程内
  同语义薄实现。
- UI 不持有 token：只经 `packages/ui/src/hooks/useOAuth.ts` 调服务。

**时序一：Desktop loopback 主流程**

```
用户            Renderer(useOAuth)      Host OAuthService(openai adapter)   127.0.0.1:1455        auth.openai.com
  |                |                           |                               |                     |
  | 点击"连接 OpenAI"|                           |                               |                     |
  |--------------->| startOAuthWithPolling      |                               |                     |
  |                |--------------------------->| startOAuthInternal(:827)       |                     |
  |                |                           | state=32B hex, verifier=43-128 |                    |
  |                |                           | PKCE S256 challenge            |                     |
  |                |                           |--起 loopback server(固定1455)-->|                     |
  |                |                           |                               | listen              |
  |                |<--------------------------| {authorizeUrl, state}          |                     |
  |                | openExternal(authorizeUrl)|                               |                     |
  |                |--------------------------------------------------------------------------- --------->|
  |                |                           |                               |    GET /oauth/authorize
  |  浏览器登录授权  |                           |                               |    (client_id/redirect_uri/
  |<============================================================================================>|
  |                |                           |                               |     302 回调          |
  |                |                           |<--GET /auth/callback?code&state-|                     |
  |                |                           | 校验 state==pendingState(:866) |                     |
  |                |                           |--POST /oauth/token(form)-------------------------------------->|
  |                |                           |<--{access_token,refresh_token,id_token,expires_in}------------|
  |                |                           | 解 id_token → chatgpt_account_id/email/sub                   |
  |                |                           | persistOAuthSession(:379) inactive=null 不清 z.ai 域         |
  |                |                           | setActiveProvider("openai")                                 |
  |                |<--------------------------| session{userInfo}                                            |
  | 侧边栏显示 email |                           |                               |                     |
```

**时序二：设备码 fallback**（1455 被占 / 无浏览器 / Web 端）

```
用户            客户端(Desktop host / CLI / Web)                 auth.openai.com
  |                |                                                   |
  |  触发 fallback   |                                                   |
  |  (EADDRINUSE /   |                                                   |
  |   --no-browser / |                                                   |
  |   Web)           |                                                   |
  |---------------> | POST /api/accounts/deviceauth/usercode {client_id}  |
  |                 |-------------------------------------------------->|
  |                 |<--{device_auth_id, user_code, interval, expires_in}|
  | 展示 user_code +  |                                                   |
  | 设备页 URL       |                                                   |
  |<----------------|                                                   |
  | 打开 auth.openai.com/codex/device 输入 user_code                     |
  |-------------------------------------------------------------------->|
  |                 | POST /api/accounts/deviceauth/token               |
  |                 |   {device_auth_id, user_code}（按 interval 轮询）   |
  |                 |-------------------------------------------------->|
  |                 |<--403/404 继续等待 --------------------------------|
  |                 |-------------------------------------------------->|
  |                 |<--2xx {authorization_code, code_verifier(服务端返回)}|
  |                 | POST /oauth/token (form; redirect_uri=             |
  |                 |   https://auth.openai.com/deviceauth/callback)     |
  |                 |-------------------------------------------------->|
  |                 |<--{access_token, refresh_token, id_token, expires_in}|
  |                 | 解 id_token → 持久化 → setActiveProvider("openai")  |
  |  登录完成提示    |                                                   |
  |<----------------|                                                   |
```

设备码编排并入现有 `pendingState` 生命周期（openai 的 pending 以
`device_auth_id`/`user_code` 标识，token 兑换结果同样汇入
`runPendingSessionCompletion` → `persistOAuthSession`，保持单一落盘路径与
flow 取消语义）；Web 端无 host OAuthService，由 Web auth 模块等价实现。

**刷新与失效顺序**（所有端）：

```
模型请求 → refreshBeforeModelRequest(反向 RPC) → resolveCurrent(openai)
  → expiresAt 距过期 <60s ? --否--> 返回当前 access_token
                          |--是--> single-flight POST refresh_token
                                    → 成功: 替换 access/refresh/expires_at 并落盘
                                    → 401/403 或 refresh_token_expired/reused/invalidated:
                                      清 oauth:openai:*（不动 z.ai 域）→ 重登引导
```

## 4. 接口清单（改动面）

| 触点                 | 现状（path:line，实测）                                                                                                                                                                                                                                                                                                                                              | 改动                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| services·adapter     | `packages/services/src/oauth/providers/providerAdapter.ts:19-39` 接口；工厂 `providers/index.ts:8-35`；参考 `zaiProviderAdapter.ts`/`bigmodelProviderAdapter.ts`；配置 `zaiProviderConfig.ts`/`bigmodelProviderConfig.ts`；`runtimeConfig.ts:34-37`                                                                                                                  | 新增 `openaiProviderAdapter.ts` + `openaiProviderConfig.ts`，工厂注册                                                                                              |
| services·流程        | `oauthService.ts:594` startOAuthWithPolling、`:827` startOAuthInternal、`:866` handleCallback（state 校验）                                                                                                                                                                                                                                                          | loopback 回调并入 pendingState/handleCallback；设备码新增启动/轮询编排                                                                                             |
| services·身份域      | `oauthService.ts:102-110` resolveInactiveOAuthProvider、`:379-436` persistOAuthSession（`:418` 条件 clearProvider）                                                                                                                                                                                                                                                  | 按身份域返回 inactive；openai → null                                                                                                                               |
| services·恢复/登出   | `oauthService.ts:182-269` restoreCachedSessionState（`:211-226` zcode JWT exp）、`:1049-1086` logout/logoutAll                                                                                                                                                                                                                                                       | openai 按 expires_at+refresh 恢复；登出仅清当前 active provider                                                                                                    |
| services·401 识别    | `oauthUnauthorizedRequest.ts:21-65`（`:34-35` provider 白名单）                                                                                                                                                                                                                                                                                                      | 补 openai 分支（codex baseUrl + openai access_token 匹配）                                                                                                         |
| services·凭据 repo   | `repo/oauthCredentialRepo.ts:16` KNOWN_OAUTH_PROVIDER_IDS、`:24-34` key 构造、`:292-340` save/loadTokenSet、`:450-452` shouldClearZcodeJwtOnLogout                                                                                                                                                                                                                   | 加 openai key 段与 `expires_at` 读写；JWT 清理不含 openai                                                                                                          |
| services·请求鉴权    | `accountProviderRequestAuthService.ts:10-13` AccountRequestAuthMaterial、`:68-85` resolveCurrent（`:73-84` planKind 分支）                                                                                                                                                                                                                                           | openai 新分支返回 {apiKey, headers:{chatgpt-account-id}} + 主动刷新                                                                                                |
| services·投影/可用性 | `accountProviderConnectionResolver.ts:94`（family 硬循环）、`codingPlanProviderAvailability.ts:129-163`、`providerProvisioningSource.ts:22-31`                                                                                                                                                                                                                       | family 加 openai；openai 以本地 token 有效性为 entitled；白名单加 `oauth:openai:*`                                                                                 |
| provider·配置        | `provider-data-schema.ts:30-62`（`:55-58` access 联合）、`provider-config.ts:36-112`、`config/provider/zcode-builtin.json:323-353`（openai api-key 模板，`:334` api.type、`:337-348` 模型清单）、`resolver.ts:360-363` family 排序                                                                                                                                   | 新增 `chatgpt-account{accountType:"openai"}` access 类与 `account:openai-plan` providerRule；api-key 模板不动                                                      |
| shared               | `oauth.ts:56-59` OAuthProviderId、`:133-138` OAuthTokenSet；`model-provider-family.ts:6-47`；`model-provider-types.ts:2-14`；`validationAppSettings.ts:57`；`provider-family-connection-selection.ts:18-23`                                                                                                                                                          | `OPENAI_PROVIDER_ID` + 能力声明（loopback/device/无 zcodejwttoken/支持 refresh）；OpenAI 端点常量新模块；各枚举/键加 openai                                        |
| 桌面 UI              | `WelcomeScreen.tsx:488-545`（按钮/排序）、`hooks/useOAuth.ts:71-127`（`:89-92` polling 白名单）、`root/useRootOAuthEffects.ts:237-320`（轮询）/`:322-409`（deep link）、`lib/oauthProviderIcon.tsx:5-11`、`settings/model-provider-section/constants.ts:31-106`、`i18n/locales/zh-CN.ts:789-800` + en-US 对应处                                                      | OpenAI 登录入口、图标（占位 svg）、spec 条目（账号登录型，无购买卡）、i18n                                                                                         |
| CLI                  | `apps/zcode-cli/packages/cli/src/login-command.ts:7-84`（`:16` 枚举）、`packages/bootstrap/src/auth-login.ts:127-247`、`packages/adapters/src/auth/localhost-callback.ts:43-142`（`:119-125` listen(0) 随机端口）、`adapters/src/auth/bigmodel-oauth.ts`（precedent）、`cli/src/command-center/login-flow.ts:12-79`、`adapters/src/auth/shared-credentials.ts:15-24` | `login openai`；localhost-callback 参数化支持固定端口 1455；新增 `openai-oauth.ts` 薄客户端（端点常量从 @zcode/shared 引）；/login 新选项；凭据 key 同名；CLI i18n |
| Web + server         | `packages/web/src/auth/webAuthService.ts:86-100`（startLogin）、`zaiWebOAuthProvider.ts`（参考）、`browserOAuthCredentialRepo.ts:22` WebOAuthProviderId、`packages/web/src/main.tsx:170` onLogin；server 路由在 `packages/server/src/http.ts`（Hono 集中注册）                                                                                                       | 新增 `openaiWebOAuthProvider.ts`（设备码）；WebOAuthProviderId 加 openai；OpenAI 端点经 server 新增小代理转发避 CORS（部署形态确认见 deviations）                  |

## 5. 验收场景

1. **首次登录（Desktop）**：Welcome 页点"连接 OpenAI"→ 浏览器 authorize → 回调
   `localhost:1455/auth/callback` → 换 token 成功 → 侧边栏显示 email；
   `~/.cotaya/v2/credentials.json` 出现 `oauth:openai:*` 与
   `oauth:active_provider="openai"`；z.ai 域 key 无变化。
2. **1455 被占降级**：预占 1455 端口后发起登录 → 自动切换设备码，展示
   user_code 与设备页 URL → 输码完成 → 登录成功（凭据同 1）。
3. **token 过期前主动刷新**：将 expires_at 调至距当前 <60s → 发起模型请求 →
   观察到 refresh 请求，新 refresh_token 已替换落盘，模型请求携新
   access_token 与 `chatgpt-account-id` 头。
4. **refresh 失效重登**：使 refresh 返回 401（或 mock
   `refresh_token_expired`）→ openai 凭据被清、UI 出现重登引导；
   `oauth:zai:* / oauth:bigmodel:* / zcodejwttoken` 仍在。
5. **身份域来回切换互不清**：登录 openai → 切登录 zai → 再切回 openai：
   每次仅 active_provider 变化 + 新域 token 写入，另一域 access/refresh/user_info
   全程不被删除。
6. **登出**：active 为 openai 时登出 → 仅清 `oauth:openai:*` 与 active 指针；
   z.ai 域凭据保留，可再直接切回。
7. **三端入口各自可用**：桌面 Welcome 按钮、`cotaya login openai`（含
   `--no-browser` 走设备码）、Web 分享页 openai 登录（设备码）各自完成登录并
   写同一套 key。
8. **回归**：zai/bigmodel 登录、切换、登出行为与现状一致（互删语义不变）；
   `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
9. 真实账号 E2E（真实 ChatGPT 账号完成 1/2/3/4/7 的手动验证）由用户执行，结果
   记录回本节。

## 6. 上游同步影响（五问）

1. **能否实现为新模块？** 协议差异全部收敛在新 adapter（services
   `openaiProviderAdapter.ts`、CLI `openai-oauth.ts` 薄客户端、Web
   `openaiWebOAuthProvider.ts`）与 shared 端点常量新模块；设备码编排为
   OAuthService 内新启动路径，不改 zai/bigmodel 现有流程。
2. **能否引入 adapter/hook？** `OAuthProviderAdapter`（`providerAdapter.ts:19-39`）
   即现成 seam；请求鉴权经 `AccountRequestAuthMaterial`（`accountProviderRequestAuthService.ts:10-13`）
   下发动态头，无需新协议。
3. **集成点能否更小？** 必须改上游文件的点集中在身份域分支
   （`oauthService.ts:102-110`）、恢复分支（`:182-269`）、401 识别
   （`oauthUnauthorizedRequest.ts:34-35`）、shared 枚举/键、UI 白名单——每处
   为小而局部的枚举/分支扩展，配中文注释说明身份域划分原因。
4. **产品逻辑能否留在这个上游文件之外？** 全部规则（身份域、轮换语义、失效
   判定、fallback 条件）落本规格；上游文件补丁只做"分支判断 + 枚举加项"，
   可独立 review、独立回滚。
5. **这次修改会不会让下一次上游 merge 不必要地更难？** 枚举扩展是加法冲突
   （上游同核会改这些行，冲突可见可控）；唯一语义改动是
   `resolveInactiveOAuthProvider` 按身份域返回——冲突时保 openai→null 分支、
   上游对 zai/bigmodel 的改动照贴。`zcode-builtin.json` 新增 providerRule 为
   独立 JSON 节点，merge 冲突概率低。

**移除性**：删除 openai adapter/薄客户端/Web provider/端点常量模块 + 回退枚举
与分支扩展即整体恢复；`oauth:openai:*` 凭据 key 为独立命名空间，残留不影响
z.ai 域登录。

### 撰写自查（对照产品规则 2.1-2.7 与验收要求）

- [x] 三端登录入口（2.1：桌面/CLI/Web 表格，Web 固定设备码）
- [x] loopback 主流程与设备码 fallback 触发条件（2.2：三条降级条件 + 设备码协议细节）
- [x] 身份域并存：互不删凭据、active provider 单指针切换（2.3，含 resolveInactiveOAuthProvider/persistOAuthSession 改法）
- [x] token 存储与刷新轮换（2.4：key、expires_at 落盘 gap、60s 主动刷新、single-flight、轮换必持久化）
- [x] 401/refresh 失效后的重登引导（2.5：判定码、只清 openai、reauthentication-required 路径）
- [x] 账号展示字段（2.6：email/chatgpt_account_id/sub 映射）
- [x] 事件顺序图两条（§3：Desktop loopback 全链路 + 设备码 fallback，含刷新/失效顺序）
- [x] 验收场景覆盖任务点名的七项（§5 场景 1-7，另加回归与真实账号 E2E 待办）
- [x] 接口清单为 path:line 表格（§4，行号均按当前工作区实测）
- [x] 上游同步五问 + 移除性（§6）
