/**
 * OAuth 领域类型定义
 *
 * 说明：敏感信息（如 appSecret）以及 provider 默认端点配置
 * 只允许放在 services 的 provider 模块中，不能放 shared 层。
 */

/** 内置 BigModel provider id */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;

/** 内置 ZAI provider id */
export const ZAI_PROVIDER_ID = "zai" as const;

/**
 * 内置 OpenAI（ChatGPT 账号）provider id。
 * OpenAI 与 z.ai 是不同身份域：互不删除对方凭据，仅切换 oauth:active_provider 指针。
 */
export const OPENAI_PROVIDER_ID = "openai" as const;

/** 凭据解密失败错误前缀 */
export const CREDENTIAL_DECRYPT_ERROR_PREFIX = "凭据解密失败：" as const;

/** 凭据解密失败稳定错误码 */
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED" as const;

/** 判断错误是否来自本地凭据解密失败 */
export function isCredentialDecryptError(error: unknown): boolean {
  const code = readCredentialErrorCode(error);
  if (code) {
    return code === CREDENTIAL_DECRYPT_ERROR_CODE;
  }

  // 兼容历史错误和跨边界丢失 code 的旧 payload；新错误应优先携带稳定 code。
  if (readCredentialErrorMessage(error).startsWith(CREDENTIAL_DECRYPT_ERROR_PREFIX)) {
    return true;
  }

  return false;
}

function readCredentialErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }

  return "";
}

function readCredentialErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return "";
}

/** OAuth provider 标识 */
export type OAuthProviderId =
  | typeof BIGMODEL_PROVIDER_ID
  | typeof ZAI_PROVIDER_ID
  | typeof OPENAI_PROVIDER_ID
  | (string & { readonly __oauthProviderBrand?: never });

/**
 * Provider 协议能力声明：登录编排（OAuthService/CLI/Web）按能力分支，
 * 不在各 provider 流程里手写 provider id 判断。
 */
export interface OAuthProviderCapabilities {
  /** 授权码回调通道：z.ai 域走应用 deep link；OpenAI 走固定端口 loopback HTTP server。 */
  callbackChannel: "deep-link" | "loopback";
  /** 是否支持设备码 fallback（loopback 端口被占、无浏览器环境、Web 端时降级）。 */
  deviceCodeFallback: boolean;
  /** 登录成功是否写共享 zcodejwttoken（z.ai 域写；OpenAI 不写，恢复按 token 过期+refresh）。 */
  usesZcodeJwtToken: boolean;
  /** 是否支持 refresh token 轮换刷新（OpenAI 专属：refresh_token 一次性、新值必须落盘）。 */
  supportsRefresh: boolean;
}

const ZAI_DOMAIN_OAUTH_PROVIDER_CAPABILITIES: OAuthProviderCapabilities = {
  callbackChannel: "deep-link",
  deviceCodeFallback: false,
  usesZcodeJwtToken: true,
  supportsRefresh: false,
} as const;

/** 内置 provider 的能力表；未知 provider 返回 null，由调用方决定默认行为。 */
export const OAUTH_PROVIDER_CAPABILITIES = {
  [ZAI_PROVIDER_ID]: ZAI_DOMAIN_OAUTH_PROVIDER_CAPABILITIES,
  [BIGMODEL_PROVIDER_ID]: ZAI_DOMAIN_OAUTH_PROVIDER_CAPABILITIES,
  [OPENAI_PROVIDER_ID]: {
    callbackChannel: "loopback",
    deviceCodeFallback: true,
    usesZcodeJwtToken: false,
    supportsRefresh: true,
  },
} as const satisfies Record<
  typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID | typeof OPENAI_PROVIDER_ID,
  OAuthProviderCapabilities
>;

export function getOAuthProviderCapabilities(
  provider: OAuthProviderId | string | null | undefined,
): OAuthProviderCapabilities | null {
  if (!provider) {
    return null;
  }
  return provider in OAUTH_PROVIDER_CAPABILITIES
    ? OAUTH_PROVIDER_CAPABILITIES[provider as keyof typeof OAUTH_PROVIDER_CAPABILITIES]
    : null;
}

/** Provider 展示元信息 */
export interface OAuthProviderMeta {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
}

/** 发起 OAuth 请求 */
export interface OAuthStartRequest {
  provider: OAuthProviderId;
}

/** 设备码 fallback 启动后客户端需要展示的信息（userCode + 输码页地址）。 */
export interface OAuthDeviceCodeStartInfo {
  /** 用户在输码页输入的一次性码（原样展示，不打开浏览器也能完成登录）。 */
  userCode: string;
  /** 用户输入 userCode 的页面地址。 */
  inputPageUrl: string;
  /** 客户端轮询登录状态的间隔（毫秒）。 */
  pollIntervalMs: number;
  /** 设备码流程过期时刻（毫秒时间戳）。 */
  expiresAt: number;
}

/** 发起 OAuth 返回 */
export interface OAuthStartResponse {
  provider: OAuthProviderId;
  authorizeUrl: string;
  state: string;
  /**
   * 存在时表示已降级为设备码流程（loopback 端口被占 / 无浏览器环境）。
   * authorizeUrl 此时是输码页地址；客户端必须展示 userCode 并继续轮询登录状态。
   */
  deviceCode?: OAuthDeviceCodeStartInfo;
}

/** 设备码流程发起结果（host 内部轮询编排使用；deviceAuthId 不下发给 renderer）。 */
export interface OAuthDeviceCodeChallenge {
  deviceAuthId: string;
  userCode: string;
  inputPageUrl: string;
  pollIntervalMs: number;
  expiresAt: number;
}

/** 设备码轮询结果：403/404 继续等待、410 过期、2xx 拿到授权码与服务端下发的 code_verifier。 */
export type OAuthDeviceCodePollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ready"; authorizationCode: string; codeVerifier: string };

/** 应用登录回调结果 */
export interface OAuthSessionCallbackResult {
  kind: "session";
  provider: OAuthProviderId;
  userInfo: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
}

/** 只携带归因参数的 OAuth deep link 回调结果 */
export interface OAuthAttributionCallbackResult {
  kind: "attribution";
  provider: OAuthProviderId;
  attribution: OAuthLoginAttribution;
}

/** 同一登录已由 polling 完成后迟到的 deep link；调用方只需忽略。 */
export interface OAuthDuplicateCallbackResult {
  kind: "duplicate";
  provider: OAuthProviderId;
}

/** OAuth 回调归一化结果 */
export type OAuthCallbackResult =
  | OAuthSessionCallbackResult
  | OAuthAttributionCallbackResult
  | OAuthDuplicateCallbackResult;

/** Main 进程路由 deep link 时使用的 state 上报结构 */
export interface OAuthStateRegistration {
  state: string;
  provider?: OAuthProviderId;
}

/** 归一化后的回调参数 */
export interface OAuthCallbackParams {
  state: string;
  code: string;
  attribution?: OAuthLoginAttribution;
}

/** OAuth 登录归因参数：来自官网中转页或投放链接 */
export interface OAuthLoginAttribution {
  channel_id?: string;
  utm_source?: string;
  utm_campaign?: string;
}

/** 归一化 token 结构 */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  zcodeJwtToken?: string;
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

export type OAuthCachedSessionRestoreResult =
  | { status: "authenticated"; userInfo: UserInfo }
  | { status: "signed-out" }
  | { status: "reauthentication-required"; reason: "jwt-expired" };

/** Host 在检测到 ZCode JWT 失效后通知 Renderer 展示确认并重启。 */
export const ZCODE_JWT_INVALID_BROADCAST_CHANNEL = "auth:zcode-jwt-invalid";

export type JwtExpirationResult =
  | { kind: "valid"; expiresAt: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "unknown" };

/**
 * 只解析 JWT 的 exp 来判断本地生命周期，不承担签名校验。
 * 无法证明已过期的历史或非标准 token 保持兼容，最终有效性仍由服务端决定。
 */
export function resolveJwtExpiration(
  token: string,
  now = Date.now(),
  clockSkewMs = 30_000,
): JwtExpirationResult {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) {
      return { kind: "unknown" };
    }

    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return { kind: "unknown" };
    }

    const expiresAt = payload.exp * 1_000;
    return now + Math.max(0, clockSkewMs) >= expiresAt
      ? { kind: "expired", expiresAt }
      : { kind: "valid", expiresAt };
  } catch {
    return { kind: "unknown" };
  }
}

/** 归一化用户信息 */
export interface OAuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  rawProfile?: unknown;
}

/** 登出范围 */
export type OAuthLogoutScope = "active" | "all";
