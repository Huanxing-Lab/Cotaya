/**
 * OpenAI（ChatGPT 账号）OAuth 端点与指纹常量。
 *
 * 全部为公开值（官方 Codex CLI 公开 client_id 与端点），不含 secret；
 * 与 z.ai 端点一样收敛在 shared，供 Desktop OAuthService、CLI、Web 三端共用，
 * 避免各端各写一份导致行为漂移。env 覆盖沿用 zcodeEndpoint.ts 的
 * readProductEndpointEnv 惯例（构建期 define + 运行时 process.env）。
 *
 * 注意：OPENAI_OAUTH_ORIGIN 覆盖的是模型通道请求头 originator 的值（见 spec
 * openai-oauth-provider §2.7），不是 auth.openai.com 授权端点；授权端点为
 * OpenAI 侧固定部署，不提供 env 覆盖。
 */

import { readProductEndpointEnv } from "./zcodeEndpoint.js";

/** 授权/token/设备码端点所在 origin（OpenAI 固定部署，不随 env 变化）。 */
export const DEFAULT_OPENAI_AUTH_ORIGIN = "https://auth.openai.com";

/** 模型通道（Codex backend）默认 baseUrl，env OPENAI_CODEX_BASE_URL 可覆盖。 */
export const DEFAULT_OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** 官方 Codex CLI 公开 client_id，env OPENAI_OAUTH_CLIENT_ID 可覆盖。 */
export const DEFAULT_OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** loopback 回调固定端口：OpenAI 端注册的 redirect_uri 即 localhost:1455，不可改。 */
export const OPENAI_OAUTH_LOOPBACK_PORT = 1455;

/** 授权码主流程的 redirect_uri（loopback 回调路径）。 */
export const OPENAI_OAUTH_LOOPBACK_REDIRECT_URI = `http://localhost:${OPENAI_OAUTH_LOOPBACK_PORT}/auth/callback`;

/** 设备码流程换 token 时使用的 redirect_uri（OpenAI 端固定值）。 */
export const OPENAI_DEVICE_AUTH_REDIRECT_URI = `${DEFAULT_OPENAI_AUTH_ORIGIN}/deviceauth/callback`;

/** 授权入口：GET，参数含 client_id/redirect_uri/scope/PKCE/state。 */
export const OPENAI_OAUTH_AUTHORIZE_URL = `${DEFAULT_OPENAI_AUTH_ORIGIN}/oauth/authorize`;

/** 换 token / 刷新：POST，application/x-www-form-urlencoded。 */
export const OPENAI_OAUTH_TOKEN_URL = `${DEFAULT_OPENAI_AUTH_ORIGIN}/oauth/token`;

/** 设备码流程：申请 user_code，JSON body 仅 {client_id}。 */
export const OPENAI_DEVICE_AUTH_USERCODE_URL = `${DEFAULT_OPENAI_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`;

/** 设备码流程：轮询兑换 {device_auth_id, user_code} → {authorization_code, code_verifier}。 */
export const OPENAI_DEVICE_AUTH_TOKEN_URL = `${DEFAULT_OPENAI_AUTH_ORIGIN}/api/accounts/deviceauth/token`;

/** 设备码流程：用户输入 user_code 的页面。 */
export const OPENAI_DEVICE_AUTH_INPUT_PAGE_URL = `${DEFAULT_OPENAI_AUTH_ORIGIN}/codex/device`;

/** 授权码流程 scope（offline_access 才会下发 refresh_token）。 */
export const OPENAI_OAUTH_AUTH_SCOPE = "openid profile email offline_access";

/** 刷新 token 时的 scope（不含 offline_access，沿用官方 Codex CLI 行为）。 */
export const OPENAI_OAUTH_REFRESH_SCOPE = "openid profile email";

/** token 响应缺省 expires_in 按 3600s 处理。 */
export const OPENAI_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 3600;

/** 过期前 60 秒主动刷新（触发点在请求鉴权 resolveCurrent，单一刷新路径）。 */
export const OPENAI_REFRESH_BEFORE_EXPIRY_MS = 60_000;

/** 模型通道静态指纹头 originator 的默认值，env OPENAI_OAUTH_ORIGIN 可覆盖。 */
export const DEFAULT_OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";

/**
 * 模型通道静态指纹头 version：OpenAI 后端按客户端版本门控模型
 * （catalog minimal_client_version），取官方 Codex CLI 已发布版本号，
 * 真实账号校准后如需调整记入 spec deviations。
 */
export const DEFAULT_OPENAI_CODEX_ORIGINATOR_VERSION = "0.142.5";

export interface RuntimeOpenAIEndpointEnv {
  [key: string]: string | undefined;
  OPENAI_OAUTH_CLIENT_ID?: string;
  OPENAI_OAUTH_ORIGIN?: string;
  OPENAI_CODEX_BASE_URL?: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function resolveOpenAIOAuthClientId(
  env: RuntimeOpenAIEndpointEnv = readProductEndpointEnv(),
): string {
  return readRuntimeEnvValue(env, "OPENAI_OAUTH_CLIENT_ID") ?? DEFAULT_OPENAI_OAUTH_CLIENT_ID;
}

export function resolveOpenAICodexBaseUrl(
  env: RuntimeOpenAIEndpointEnv = readProductEndpointEnv(),
): string {
  return readRuntimeEnvValue(env, "OPENAI_CODEX_BASE_URL") ?? DEFAULT_OPENAI_CODEX_BASE_URL;
}

/** 模型通道 originator 指纹头的值；version 头无独立 env，与 originator 一起静态下发。 */
export function resolveOpenAICodexOriginator(
  env: RuntimeOpenAIEndpointEnv = readProductEndpointEnv(),
): string {
  return readRuntimeEnvValue(env, "OPENAI_OAUTH_ORIGIN") ?? DEFAULT_OPENAI_CODEX_ORIGINATOR;
}

/** 模型通道静态请求头（provider 规则 api.headers 的运行时等价值，供服务层校准用）。 */
export function buildOpenAICodexStaticHeaders(
  env: RuntimeOpenAIEndpointEnv = readProductEndpointEnv(),
): Readonly<Record<string, string>> {
  return Object.freeze({
    originator: resolveOpenAICodexOriginator(env),
    version: DEFAULT_OPENAI_CODEX_ORIGINATOR_VERSION,
  });
}
