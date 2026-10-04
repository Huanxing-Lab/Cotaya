/* eslint-disable max-lines -- OpenAI 薄客户端集中承载授权码+PKCE/loopback/设备码轮询/refresh 轮换/id_token 解析五段协议差异（与 services 层 OpenAIProviderAdapter 同理由），拆散会让两端口径漂移。 */
/**
 * OpenAI（ChatGPT 账号）OAuth 薄客户端：CLI 登录与 token 刷新的协议边界。
 *
 * 与 services 层 OpenAIProviderAdapter 是同一协议的两份实现（host 进程 vs CLI 进程，
 * 无法共享代码）；端点常量、client_id 与 scope 全部从 @zcode/shared 公开入口引用，
 * 避免两端口径漂移。协议事实（spec openai-oauth-provider §2.2）：
 * - 主流程＝授权码 + PKCE S256 + 固定端口 1455 loopback 回调；
 * - 设备码 fallback：1455 被占（EADDRINUSE）、--no-browser、浏览器打开失败；
 *   code_verifier 由服务端返回，换 token 的 redirect_uri 固定为 deviceauth/callback；
 * - refresh_token 一次性轮换，新值必须替换旧值并由调用方持久化；
 * - id_token 仅 base64url 解 payload（不验签），取 chatgpt_account_id/email/sub。
 */

import { createHash, randomBytes } from "node:crypto";
import type { HttpClientPort, HttpClientRunOptions, TraceContext } from "@zcode/contracts";
import {
  OPENAI_ACCESS_TOKEN_DEFAULT_TTL_SECONDS,
  OPENAI_DEVICE_AUTH_INPUT_PAGE_URL,
  OPENAI_DEVICE_AUTH_REDIRECT_URI,
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USERCODE_URL,
  OPENAI_OAUTH_AUTH_SCOPE,
  OPENAI_OAUTH_AUTHORIZE_URL,
  OPENAI_OAUTH_LOOPBACK_PORT,
  OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
  OPENAI_OAUTH_REFRESH_SCOPE,
  OPENAI_OAUTH_TOKEN_URL,
  resolveOpenAIOAuthClientId,
} from "@zcode/shared";
import { openUrlInBrowser, type BrowserOpenResult } from "./browser.js";
import { createLocalhostOAuthCallbackServer } from "./localhost-callback.js";

const OAUTH_STATE_BYTES = 32;
/** RFC 7636：verifier 43-128 字符；base64url(48 bytes) = 64 字符，落在合法区间。 */
const PKCE_VERIFIER_BYTES = 48;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
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

const LOOPBACK_CALLBACK_URL = new URL(OPENAI_OAUTH_LOOPBACK_REDIRECT_URI);
const LOOPBACK_CALLBACK_PATH = LOOPBACK_CALLBACK_URL.pathname;

export class OpenAIOAuthError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "OpenAIOAuthError";
  }
}

/** refresh token 已失效（过期/重放/作废）：凭据不可再用，必须引导重新登录。 */
export class OpenAIRefreshTokenInvalidError extends Error {
  constructor(message = "OpenAI refresh token 已失效，请重新登录", options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "OpenAIRefreshTokenInvalidError";
  }
}

/** oauth/token 端点非 2xx：携带 HTTP 状态，供刷新链路判定凭据是否已失效。 */
class OpenAITokenEndpointError extends OpenAIOAuthError {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenAITokenEndpointError";
    this.status = status;
  }
}

/** id_token 解析出的账号身份；id = chatgpt_account_id（缺省回退 sub）。 */
export interface OpenAIOAuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  chatgptAccountId?: string;
  email?: string;
  sub?: string;
}

export interface OpenAIOAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳；expires_in 缺省按 3600s。 */
  expiresAt: number;
  profile: OpenAIOAuthUserProfile;
}

export interface OpenAILoginCallbacks {
  onAuthorizeUrl?(authorizeUrl: string): void | Promise<void>;
  /** 降级设备码流程时回调：客户端必须把 userCode 与输码页地址展示给用户。 */
  onDeviceCode?(data: { userCode: string; inputPageUrl: string }): void | Promise<void>;
  onBrowserOpen?(result: BrowserOpenResult): void | Promise<void>;
}

export interface LoginWithOpenAIOAuthOptions extends OpenAILoginCallbacks {
  httpClient: HttpClientPort;
  env?: Record<string, string | undefined>;
  /** 无浏览器环境直接走设备码（不尝试 loopback）。 */
  noBrowser?: boolean;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
  trace?: TraceContext;
}

export interface LoginWithOpenAIOAuthResult {
  /** 实际完成的流程：loopback 主流程或设备码 fallback。 */
  method: "loopback" | "device-code";
  browser?: BrowserOpenResult;
  tokenSet: OpenAIOAuthTokenSet;
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
 * id_token → 账号身份。username/displayName = email（缺省回退 sub），
 * rawProfile 字段（chatgpt_account_id/email/sub）保留在 profile 上供持久化。
 */
export function parseOpenAIOAuthIdTokenProfile(idToken: string): OpenAIOAuthUserProfile | null {
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
  return {
    id,
    username: email || sub,
    displayName: email || sub,
    ...(chatgptAccountId ? { chatgptAccountId } : {}),
    ...(email ? { email } : {}),
    ...(sub ? { sub } : {}),
  };
}

function resolveExpiresAt(response: OpenAITokenResponse, now: () => number): number {
  const expiresIn = response.expires_in;
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : OPENAI_ACCESS_TOKEN_DEFAULT_TTL_SECONDS;
  return now() + seconds * 1000;
}

async function requestJson<TReturn>(
  httpClient: HttpClientPort,
  url: string,
  init: {
    body: Uint8Array;
    contentType: string;
    now: () => number;
    signal?: AbortSignal;
    trace?: TraceContext;
  },
): Promise<{ status: number; payload: TReturn }> {
  const response = await httpClient.request(
    {
      body: init.body,
      headers: {
        "Content-Type": init.contentType,
        Accept: "application/json",
      },
      maxResponseBytes: 64 * 1024,
      method: "POST",
      timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
      trace: init.trace,
      url,
    },
    { signal: init.signal },
  );
  const text = new TextDecoder().decode(response.body);
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // 非 JSON 响应体按空对象处理，由调用方的字段校验给出具体错误。
    payload = {};
  }
  return { status: response.status, payload: payload as TReturn };
}

/** POST oauth/token（application/x-www-form-urlencoded）；非 2xx 解析错误体后抛错。 */
async function postTokenEndpoint(
  httpClient: HttpClientPort,
  form: Record<string, string>,
  options: {
    now: () => number;
    signal?: AbortSignal;
    trace?: TraceContext;
  },
): Promise<OpenAITokenResponse> {
  const { status, payload } = await requestJson<OpenAITokenResponse>(
    httpClient,
    OPENAI_OAUTH_TOKEN_URL,
    {
      body: new TextEncoder().encode(new URLSearchParams(form).toString()),
      contentType: "application/x-www-form-urlencoded",
      now: options.now,
      signal: options.signal,
      trace: options.trace,
    },
  );
  if (status < 200 || status >= 300) {
    const message =
      readTrimmed(payload.error) ?? readTrimmed(payload.error_description) ?? `HTTP ${status}`;
    throw new OpenAITokenEndpointError(`OpenAI token 请求失败（${status}）: ${message}`, status);
  }
  return payload;
}

/** 授权码/设备码换 token；refresh_token 与 id_token 缺失按登录失败处理（spec §2.2）。 */
async function exchangeTokenSet(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  httpClient: HttpClientPort;
  now: () => number;
  redirectUri: string;
  signal?: AbortSignal;
  trace?: TraceContext;
}): Promise<OpenAIOAuthTokenSet> {
  const response = await postTokenEndpoint(
    input.httpClient,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      // client_id 必须用调用方（authorize URL 同源）解析好的值透传，不能在函数内按
      // 进程 env 重新解析：注入 env 带 OPENAI_OAUTH_CLIENT_ID 覆盖而进程 env 没有时，
      // 授权与换 token 用不同 client_id 会导致难以排查的 PKCE/client 不匹配失败。
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    },
    input,
  );
  const accessToken = readTrimmed(response.access_token);
  const refreshToken = readTrimmed(response.refresh_token);
  const idToken = readTrimmed(response.id_token);
  if (!accessToken) {
    throw new OpenAIOAuthError(
      `OpenAI token 交换失败: ${readTrimmed(response.error) ?? "响应缺少 access_token"}`,
    );
  }
  if (!refreshToken) {
    throw new OpenAIOAuthError("OpenAI token 交换失败：响应缺少 refresh_token");
  }
  if (!idToken) {
    throw new OpenAIOAuthError("OpenAI token 交换失败：响应缺少 id_token");
  }
  const profile = parseOpenAIOAuthIdTokenProfile(idToken);
  if (!profile) {
    throw new OpenAIOAuthError("OpenAI token 交换失败：id_token 无法解析出账号身份");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(response, input.now),
    profile,
  };
}

function isPortInUseError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 登录编排：loopback 主流程 + 设备码 fallback。 */
export async function loginWithOpenAIOAuth(
  options: LoginWithOpenAIOAuthOptions,
): Promise<LoginWithOpenAIOAuthResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const signal = options.signal;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const openBrowser = options.openBrowser ?? openUrlInBrowser;
  const clientId = resolveOpenAIOAuthClientId(options.env);

  if (options.noBrowser) {
    // --no-browser 属于明确的无浏览器环境，直接走设备码，不占用 1455 端口。
    return loginWithDeviceCode({
      callbacks: options,
      clientId,
      deadline,
      httpClient: options.httpClient,
      noBrowser: true,
      now,
      openBrowser,
      signal,
      sleep,
      trace: options.trace,
    });
  }

  const state = randomBytes(OAUTH_STATE_BYTES).toString("hex");
  const codeVerifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
  const server = await createLocalhostOAuthCallbackServer({
    callbackPath: LOOPBACK_CALLBACK_PATH,
    state,
    port: OPENAI_OAUTH_LOOPBACK_PORT,
  }).catch((error: unknown) => {
    // 1455 被占是设备码 fallback 的第一条触发条件；其余 listen 错误按登录失败抛出。
    if (isPortInUseError(error)) {
      return null;
    }
    throw error;
  });

  if (!server) {
    return loginWithDeviceCode({
      callbacks: options,
      clientId,
      deadline,
      httpClient: options.httpClient,
      noBrowser: false,
      now,
      openBrowser,
      signal,
      sleep,
      trace: options.trace,
    });
  }

  try {
    signal?.throwIfAborted();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
      response_type: "code",
      scope: OPENAI_OAUTH_AUTH_SCOPE,
      code_challenge_method: "S256",
      code_challenge: createPkceChallenge(codeVerifier),
      state,
    });
    const authorizeUrl = `${OPENAI_OAUTH_AUTHORIZE_URL}?${query.toString()}`;
    await options.onAuthorizeUrl?.(authorizeUrl);

    const browser = await openBrowser(authorizeUrl);
    await options.onBrowserOpen?.(browser);
    if (!browser.opened) {
      // 打开浏览器失败同样降级设备码（spec §2.2 fallback 条件 2），用户可手动打开输码页。
      await server.close();
      return loginWithDeviceCode({
        callbacks: options,
        clientId,
        deadline,
        httpClient: options.httpClient,
        noBrowser: true,
        now,
        openBrowser,
        signal,
        sleep,
        trace: options.trace,
      });
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new OpenAIOAuthError("Authorization timed out. Please retry login.");
    }
    const callback = await withTimeout(server.waitForCallback(), remainingMs);
    const tokenSet = await exchangeTokenSet({
      clientId,
      code: callback.code,
      codeVerifier,
      httpClient: options.httpClient,
      now,
      redirectUri: OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
      signal,
      trace: options.trace,
    });
    return { method: "loopback", browser, tokenSet };
  } finally {
    await server.close();
  }
}

async function loginWithDeviceCode(input: {
  callbacks: OpenAILoginCallbacks;
  clientId: string;
  deadline: number;
  httpClient: HttpClientPort;
  noBrowser: boolean;
  now: () => number;
  openBrowser: (url: string) => Promise<BrowserOpenResult>;
  signal?: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  trace?: TraceContext;
}): Promise<LoginWithOpenAIOAuthResult> {
  input.signal?.throwIfAborted();
  const { status, payload } = await requestJson<OpenAIUserCodeResponse>(
    input.httpClient,
    OPENAI_DEVICE_AUTH_USERCODE_URL,
    {
      body: new TextEncoder().encode(JSON.stringify({ client_id: input.clientId })),
      contentType: "application/json",
      now: input.now,
      signal: input.signal,
      trace: input.trace,
    },
  );
  if (status < 200 || status >= 300) {
    throw new OpenAIOAuthError(`OpenAI 设备码申请失败（${status}）`);
  }
  const deviceAuthId = readTrimmed(payload.device_auth_id);
  const userCode = readTrimmed(payload.user_code);
  if (!deviceAuthId || !userCode) {
    throw new OpenAIOAuthError("OpenAI 设备码响应无效：缺少 device_auth_id 或 user_code");
  }

  await input.callbacks.onDeviceCode?.({ userCode, inputPageUrl: OPENAI_DEVICE_AUTH_INPUT_PAGE_URL });

  const browser = input.noBrowser
    ? undefined
    : await input.openBrowser(OPENAI_DEVICE_AUTH_INPUT_PAGE_URL);
  if (browser) await input.callbacks.onBrowserOpen?.(browser);

  const intervalSeconds = payload.interval;
  const pollIntervalMs =
    typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds)
      ? Math.min(
          Math.max(intervalSeconds * 1000, DEVICE_CODE_MIN_INTERVAL_MS),
          DEVICE_CODE_MAX_INTERVAL_MS,
        )
      : DEVICE_CODE_DEFAULT_INTERVAL_MS;
  const expiresIn = payload.expires_in;
  const flowExpiresAt =
    input.now() +
    (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn * 1000
      : DEVICE_CODE_DEFAULT_TTL_MS);

  // 轮询语义：403/404=用户尚未确认（继续等待）、410=流程过期、2xx=拿到授权码与服务端 verifier。
  let ready: { authorizationCode: string; codeVerifier: string } | undefined;
  while (!ready) {
    input.signal?.throwIfAborted();
    const now = input.now();
    if (now >= Math.min(input.deadline, flowExpiresAt)) {
      throw new OpenAIOAuthError("Authorization timed out. Please retry login.");
    }
    await input.sleep(
      Math.min(pollIntervalMs, Math.max(0, Math.min(input.deadline, flowExpiresAt) - now)),
    );
    let poll: { status: number; payload: OpenAIDeviceCodeTokenResponse };
    try {
      poll = await requestJson<OpenAIDeviceCodeTokenResponse>(
        input.httpClient,
        OPENAI_DEVICE_AUTH_TOKEN_URL,
        {
          body: new TextEncoder().encode(
            JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
          ),
          contentType: "application/json",
          now: input.now,
          signal: input.signal,
          trace: input.trace,
        },
      );
    } catch {
      input.signal?.throwIfAborted();
      // 网络错误与 5xx/限流同为瞬时失败：保留 flow 按服务端间隔下一轮重试（与 services
      // 侧 pollOpenAIDeviceCode 的判定口径一致），仅主动 abort 立即终止。
      continue;
    }
    if (poll.status === 403 || poll.status === 404) {
      continue;
    }
    if (poll.status === 410) {
      throw new OpenAIOAuthError("OpenAI 设备码已过期，请重新执行登录");
    }
    if (poll.status < 200 || poll.status >= 300) {
      // 429 限流与 5xx 属瞬时失败，continue 等待重试；其余 4xx 是流程自身失败，抛出终止。
      if (poll.status === 429 || poll.status >= 500) {
        continue;
      }
      throw new OpenAIOAuthError(`OpenAI 设备码轮询失败（${poll.status}）`);
    }
    const authorizationCode = readTrimmed(poll.payload.authorization_code);
    const codeVerifier = readTrimmed(poll.payload.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new OpenAIOAuthError(
        "OpenAI 设备码兑换响应无效：缺少 authorization_code 或 code_verifier",
      );
    }
    ready = { authorizationCode, codeVerifier };
  }

  const tokenSet = await exchangeTokenSet({
    clientId: input.clientId,
    code: ready.authorizationCode,
    // 设备码流程的 verifier 由服务端返回，redirect_uri 固定为 deviceauth/callback。
    codeVerifier: ready.codeVerifier,
    httpClient: input.httpClient,
    now: input.now,
    redirectUri: OPENAI_DEVICE_AUTH_REDIRECT_URI,
    signal: input.signal,
    trace: input.trace,
  });
  return { method: "device-code", ...(browser ? { browser } : {}), tokenSet };
}

/**
 * 刷新 access_token（grant_type=refresh_token）。
 * refresh_token 一次性轮换：响应带新值时必须替换旧值；失效（HTTP 401/403 或
 * refresh_token_expired/reused/invalidated）抛 OpenAIRefreshTokenInvalidError。
 */
export async function refreshOpenAITokenSet(options: {
  env?: Record<string, string | undefined>;
  httpClient: HttpClientPort;
  refreshToken: string;
  now?: () => number;
  trace?: TraceContext;
  runOptions?: HttpClientRunOptions;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const now = options.now ?? Date.now;
  let response: OpenAITokenResponse;
  try {
    response = await postTokenEndpoint(
      options.httpClient,
      {
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
        // client_id 沿用调用方 env 解析（与 authorize 同源），缺省回落构建期 define/process.env。
        client_id: resolveOpenAIOAuthClientId(options.env),
        scope: OPENAI_OAUTH_REFRESH_SCOPE,
      },
      { now, trace: options.trace },
    );
  } catch (error) {
    // 失效判定（spec §2.5）：HTTP 401/403，或错误体 error 码为
    // refresh_token_expired / refresh_token_reused / refresh_token_invalidated。
    const invalidByStatus =
      error instanceof OpenAITokenEndpointError && (error.status === 401 || error.status === 403);
    const invalidCode =
      error instanceof OpenAIOAuthError &&
      REFRESH_INVALID_ERROR_CODES.some((code) => error.message.includes(code));
    if (invalidByStatus || invalidCode) {
      throw new OpenAIRefreshTokenInvalidError(error.message, { cause: error });
    }
    throw error;
  }
  const accessToken = readTrimmed(response.access_token);
  if (!accessToken) {
    throw new OpenAIOAuthError("OpenAI token 刷新响应缺少 access_token");
  }
  const nextRefreshToken = readTrimmed(response.refresh_token) ?? options.refreshToken;
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: resolveExpiresAt(response, now),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OpenAIOAuthError("Authorization timed out. Please retry login.")),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
