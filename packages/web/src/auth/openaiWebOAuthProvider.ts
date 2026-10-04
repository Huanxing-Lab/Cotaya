import {
  ApiError,
  OPENAI_ACCESS_TOKEN_DEFAULT_TTL_SECONDS,
  OPENAI_DEVICE_AUTH_INPUT_PAGE_URL,
  OPENAI_DEVICE_AUTH_REDIRECT_URI,
  OPENAI_OAUTH_REFRESH_SCOPE,
  resolveOpenAIOAuthClientId,
  type OAuthDeviceCodePollResult,
  type OAuthTokenSet,
  type UserInfo,
} from "@zcode/shared";

/**
 * OpenAI（ChatGPT 账号）Web 端 OAuth 协议客户端：只实现设备码流程。
 *
 * 浏览器无法监听 localhost loopback（spec openai-oauth-provider §2.1），Web 端固定
 * 走设备码：申请 user_code → 页内展示 + 打开输码页 → 轮询兑换 authorization_code
 * （code_verifier 由 OpenAI 服务端返回，非本地生成）→ 用
 * redirect_uri=https://auth.openai.com/deviceauth/callback 换 token。
 *
 * 端点常量与协议语义（状态码判定、interval/TTL 钳制、refresh 轮换与失效码）与
 * services 的 OpenAIProviderAdapter 保持一致；差异仅在传输层：auth.openai.com 不发
 * CORS 头，请求经同源代理 `/api/openai-oauth/*`（packages/server 透传）转发。
 */

/** 与服务层 OpenAIProviderAdapter 的 TOKEN_REQUEST_TIMEOUT_MS 对齐。 */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** 设备码轮询间隔缺省值与上下限（OpenAI 端通常下发 5s）。 */
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_MAX_INTERVAL_MS = 60_000;
/** 设备码 user_code 有效期缺省 15 分钟（响应未带 expires_in 时使用）。 */
const DEVICE_CODE_DEFAULT_TTL_MS = 15 * 60_000;
/** refresh 失效的稳定错误码（OpenAI 端语义：过期/重放/已作废，均需重新登录）。 */
const REFRESH_INVALID_ERROR_CODES = [
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
] as const;

export interface OpenAIWebOAuthConfig {
  /** 同源代理基址（packages/server 的 /api/openai-oauth 透传端点）。 */
  proxyBaseUrl: string;
  /** 公开 client_id（官方 Codex CLI 公开值；构建期 OPENAI_OAUTH_CLIENT_ID 可覆盖）。 */
  clientId: string;
}

interface WebImportMetaEnv {
  VITE_OPENAI_OAUTH_PROXY_BASE_URL?: string;
}

const env = ((import.meta as ImportMeta & { env?: WebImportMetaEnv }).env ??
  {}) as WebImportMetaEnv;

export const OPENAI_WEB_OAUTH_CONFIG: OpenAIWebOAuthConfig = {
  proxyBaseUrl: env.VITE_OPENAI_OAUTH_PROXY_BASE_URL?.trim() || "/api/openai-oauth",
  // resolveOpenAIOAuthClientId 读 __ZCODE_ENDPOINT_ENV__ define（web vite 已注入），
  // 浏览器包内 process.env 不存在时回落官方公开默认值。
  clientId: resolveOpenAIOAuthClientId(),
};

/** 设备码挑战：与 shared OAuthDeviceCodeChallenge 同形（deviceAuthId 不进 UI 展示层）。 */
export interface OpenAIWebDeviceCodeChallenge {
  deviceAuthId: string;
  userCode: string;
  inputPageUrl: string;
  pollIntervalMs: number;
  expiresAt: number;
}

export interface OpenAIWebTokenExchangeResult {
  tokenSet: OAuthTokenSet;
  userInfo: UserInfo;
  rawProfile: { chatgpt_account_id: string; email: string; sub: string };
}

/** refresh token 已失效（过期/重放/作废）：凭据不可再用，必须引导重新登录。 */
export class OpenAIWebRefreshInvalidError extends Error {
  constructor(message = "OpenAI refresh token 已失效，请重新登录") {
    super(message);
    this.name = "OpenAIWebRefreshInvalidError";
  }
}

export function isOpenAIWebRefreshInvalidError(error: unknown): boolean {
  if (error instanceof OpenAIWebRefreshInvalidError) {
    return true;
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return true;
  }
  if (error instanceof ApiError) {
    return REFRESH_INVALID_ERROR_CODES.some((code) => error.message.includes(code));
  }
  return false;
}

interface OpenAITokenResponse {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  expires_in?: number | null;
}

interface OpenAIUserCodeResponse {
  device_auth_id?: string | null;
  user_code?: string | null;
  interval?: number | null;
  expires_in?: number | null;
}

interface OpenAIDeviceCodeTokenResponse {
  authorization_code?: string | null;
  code_verifier?: string | null;
}

/** id_token payload 中与账号身份相关的 claim（仅 base64url 解码，不验签）。 */
interface OpenAIIdTokenPayload {
  sub?: unknown;
  email?: unknown;
  chatgpt_account_id?: unknown;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } | null;
}

function readTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveExpiresAt(response: OpenAITokenResponse, now: () => number): number {
  const expiresIn = response.expires_in;
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : OPENAI_ACCESS_TOKEN_DEFAULT_TTL_SECONDS;
  return now() + seconds * 1000;
}

/** base64url 解 JWT payload（浏览器版；与 shared resolveJwtExpiration 同等信任模型：不验签）。 */
function decodeIdTokenPayload(idToken: string): OpenAIIdTokenPayload | null {
  const payloadSegment = idToken.split(".")[1];
  if (!payloadSegment) {
    return null;
  }
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as OpenAIIdTokenPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * id_token → 用户信息。
 * user_info.id = chatgpt_account_id（顶层 claim 或 https://api.openai.com/auth 命名空间下）；
 * username/displayName = email，缺省回退 sub；rawProfile 保留原始 claim 供排查。
 */
export function parseOpenAIWebIdTokenProfile(
  idToken: string,
): OpenAIWebTokenExchangeResult["rawProfile"] | null {
  const payload = decodeIdTokenPayload(idToken);
  if (!payload) {
    return null;
  }
  const chatgptAccountId =
    typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id.trim()
      ? payload.chatgpt_account_id.trim()
      : typeof payload["https://api.openai.com/auth"]?.chatgpt_account_id === "string"
        ? payload["https://api.openai.com/auth"]!.chatgpt_account_id!.trim()
        : "";
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const id = chatgptAccountId || sub;
  if (!id) {
    return null;
  }
  return { chatgpt_account_id: chatgptAccountId, email, sub };
}

interface ProxyResponse {
  status: number;
  payload: unknown;
}

async function postViaProxy(
  url: string,
  body: string,
  contentType: string,
): Promise<ProxyResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType, Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 非 JSON 错误体：只保留状态码语义，原文拼进 ApiError message。
      throw new ApiError({
        message: `OpenAI OAuth 响应非 JSON（HTTP ${response.status}）`,
        url,
        method: "POST",
        status: response.status,
      });
    }
  }
  return { status: response.status, payload };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export class OpenAIWebOAuthProvider {
  constructor(
    private readonly config: OpenAIWebOAuthConfig = OPENAI_WEB_OAUTH_CONFIG,
    private readonly now: () => number = Date.now,
  ) {}

  /** 申请设备码：POST usercode 端点，JSON body 仅 {client_id}。 */
  async requestDeviceCode(): Promise<OpenAIWebDeviceCodeChallenge> {
    const { status, payload } = await postViaProxy(
      `${this.config.proxyBaseUrl}/usercode`,
      JSON.stringify({ client_id: this.config.clientId }),
      "application/json",
    );
    if (status !== 200) {
      throw new ApiError({
        message: `OpenAI 设备码申请失败（HTTP ${status}）`,
        url: `${this.config.proxyBaseUrl}/usercode`,
        method: "POST",
        status,
      });
    }

    const record = asRecord(payload) as OpenAIUserCodeResponse | null;
    const deviceAuthId = readTrimmed(record?.device_auth_id);
    const userCode = readTrimmed(record?.user_code);
    if (!deviceAuthId || !userCode) {
      throw new Error("OpenAI 设备码响应无效：缺少 device_auth_id 或 user_code");
    }

    const intervalSeconds = record?.interval;
    const pollIntervalMs =
      typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds)
        ? Math.min(
            Math.max(intervalSeconds * 1000, DEVICE_CODE_MIN_INTERVAL_MS),
            DEVICE_CODE_MAX_INTERVAL_MS,
          )
        : DEVICE_CODE_DEFAULT_INTERVAL_MS;
    const expiresIn = record?.expires_in;
    const ttlMs =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : DEVICE_CODE_DEFAULT_TTL_MS;

    return {
      deviceAuthId,
      userCode,
      // 输码页是 OpenAI 端固定部署，不经代理、不可配置。
      inputPageUrl: OPENAI_DEVICE_AUTH_INPUT_PAGE_URL,
      pollIntervalMs,
      expiresAt: this.now() + ttlMs,
    };
  }

  /**
   * 轮询设备码兑换：403/404=用户尚未确认（继续等待）、410=流程过期；
   * 其余 4xx 立即失败，5xx/网络异常向上抛出由调用方按瞬时错误重试。
   */
  async pollDeviceCodeToken(
    challenge: Pick<OpenAIWebDeviceCodeChallenge, "deviceAuthId" | "userCode">,
  ): Promise<OAuthDeviceCodePollResult> {
    const url = `${this.config.proxyBaseUrl}/device-token`;
    let result: ProxyResponse;
    try {
      result = await postViaProxy(
        url,
        JSON.stringify({
          device_auth_id: challenge.deviceAuthId,
          user_code: challenge.userCode,
        }),
        "application/json",
      );
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403 || error.status === 404) {
          return { status: "pending" };
        }
        if (error.status === 410) {
          return { status: "expired" };
        }
      }
      throw error;
    }

    if (result.status === 403 || result.status === 404) {
      return { status: "pending" };
    }
    if (result.status === 410) {
      return { status: "expired" };
    }
    if (result.status !== 200) {
      throw new ApiError({
        message: `OpenAI 设备码轮询失败（HTTP ${result.status}）`,
        url,
        method: "POST",
        status: result.status,
      });
    }

    const record = asRecord(result.payload) as OpenAIDeviceCodeTokenResponse | null;
    const authorizationCode = readTrimmed(record?.authorization_code);
    const codeVerifier = readTrimmed(record?.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("OpenAI 设备码兑换响应无效：缺少 authorization_code 或 code_verifier");
    }
    return { status: "ready", authorizationCode, codeVerifier };
  }

  /** 设备码授权码换 token；redirect_uri 用 OpenAI 端固定值（与 loopback 流程不同）。 */
  async exchangeDeviceCodeToken(params: {
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<OpenAIWebTokenExchangeResult> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_DEVICE_AUTH_REDIRECT_URI,
      client_id: this.config.clientId,
      code_verifier: params.codeVerifier,
    });
    return this.postTokenEndpoint(form, { requireRefreshToken: true, requireIdToken: true });
  }

  /** refresh_token 轮换：新 refresh_token 必须替换旧值并持久化（由调用方落盘）。 */
  async refreshToken(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!tokenSet.refreshToken) {
      throw new OpenAIWebRefreshInvalidError("OpenAI 登录缺少 refresh_token，请重新登录");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenSet.refreshToken,
      client_id: this.config.clientId,
      scope: OPENAI_OAUTH_REFRESH_SCOPE,
    });
    try {
      const result = await this.postTokenEndpoint(form, {
        requireRefreshToken: false,
        requireIdToken: false,
      });
      return {
        accessToken: result.tokenSet.accessToken,
        // refresh_token 一次性轮换：响应带新值时必须替换；未带时保留旧值兜底。
        refreshToken: result.tokenSet.refreshToken ?? tokenSet.refreshToken,
        expiresAt: result.tokenSet.expiresAt,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        const invalidCode = REFRESH_INVALID_ERROR_CODES.some((code) =>
          error.message.includes(code),
        );
        if (error.status === 401 || error.status === 403 || invalidCode) {
          throw new OpenAIWebRefreshInvalidError(
            `OpenAI refresh token 已失效（${error.status ?? "error"}）: ${error.message}`,
          );
        }
      }
      throw error;
    }
  }

  private async postTokenEndpoint(
    form: URLSearchParams,
    options: { requireRefreshToken: boolean; requireIdToken: boolean },
  ): Promise<OpenAIWebTokenExchangeResult> {
    const url = `${this.config.proxyBaseUrl}/token`;
    const { status, payload } = await postViaProxy(
      url,
      form.toString(),
      "application/x-www-form-urlencoded",
    );
    if (status !== 200) {
      const record = asRecord(payload);
      const errorMessage =
        (typeof record?.error === "string" ? record.error : "") ||
        (typeof record?.error_description === "string" ? record.error_description : "") ||
        `HTTP ${status}`;
      throw new ApiError({ message: errorMessage, url, method: "POST", status });
    }

    const record = asRecord(payload) as OpenAITokenResponse | null;
    const accessToken = readTrimmed(record?.access_token);
    const refreshToken = readTrimmed(record?.refresh_token);
    const idToken = readTrimmed(record?.id_token);
    if (!accessToken) {
      throw new Error("OpenAI token 交换失败：响应缺少 access_token");
    }
    // 授权码流程缺 refresh_token 或 id_token 视为登录失败（spec §2.2）；
    // refresh 流程只要求新 access_token（refresh_token 未轮换时由调用方保留旧值）。
    if (options.requireRefreshToken && !refreshToken) {
      throw new Error("OpenAI token 交换失败：响应缺少 refresh_token");
    }
    if (options.requireIdToken && !idToken) {
      throw new Error("OpenAI token 交换失败：响应缺少 id_token");
    }

    const rawProfile = idToken ? parseOpenAIWebIdTokenProfile(idToken) : null;
    if (idToken && !rawProfile) {
      throw new Error("OpenAI token 交换失败：id_token 无法解析出账号身份");
    }

    return {
      tokenSet: {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        expiresAt: resolveExpiresAt(record ?? {}, this.now),
      },
      userInfo: {
        id: rawProfile?.chatgpt_account_id || rawProfile?.sub || "unknown",
        username: rawProfile?.email || rawProfile?.sub || "user",
        displayName: rawProfile?.email || rawProfile?.sub || "User",
      },
      rawProfile: rawProfile ?? { chatgpt_account_id: "", email: "", sub: "" },
    };
  }
}
