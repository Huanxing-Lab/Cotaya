import { createHash } from "node:crypto";
import {
  OpenAIRefreshTokenInvalidError,
  refreshOpenAITokenSet,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { HttpClientPort } from "@zcode/contracts";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  createAccountProviderConfigSnapshot,
  ChatGPTAccountAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { isOpenAIPlanModelProviderId, OPENAI_REFRESH_BEFORE_EXPIRY_MS, type ProviderFamilyDomain } from "@zcode/shared";

interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<{
  readonly zcodeBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
}> {
  if (config)
    return {
      zcodeBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(
        ([providerId, provider]): StandaloneCodingPlanProvider[] => {
          const access = provider.access;
          const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
          // openai 域（chatgpt-account）是单一账号 provider：无套餐 mode 分层，随目录一并
          // 投影，登录与默认模型选择共用这套解析。
          if (access?.type === "chatgpt-account" && access.accountType && modelId) {
            return [{ family: access.accountType, modelId, providerId }];
          }
          return access?.type === "zhipu-account" &&
            access.mode === "individual-coding-plan" &&
            access.accountType &&
            modelId
            ? [{ family: access.accountType, modelId, providerId }]
            : [];
        },
      ),
    };
  const filePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    return readStandaloneCodingPlanCatalog(env, snapshot);
  } finally {
    source.dispose();
  }
}

export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  const matches = (await readStandaloneCodingPlanProviders(env)).filter(
    (provider) => provider.family === family,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config 必须为 ${family} 声明唯一 Individual Coding Plan Provider`,
    );
  }
  return matches[0]!;
}

export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID 不能为空");
  return `account-provider:${normalized}:identity`;
}

/** Standalone Credential Store 私有键；不得进入 Provider Config、Model 或 Protocol。 */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID 不能为空");
  if (!accountIdentity) throw new Error("Standalone Account Identity 不能为空");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** 没有账号 Profile 的手工 Key 登录使用稳定、不可逆的连接身份。 */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret 不能为空");
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function readStandaloneAccountProviderConfigSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  const catalog = await readStandaloneCodingPlanCatalog(env, config);
  const configuredProviders = catalog.providers;
  // openai 域 entitled 只看本地 token 存在性（spec §2.7）：过期由请求鉴权 60s 主动刷新续期，
  // 不按 expires_at 降级；z.ai 域仍按 account-provider api key 投影。
  const openAIPlanProviders = configuredProviders.filter(({ family }) => family === "openai");
  const openAITokens =
    openAIPlanProviders.length > 0
      ? await credentialStore.loadMany([SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken])
      : {};
  const hasOpenAIAccessToken = Boolean(
    openAITokens[SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken]?.trim(),
  );
  const zhipuProviders = configuredProviders.filter(({ family }) => family !== "openai");
  const identityKeys = zhipuProviders.map(({ providerId }) =>
    standaloneAccountIdentityCredentialKey(providerId),
  );
  const identities = await credentialStore.loadMany(identityKeys);
  const candidates = zhipuProviders.flatMap(({ family, providerId }) => {
    const accountIdentity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    if (!accountIdentity) return [];
    const credentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    return [{ accountIdentity, credentialKey, family, providerId }] as const;
  });
  const apiKeyByCredentialKey = await credentialStore.loadMany(
    candidates.map(({ credentialKey }) => credentialKey),
  );
  const candidateByProviderId = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate]),
  );
  const providers = new ProviderConfigMap(
    configuredProviders.map(({ family, providerId }) => {
      if (family === "openai") {
        return [
          providerId,
          new ProviderConfig({
            access: new ChatGPTAccountAccessConfig({ entitled: hasOpenAIAccessToken }),
          }),
        ] as const;
      }
      const candidate = candidateByProviderId.get(providerId);
      const apiKey = candidate ? apiKeyByCredentialKey[candidate.credentialKey]?.trim() : undefined;
      if (!candidate || !apiKey) {
        // 账号 Overlay 缺少成员表示“不覆盖”，不能表达账号已断开；必须显式
        // entitled=false，才能让 Built-in 账号 Provider 在凭据删除后从 Registry 退出。
        return [
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: false }),
          }),
        ] as const;
      }
      return [
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
        }),
      ] as const;
    }),
  );
  return createAccountProviderConfigSnapshot(catalog.zcodeBuiltinRevision, providers);
}

export async function hasStandaloneCodingPlanAccess(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (await readStandaloneAccountProviderConfigSnapshot(credentialStore, env)).providers
    .entries()
    .some(([, provider]) =>
      provider.access?.type === "zhipu-account"
        ? provider.access.entitled === true
        : provider.access?.type === "chatgpt-account"
          ? provider.access.entitled === true
          : false,
    );
}

export interface StandaloneProviderRuntimeHeadersPortOptions {
  /** openai 域 token 刷新用的 HTTP 客户端；缺省按 CLI 网络配置现场构建。 */
  env?: Readonly<Record<string, string | undefined>>;
  httpClient?: HttpClientPort;
  now?: () => number;
}

export function createStandaloneProviderRuntimeHeadersPort(
  credentialStore: Pick<SharedZCodeCredentialStore, "load" | "loadMany" | "saveMany" | "delete" | "deleteIfValue">,
  env: Readonly<Record<string, string | undefined>>,
  options: StandaloneProviderRuntimeHeadersPortOptions = {},
): ProviderRuntimeHeadersPort {
  const now = options.now ?? Date.now;
  // openai 刷新 single-flight：并发模型请求只能触发一次轮换刷新，防止旧 refresh_token
  // 一次性语义下的双刷竞态（spec §2.4）。
  let openAIRefreshInFlight: Promise<{ accessToken: string; expiresAt: number } | null> | undefined;

  const resolveOpenAIRequestAuth = async (): Promise<{
    headersApplied: boolean;
    requestAuth: { apiKey: string; headers: Record<string, string> };
  }> => {
    const keys = [
      SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken,
      SHARED_ZCODE_CREDENTIAL_KEYS.openaiRefreshToken,
      SHARED_ZCODE_CREDENTIAL_KEYS.openaiExpiresAt,
      SHARED_ZCODE_CREDENTIAL_KEYS.openaiUserInfo,
    ];
    const stored = await credentialStore.loadMany(keys);
    const accessToken = stored[SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken]?.trim();
    if (!accessToken) {
      throw new Error("OpenAI 登录凭据不可用，请执行 cotaya login openai");
    }
    const refreshToken = stored[SHARED_ZCODE_CREDENTIAL_KEYS.openaiRefreshToken]?.trim();
    const expiresAtRaw = stored[SHARED_ZCODE_CREDENTIAL_KEYS.openaiExpiresAt];
    const expiresAt = expiresAtRaw ? Number.parseInt(expiresAtRaw, 10) : Number.NaN;

    let effectiveAccessToken = accessToken;
    // 过期前 60s 主动刷新；expires_at 缺失（历史数据）也触发一次刷新补齐。
    if (!Number.isFinite(expiresAt) || expiresAt - now() <= OPENAI_REFRESH_BEFORE_EXPIRY_MS) {
      if (!refreshToken) {
        throw new Error("OpenAI 凭据已过期且缺少 refresh_token，请重新登录");
      }
      const refreshed = await (openAIRefreshInFlight ??= refreshOpenAIStandaloneTokens(
        credentialStore,
        // env 缺省回落到端口构建时的 env，保证代理/CA 配置与登录一致。
        { ...options, env: options.env ?? env },
        refreshToken,
      ).finally(() => {
        openAIRefreshInFlight = undefined;
      }));
      if (!refreshed) {
        throw new Error("OpenAI refresh token 已失效，请重新执行 cotaya login openai");
      }
      effectiveAccessToken = refreshed.accessToken;
    }

    const accountId = parseOpenAIAccountId(
      stored[SHARED_ZCODE_CREDENTIAL_KEYS.openaiUserInfo],
    );
    if (!accountId) {
      throw new Error("OpenAI 账号身份（chatgpt-account-id）缺失，请重新登录");
    }
    return {
      headersApplied: true,
      requestAuth: {
        apiKey: effectiveAccessToken,
        headers: { "chatgpt-account-id": accountId },
      },
    };
  };

  return {
    shouldRefreshBeforeModelRequest() {
      return true;
    },
    async refreshBeforeModelRequest(input) {
      input.abortSignal?.throwIfAborted();
      const providerId = input.providerId.trim();
      // openai 域（chatgpt-account）动态鉴权：Authorization 由 apiKey 承载，
      // chatgpt-account-id 头从本地 user_info 解析；token 生命周期归本端口管理。
      if (isOpenAIPlanModelProviderId(providerId)) {
        return resolveOpenAIRequestAuth();
      }
      const access = input.accountAccess;
      if (!access || access.type !== "zhipu-account" || access.mode !== "individual-coding-plan") {
        throw new Error(`Standalone Account Provider 请求身份无效: ${providerId}`);
      }
      const currentIdentity = (
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
      )?.trim();
      if (!currentIdentity)
        throw new Error(`Standalone Account Provider 凭据已经失效: ${providerId}`);
      const apiKey = (
        await credentialStore.load(
          standaloneAccountProviderCredentialKey({
            providerId,
            accountIdentity: currentIdentity,
          }),
        )
      )?.trim();
      if (!apiKey) {
        throw new Error(`Standalone Account Provider 缺少请求凭据: ${providerId}`);
      }
      return {
        headersApplied: true,
        requestAuth: { apiKey },
      };
    },
  };
}

/** openai 域 standalone 刷新：轮换后的 token 对写回凭据文件；失效时仅清 openai 域 key。 */
async function refreshOpenAIStandaloneTokens(
  credentialStore: Pick<SharedZCodeCredentialStore, "saveMany" | "delete" | "deleteIfValue">,
  options: StandaloneProviderRuntimeHeadersPortOptions,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number } | null> {
  const httpClient = options.httpClient ?? createDefaultOAuthHttpClient(options.env ?? {});
  try {
    const refreshed = await refreshOpenAITokenSet({ httpClient, refreshToken });
    await credentialStore.saveMany({
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken]: refreshed.accessToken,
      // refresh_token 一次性轮换：新值必须替换旧值并持久化。
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiRefreshToken]: refreshed.refreshToken,
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiExpiresAt]: String(refreshed.expiresAt),
    });
    return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
  } catch (error) {
    if (error instanceof OpenAIRefreshTokenInvalidError) {
      // 失效动作只清 openai 域（spec §2.5）：z.ai 域凭据与 zcodejwttoken 不动；
      // active_provider 仅在仍指向 openai 时移除。
      await credentialStore.delete(SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken);
      await credentialStore.delete(SHARED_ZCODE_CREDENTIAL_KEYS.openaiRefreshToken);
      await credentialStore.delete(SHARED_ZCODE_CREDENTIAL_KEYS.openaiExpiresAt);
      await credentialStore.delete(SHARED_ZCODE_CREDENTIAL_KEYS.openaiUserInfo);
      await credentialStore.deleteIfValue(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider, "openai");
      return null;
    }
    throw error;
  }
}

function parseOpenAIAccountId(userInfoRaw: string | null | undefined): string | null {
  if (!userInfoRaw) return null;
  try {
    const parsed = JSON.parse(userInfoRaw) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : null;
  } catch {
    return null;
  }
}

function createDefaultOAuthHttpClient(
  env: Readonly<Record<string, string | undefined>>,
): HttpClientPort {
  // 与 auth-login.ts 的登录 HTTP 客户端同一构建方式：代理/CA/超时遵循 CLI 网络配置。
  // 只有真的需要刷新时才会创建（见 createConfiguredHttpClient 的缓存）。
  return createConfiguredHttpClient(env);
}

// 进程级缓存：避免每次 openai 刷新都重建 adapter；env 差异按首次调用定格
// （端口本身也是进程级单例，与 process-provider-registry-runtime 的生命周期一致）。
let cachedConfiguredHttpClient: HttpClientPort | undefined;
function createConfiguredHttpClient(
  env: Readonly<Record<string, string | undefined>>,
): HttpClientPort {
  cachedConfiguredHttpClient ??= buildConfiguredHttpClient(env);
  return cachedConfiguredHttpClient;
}

function buildConfiguredHttpClient(
  env: Readonly<Record<string, string | undefined>>,
): HttpClientPort {
  const config = createConfig({ env: { ...env } });
  return createNodeHttpClientAdapter({
    env: { ...env },
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}
