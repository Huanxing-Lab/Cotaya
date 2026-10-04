/* eslint-disable max-lines -- OpenAI adapter 集中承载授权码+PKCE/loopback/设备码/refresh 轮换/id_token 解析五段协议差异，拆散会让三端协议事实漂移。 */
import { createHash, randomBytes } from "node:crypto";
import {
  ApiError,
  OPENAI_ACCESS_TOKEN_DEFAULT_TTL_SECONDS,
  OPENAI_DEVICE_AUTH_REDIRECT_URI,
  OPENAI_OAUTH_AUTH_SCOPE,
  OPENAI_OAUTH_REFRESH_SCOPE,
  OPENAI_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthDeviceCodeChallenge,
  type OAuthDeviceCodePollResult,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import { OPENAI_DEVICE_AUTH_ENDPOINTS } from "./openaiProviderConfig.js";
import {
  startOpenAILoopbackCallbackServer,
  type OpenAILoopbackCallbackServer,
} from "./openaiLoopbackCallbackServer.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** 设备码轮询间隔缺省值与上下限（OpenAI 端通常下发 5s）。 */
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_MAX_INTERVAL_MS = 60_000;
/** 设备码 user_code 有效期缺省 15 分钟（响应未带 expires_in 时使用）。 */
const DEVICE_CODE_DEFAULT_TTL_MS = 15 * 60_000;
/** PKCE/用户信息内存缓存的清理窗口：超过后视为废弃登录会话。 */
const FLOW_CACHE_TTL_MS = 10 * 60_000;
/** refresh 失效的稳定错误码（OpenAI 端语义：过期/重放/已作废，均需重新登录）。 */
const REFRESH_INVALID_ERROR_CODES = [
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
] as const;

const log = createServiceLogger("openaiOAuth");

/** refresh token 已失效（过期/重放/作废）：凭据不可再用，必须引导重新登录。 */
export class OpenAIRefreshTokenInvalidError extends Error {
  constructor(message = "OpenAI refresh token 已失效，请重新登录") {
    super(message);
    this.name = "OpenAIRefreshTokenInvalidError";
  }
}

interface OpenAITokenResponse {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  expires_in?: number | null;
  error?: string | null;
  error_description?: string | null;
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

interface OpenAIFlowRecord {
  codeVerifier: string;
  createdAt: number;
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

/** base64url 解 JWT payload（与 shared resolveJwtExpiration 同等信任模型：不验签）。 */
function decodeIdTokenPayload(idToken: string): OpenAIIdTokenPayload | null {
  const payloadSegment = idToken.split(".")[1];
  if (!payloadSegment) {
    return null;
  }
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as OpenAIIdTokenPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * id_token → OAuthUserProfile。
 * user_info.id = chatgpt_account_id（顶层 claim 或 https://api.openai.com/auth 命名空间下）；
 * username/displayName = email，缺省回退 sub；rawProfile 保留原始 claim 供排查。
 */
export function parseOpenAIIdTokenProfile(idToken: string): OAuthUserProfile | null {
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
  const username = email || sub;
  return {
    id,
    username,
    displayName: username,
    rawProfile: { chatgpt_account_id: chatgptAccountId, email, sub },
  };
}

/** 判定 refresh 失败是否属于"凭据已失效"（需重登），区分瞬时网络/服务端错误。 */
export function isOpenAIRefreshInvalidError(error: unknown): boolean {
  if (error instanceof OpenAIRefreshTokenInvalidError) {
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

/**
 * OpenAI（ChatGPT 账号）OAuth 协议适配器。
 *
 * 与 zai/bigmodel 的关键差异：
 * - 回调通道是固定端口 loopback HTTP server（redirect_uri=http://localhost:1455/auth/callback），
 *   不走应用 deep link；server 生命周期由本 adapter 管理，OAuthService 在 pendingState 里持有句柄；
 * - 授权码带 PKCE S256，code_verifier 由本地生成并按 state 暂存；
 * - 设备码 fallback：code_verifier 由服务端返回（非本地生成），换 token 的 redirect_uri
 *   固定为 https://auth.openai.com/deviceauth/callback；
 * - 无远端 userinfo：用户信息内联在 id_token，登录时解析一次并按 state 暂存；
 * - refresh_token 一次性轮换：新值必须替换旧值并持久化。
 */
export class OpenAIProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = OPENAI_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  /** loopback 授权码流程的 PKCE verifier，按 state 暂存（登录会话内存态，不落盘）。 */
  private readonly loopbackFlowsByState = new Map<string, OpenAIFlowRecord>();
  /** 登录时从 id_token 解出的用户信息，handleCallback/设备码完成阶段按 state 取一次。 */
  private readonly profilesByState = new Map<
    string,
    { profile: OAuthUserProfile; createdAt: number }
  >();

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    // RFC 7636：verifier 43-128 字符。base64url(48 bytes) = 64 字符，落在合法区间。
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.storeFlow(context.state, codeVerifier);

    const query = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: context.redirectUri,
      response_type: "code",
      scope: OPENAI_OAUTH_AUTH_SCOPE,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
      state: context.state,
    });
    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    const code = readTrimmed(parsed.searchParams.get("code"));
    const state = readTrimmed(parsed.searchParams.get("state"));
    if (!code || !state) {
      throw new Error("OpenAI OAuth 回调缺少 code 或 state 参数");
    }
    const attribution = parseOAuthLoginAttribution(parsed.searchParams);
    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const flow = this.consumeFlow(params.state);
    if (!flow) {
      throw new Error("OpenAI OAuth code_verifier 缺失：state 不匹配或登录流程已过期");
    }
    return this.requestTokenSet({
      state: params.state,
      code: params.code,
      redirectUri: context.redirectUri,
      codeVerifier: flow.codeVerifier,
      now: context.now,
      // 授权码流程缺 refresh_token 或 id_token 视为登录失败（spec §2.2）。
      requireRefreshToken: true,
      requireIdToken: true,
    });
  }

  // ---- 设备码 fallback（编排入口在 OAuthService；这里只做协议边界） ----

  async requestDeviceCode(context: OAuthProviderContext): Promise<OAuthDeviceCodeChallenge> {
    const payload = await readApiJson<OpenAIUserCodeResponse>(
      this.apiClient,
      OPENAI_DEVICE_AUTH_ENDPOINTS.usercodeUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: this.config.appId }),
        timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
      },
    );
    const deviceAuthId = readTrimmed(payload.device_auth_id);
    const userCode = readTrimmed(payload.user_code);
    if (!deviceAuthId || !userCode) {
      throw new Error("OpenAI 设备码响应无效：缺少 device_auth_id 或 user_code");
    }
    const intervalSeconds = payload.interval;
    const pollIntervalMs =
      typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds)
        ? Math.min(
            Math.max(intervalSeconds * 1000, DEVICE_CODE_MIN_INTERVAL_MS),
            DEVICE_CODE_MAX_INTERVAL_MS,
          )
        : DEVICE_CODE_DEFAULT_INTERVAL_MS;
    const expiresIn = payload.expires_in;
    const ttlMs =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : DEVICE_CODE_DEFAULT_TTL_MS;
    return {
      deviceAuthId,
      userCode,
      inputPageUrl: OPENAI_DEVICE_AUTH_ENDPOINTS.inputPageUrl,
      pollIntervalMs,
      expiresAt: context.now() + ttlMs,
    };
  }

  async pollDeviceCodeToken(
    challenge: OAuthDeviceCodeChallenge,
  ): Promise<OAuthDeviceCodePollResult> {
    let payload: OpenAIDeviceCodeTokenResponse;
    try {
      payload = await readApiJson<OpenAIDeviceCodeTokenResponse>(
        this.apiClient,
        OPENAI_DEVICE_AUTH_ENDPOINTS.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_auth_id: challenge.deviceAuthId,
            user_code: challenge.userCode,
          }),
          timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (error instanceof ApiError) {
        // OpenAI 设备码轮询语义：403/404=用户尚未确认（继续等待）、410=流程过期。
        if (error.status === 403 || error.status === 404) {
          return { status: "pending" };
        }
        if (error.status === 410) {
          return { status: "expired" };
        }
      }
      throw error;
    }
    const authorizationCode = readTrimmed(payload.authorization_code);
    const codeVerifier = readTrimmed(payload.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("OpenAI 设备码兑换响应无效：缺少 authorization_code 或 code_verifier");
    }
    return { status: "ready", authorizationCode, codeVerifier };
  }

  async exchangeDeviceCodeToken(
    params: { authorizationCode: string; codeVerifier: string },
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    return this.requestTokenSet({
      state: context.state,
      code: params.authorizationCode,
      // 设备码流程换 token 的 redirect_uri 是 OpenAI 端固定值，与 loopback 不同。
      redirectUri: OPENAI_DEVICE_AUTH_REDIRECT_URI,
      codeVerifier: params.codeVerifier,
      now: context.now,
      requireRefreshToken: true,
      requireIdToken: true,
    });
  }

  async refreshToken(
    tokenSet: OAuthTokenSet,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    if (!tokenSet.refreshToken) {
      throw new OpenAIRefreshTokenInvalidError("OpenAI 登录缺少 refresh_token，请重新登录");
    }
    try {
      const response = await this.postTokenEndpoint({
        grant_type: "refresh_token",
        refresh_token: tokenSet.refreshToken,
        client_id: this.config.appId,
        scope: OPENAI_OAUTH_REFRESH_SCOPE,
      });
      const accessToken = readTrimmed(response.access_token);
      if (!accessToken) {
        throw new Error("OpenAI token 刷新响应缺少 access_token");
      }
      // refresh_token 一次性轮换：响应带新值时必须替换旧值；未带时保留旧值兜底。
      const nextRefreshToken = readTrimmed(response.refresh_token) ?? tokenSet.refreshToken;
      return {
        accessToken,
        refreshToken: nextRefreshToken,
        expiresAt: resolveExpiresAt(response, context.now),
      };
    } catch (error) {
      if (error instanceof ApiError) {
        // 失效判定：HTTP 401/403，或错误体 error 码为
        // refresh_token_expired / refresh_token_reused / refresh_token_invalidated
        //（postTokenEndpoint 已把错误体的 error/error_description 解析进 message）。
        const invalidCode = REFRESH_INVALID_ERROR_CODES.some((code) =>
          error.message.includes(code),
        );
        if (error.status === 401 || error.status === 403 || invalidCode) {
          throw new OpenAIRefreshTokenInvalidError(
            `OpenAI refresh token 已失效（${error.status ?? "error"}）: ${error.message}`,
          );
        }
      }
      throw error;
    }
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    const cached = this.profilesByState.get(context.state);
    if (cached) {
      this.profilesByState.delete(context.state);
      return cached.profile;
    }
    // tokenSet 不含 id_token（不落盘），无法重建用户信息；返回最小兜底，
    // 让既有"获取用户信息失败不阻塞登录"的语义继续成立。
    log.debug("openai user info cache miss; fallback to placeholder profile", {
      state: context.state.slice(0, 8),
    });
    return { id: "unknown", username: "user", displayName: "User" };
  }

  // ---- loopback 回调 server（OAuthService 在 pendingState 中持有句柄） ----

  async startLoopbackCallbackServer(
    onCallback: (url: string) => void,
  ): Promise<OpenAILoopbackCallbackServer> {
    const port = Number(new URL(this.redirectUri).port) || 1455;
    return startOpenAILoopbackCallbackServer({ port, onCallback });
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(`OpenAI OAuth 异常: ${String(error)}`);
  }

  private async requestTokenSet(input: {
    state: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    now: () => number;
    requireRefreshToken: boolean;
    requireIdToken: boolean;
  }): Promise<OAuthTokenSet> {
    const response = await this.postTokenEndpoint({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.config.appId,
      code_verifier: input.codeVerifier,
    });

    const accessToken = readTrimmed(response.access_token);
    const refreshToken = readTrimmed(response.refresh_token);
    const idToken = readTrimmed(response.id_token);
    if (!accessToken) {
      throw new Error(
        `OpenAI token 交换失败: ${readTrimmed(response.error) ?? "响应缺少 access_token"}`,
      );
    }
    // refresh_token（offline_access）与 id_token 缺失说明授权范围异常，按登录失败处理。
    if (input.requireRefreshToken && !refreshToken) {
      throw new Error("OpenAI token 交换失败：响应缺少 refresh_token");
    }
    if (input.requireIdToken && !idToken) {
      throw new Error("OpenAI token 交换失败：响应缺少 id_token");
    }

    const profile = idToken ? parseOpenAIIdTokenProfile(idToken) : null;
    if (idToken && !profile) {
      throw new Error("OpenAI token 交换失败：id_token 无法解析出账号身份");
    }
    if (profile) {
      // id_token 只在登录时出现一次；按 state 暂存，供 fetchUserInfo 取用。
      this.storeProfile(input.state, profile);
    }

    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: resolveExpiresAt(response, input.now),
    };
  }

  private async postTokenEndpoint(form: Record<string, string>): Promise<OpenAITokenResponse> {
    const body = new URLSearchParams(form).toString();
    const response = await this.apiClient.request(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      const message = (await response.text().catch(() => "")).trim();
      let parsedMessage = message;
      try {
        const parsed = JSON.parse(message) as { error?: unknown; error_description?: unknown };
        parsedMessage =
          (typeof parsed.error === "string" ? parsed.error : "") ||
          (typeof parsed.error_description === "string" ? parsed.error_description : "") ||
          message;
      } catch {
        // 非 JSON 错误体按原文透出
      }
      throw new ApiError({
        message: parsedMessage || `HTTP ${response.status}`,
        url: this.config.tokenUrl,
        method: "POST",
        status: response.status,
      });
    }
    return (await response.json()) as OpenAITokenResponse;
  }

  private storeFlow(state: string, codeVerifier: string): void {
    const now = Date.now();
    for (const [key, record] of this.loopbackFlowsByState) {
      if (now - record.createdAt > FLOW_CACHE_TTL_MS) {
        this.loopbackFlowsByState.delete(key);
      }
    }
    this.loopbackFlowsByState.set(state, { codeVerifier, createdAt: now });
  }

  private consumeFlow(state: string): OpenAIFlowRecord | null {
    const record = this.loopbackFlowsByState.get(state);
    if (record) {
      this.loopbackFlowsByState.delete(state);
    }
    return record ?? null;
  }

  private storeProfile(state: string, profile: OAuthUserProfile): void {
    const now = Date.now();
    for (const [key, record] of this.profilesByState) {
      if (now - record.createdAt > FLOW_CACHE_TTL_MS) {
        this.profilesByState.delete(key);
      }
    }
    if (!state) {
      return;
    }
    this.profilesByState.set(state, { profile, createdAt: now });
  }
}
