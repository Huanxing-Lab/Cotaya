import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  createCliOAuthPollToken,
  loginWithOpenAIOAuth,
  openUrlInBrowser,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type BrowserOpenResult,
  type SharedZCodeCredentialStore,
  type CliOAuthClient,
  type CliOAuthInitData,
  type CliOAuthPollData,
  type CliOAuthUser,
  type OpenAILoginCallbacks,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { EnvRecord } from "@zcode/adapters/model";
import { buildZCodeEndpointUrls, OPENAI_PROVIDER_ID, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import { dirname, join } from "node:path";
import {
  createStandaloneAccountIdentityFromSecret,
  hasStandaloneCodingPlanAccess,
  readStandaloneCodingPlanProviders,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "./app/standalone-account-provider-runtime.js";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { setTimeout as delay } from "node:timers/promises";
import { pollUntilReady } from "./auth-login-polling.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

export type CodingPlanProviderId = "bigmodel" | "zai";

export interface LoginZCodeCliOptions {
  providerId?: CodingPlanProviderId;
  abortSignal?: AbortSignal;
  apiKeyResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
  baseUrl?: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  httpClient?: Parameters<typeof createCliOAuthClient>[0]["httpClient"];
  noBrowser?: boolean;
  now?: () => number;
  onAuthorizeUrl?: (data: CliOAuthInitData) => void | Promise<void>;
  onBrowserOpen?: (result: BrowserOpenResult) => void | Promise<void>;
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  pollToken?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  personalProviderConfigPath?: string;
}

export interface LoginZCodeCliResult {
  browser?: BrowserOpenResult;
  configPath: string;
  credentialsPath: string;
  model: string;
  providerId: CodingPlanProviderId;
  user: CliOAuthUser;
}

export type LoginBigmodelCodingPlanOptions = Omit<LoginZCodeCliOptions, "providerId">;
export type LoginBigmodelCodingPlanResult = LoginZCodeCliResult & { providerId: "bigmodel" };

export interface LoginOpenAICliOptions {
  abortSignal?: AbortSignal;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  httpClient?: Parameters<typeof loginWithOpenAIOAuth>[0]["httpClient"];
  noBrowser?: boolean;
  now?: () => number;
  onAuthorizeUrl?: OpenAILoginCallbacks["onAuthorizeUrl"];
  onDeviceCode?: OpenAILoginCallbacks["onDeviceCode"];
  onBrowserOpen?: OpenAILoginCallbacks["onBrowserOpen"];
  openBrowser?: Parameters<typeof loginWithOpenAIOAuth>[0]["openBrowser"];
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  personalProviderConfigPath?: string;
}

export interface LoginOpenAICliResult {
  browser?: BrowserOpenResult;
  configPath: string;
  credentialsPath: string;
  /** 实际完成的流程：loopback 主流程或设备码 fallback（1455 被占/无浏览器）。 */
  method: "loopback" | "device-code";
  model: string;
  providerId: "openai";
  user: { user_id: string; email?: string; name?: string };
}

export interface ConfigureCodingPlanApiKeyOptions {
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  model: string;
  providerId: CodingPlanProviderId;
}

export interface LogoutZCodeCliOptions {
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
}

export interface LogoutZCodeCliResult {
  credentialsPath: string;
}

export async function hasConfiguredStandaloneCodingPlan(
  options: {
    credentialStore?: SharedZCodeCredentialStore;
    env?: EnvRecord;
  } = {},
): Promise<boolean> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  return hasStandaloneCodingPlanAccess(credentialStore, options.env ?? process.env);
}

export class ZCodeCliLoginError extends Error {
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_write_failed";

  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}

export async function loginZCodeCli(
  options: LoginZCodeCliOptions = {},
): Promise<LoginZCodeCliResult> {
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? "zai";
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const pollToken = options.pollToken ?? createCliOAuthPollToken();
    const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
    const oauthClient = createOAuthClient(options, env);
    const initData = await waitWithAbort(oauthClient.init({ pollToken }, { signal }), signal);
    const remainingMs = Math.min(deadlineMs, initData.expires_at * 1_000) - now();
    if (remainingMs <= 0) throw timeoutError();
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(timeoutError()), remainingMs);
    await options.onAuthorizeUrl?.(initData);
    throwIfAborted(signal);
    const browser = options.noBrowser
      ? undefined
      : await waitWithAbort(
          (options.openBrowser ?? openUrlInBrowser)(initData.authorize_url),
          signal,
        );
    if (browser) await options.onBrowserOpen?.(browser);
    const readyData = await pollUntilReady({
      abortSignal: signal,
      initData,
      now,
      oauthClient,
      onPollStatus: options.onPollStatus,
      pollToken,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
      timeoutMs: Math.max(0, deadlineMs - now()),
      createError: (code) =>
        code === "auth_timeout"
          ? timeoutError()
          : new ZCodeCliLoginError(code, "Authorization failed. Please retry login."),
    });
    const apiKey = await waitWithAbort(
      resolveCodingPlanApiKey({
        accessToken: readyData.accessToken,
        env,
        httpClient: options.httpClient,
        family: providerId,
        resolver: options.apiKeyResolver,
        signal,
      }),
      signal,
    );
    // A cancelled/expired attempt must not persist a late ready response or API key.
    throwIfAborted(signal);
    try {
      if (providerId === "zai") {
        await credentialStore.saveZaiLoginCredentials({
          accessToken: readyData.accessToken,
          jwtToken: readyData.token,
          user: readyData.user,
        });
      } else {
        await credentialStore.saveMany({
          [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: providerId,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: readyData.token,
          [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken]: readyData.accessToken,
          ...(readyData.refreshToken
            ? { [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelRefreshToken]: readyData.refreshToken }
            : {}),
          [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelUserInfo]: JSON.stringify({
            id: readyData.user.user_id,
            username: readyData.user.name || readyData.user.email || readyData.user.user_id,
            displayName: readyData.user.name || readyData.user.email || readyData.user.user_id,
            rawProfile: readyData.user,
          }),
        });
      }
    } catch (error) {
      throw new ZCodeCliLoginError(
        "credential_write_failed",
        "Login succeeded but writing credentials failed.",
        { cause: error },
      );
    }
    throwIfAborted(signal);
    let configPatch: StandaloneCodingPlanPersistenceResult;
    try {
      configPatch = await persistStandaloneCodingPlanConnection({
        accountIdentity: readyData.user.user_id,
        apiKey,
        credentialStore,
        env,
        personalProviderConfigPath: options.personalProviderConfigPath,
        providerId,
      });
    } catch (error) {
      throw new ZCodeCliLoginError(
        "config_update_failed",
        "Login succeeded but updating ZCode config failed.",
        { cause: error },
      );
    }
    return {
      ...(browser ? { browser } : {}),
      configPath: configPatch.path,
      credentialsPath: credentialStore.filePath,
      model: configPatch.mainModel,
      providerId,
      user: readyData.user,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function loginBigmodelCodingPlan(
  options: LoginBigmodelCodingPlanOptions = {},
): Promise<LoginBigmodelCodingPlanResult> {
  return {
    ...(await loginZCodeCli({ ...options, providerId: "bigmodel" })),
    providerId: "bigmodel",
  };
}

/**
 * OpenAI（ChatGPT 账号）登录：授权码 + PKCE + loopback 1455 主流程，
 * 1455 被占或 --no-browser 时自动降级设备码流程。
 * 凭据写入与 Desktop 同名 key（oauth:openai: 加 active_provider），
 * openai 是独立身份域：不写 zcodejwttoken、不触碰 zai 与 bigmodel 的凭据。
 */
export async function loginOpenAICli(
  options: LoginOpenAICliOptions = {},
): Promise<LoginOpenAICliResult> {
  const env = options.env ?? process.env;
  const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  const login = await loginWithOpenAIOAuth({
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
    ...(options.env ? { env: options.env } : {}),
    noBrowser: options.noBrowser,
    ...(options.now ? { now: options.now } : {}),
    ...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    signal: options.abortSignal,
    onAuthorizeUrl: options.onAuthorizeUrl,
    onDeviceCode: options.onDeviceCode,
    onBrowserOpen: options.onBrowserOpen,
  });
  const { tokenSet } = login;

  try {
    // user_info 与 Desktop OAuthUserProfile 同构：id = chatgpt_account_id，
    // rawProfile 保留原始 claim 供排查（spec §2.6）。
    await credentialStore.saveMany({
      [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: OPENAI_PROVIDER_ID,
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiAccessToken]: tokenSet.accessToken,
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiRefreshToken]: tokenSet.refreshToken,
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiExpiresAt]: String(tokenSet.expiresAt),
      [SHARED_ZCODE_CREDENTIAL_KEYS.openaiUserInfo]: JSON.stringify({
        id: tokenSet.profile.id,
        username: tokenSet.profile.username,
        displayName: tokenSet.profile.displayName,
        rawProfile: {
          chatgpt_account_id: tokenSet.profile.chatgptAccountId ?? "",
          email: tokenSet.profile.email ?? "",
          sub: tokenSet.profile.sub ?? "",
        },
      }),
    });
  } catch (error) {
    throw new ZCodeCliLoginError(
      "credential_write_failed",
      "Login succeeded but writing credentials failed.",
      { cause: error },
    );
  }

  let configPatch: StandaloneCodingPlanPersistenceResult;
  try {
    configPatch = await persistOpenAIPlanDefaultModel({
      credentialStore,
      env,
      personalProviderConfigPath: options.personalProviderConfigPath,
    });
  } catch (error) {
    throw new ZCodeCliLoginError(
      "config_update_failed",
      "Login succeeded but updating ZCode config failed.",
      { cause: error },
    );
  }
  return {
    ...(login.browser ? { browser: login.browser } : {}),
    configPath: configPatch.path,
    credentialsPath: credentialStore.filePath,
    method: login.method,
    model: configPatch.mainModel,
    providerId: OPENAI_PROVIDER_ID,
    user: {
      user_id: tokenSet.profile.id,
      ...(tokenSet.profile.email ? { email: tokenSet.profile.email } : {}),
      ...(tokenSet.profile.username ? { name: tokenSet.profile.username } : {}),
    },
  };
}

/** openai 域登录后的默认模型选择：仅写 defaultModelSelection，无 account-provider api key 语义。 */
async function persistOpenAIPlanDefaultModel(input: {
  credentialStore: SharedZCodeCredentialStore;
  env: EnvRecord;
  personalProviderConfigPath?: string;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider("openai", input.env);
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 登录与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    await repository.saveConfiguredDefault({
      providerId: configuredProvider.providerId,
      modelId: configuredProvider.modelId,
    });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${configuredProvider.providerId}/${configuredProvider.modelId}`,
    path,
  };
}

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

export async function logoutZCodeCli(
  options: LogoutZCodeCliOptions = {},
): Promise<LogoutZCodeCliResult> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const providerIds = (await readStandaloneCodingPlanProviders(options.env ?? process.env)).map(
    ({ providerId }) => providerId,
  );
  const identityKeys = providerIds.map(standaloneAccountIdentityCredentialKey);
  const identities = await credentialStore.loadMany(identityKeys);
  const dynamicApiKeyKeys = providerIds.flatMap((providerId) => {
    const identity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    return identity
      ? [
          standaloneAccountProviderCredentialKey({
            providerId,
            accountIdentity: identity,
          }),
        ]
      : [];
  });
  const keys = [
    ...Object.values(SHARED_ZCODE_CREDENTIAL_KEYS),
    ...identityKeys,
    ...dynamicApiKeyKeys,
  ];
  const current = await credentialStore.loadMany(keys);
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
  return {
    credentialsPath: credentialStore.filePath,
  };
}

interface StandaloneCodingPlanPersistenceResult {
  readonly mainModel: string;
  readonly path: string;
}

async function persistStandaloneCodingPlanConnection(input: {
  readonly accountIdentity: string;
  readonly apiKey: string;
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
  readonly providerId: CodingPlanProviderId;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider(input.providerId, input.env);
  const providerId = configuredProvider.providerId;
  const modelId = configuredProvider.modelId;
  const credentialKey = standaloneAccountProviderCredentialKey({
    providerId,
    accountIdentity: input.accountIdentity,
  });
  await input.credentialStore.saveMany({
    [standaloneAccountIdentityCredentialKey(providerId)]: input.accountIdentity,
    [credentialKey]: input.apiKey,
  });
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 登录与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    await repository.saveConfiguredDefault({ providerId, modelId });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${providerId}/${modelId}`,
    path,
  };
}

function createOAuthClient(options: LoginZCodeCliOptions, env: EnvRecord): CliOAuthClient {
  return createCliOAuthClient({
    baseUrl:
      options.baseUrl ?? buildZCodeEndpointUrls(resolveCliZCodeEndpointOrigin(env)).apiBaseUrl,
    providerId: options.providerId ?? "zai",
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
}

function resolveCliZCodeEndpointOrigin(env: EnvRecord): string {
  return resolveRuntimeZCodeEndpointOrigin(env);
}

function createDefaultHttpClient(env: EnvRecord) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

async function resolveCodingPlanApiKey(input: {
  accessToken: string;
  env: EnvRecord;
  httpClient?: Parameters<typeof createCodingPlanApiKeyResolver>[0]["httpClient"];
  family: CodingPlanProviderId;
  resolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
  signal?: AbortSignal;
}): Promise<string> {
  const resolver =
    input.resolver ??
    createCodingPlanApiKeyResolver({
      httpClient: input.httpClient ?? createDefaultHttpClient(input.env),
    });
  return resolver.resolve(
    {
      accessToken: input.accessToken,
      family: input.family,
    },
    { signal: input.signal },
  );
}
