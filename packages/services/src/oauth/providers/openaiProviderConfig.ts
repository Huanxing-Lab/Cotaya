import {
  OPENAI_PROVIDER_ID,
  OPENAI_DEVICE_AUTH_INPUT_PAGE_URL,
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USERCODE_URL,
  OPENAI_OAUTH_AUTHORIZE_URL,
  OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
  OPENAI_OAUTH_TOKEN_URL,
  resolveOpenAIOAuthClientId,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import { readBoolean } from "./configUtils.js";

/**
 * OpenAI（ChatGPT 账号）OAuth 运行时配置。
 *
 * 与 zai/bigmodel 不同：无后端 userinfo（用户信息内联在 id_token 里），
 * 端点与 client_id 全部为公开常量（shared openaiOAuthEndpoint.ts），
 * 仅提供 env 覆盖 client_id（OPENAI_OAUTH_CLIENT_ID）与启用开关。
 */
export const OPENAI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: OPENAI_PROVIDER_ID,
  displayName: "OpenAI",
  enabled: true,
  // openai 排在 z.ai 域两个 provider 之后；登录入口排序最终由 UI 决定。
  order: 2,
  authorizeUrl: OPENAI_OAUTH_AUTHORIZE_URL,
  tokenUrl: OPENAI_OAUTH_TOKEN_URL,
  userinfoUrl: undefined,
  appId: resolveOpenAIOAuthClientId(),
  redirectUri: OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
};

export function createOpenAIProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
): OAuthProviderRuntimeConfig {
  return {
    ...OPENAI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "OPENAI_OAUTH_ENABLED", OPENAI_OAUTH_PROVIDER_CONFIG.enabled),
    // client_id 是官方 Codex CLI 公开值；env 覆盖用于测试环境隔离。
    appId: resolveOpenAIOAuthClientId(env),
  };
}

/** 设备码流程端点常量的本地别名：adapter 与测试共用，避免散落字符串。 */
export const OPENAI_DEVICE_AUTH_ENDPOINTS = {
  usercodeUrl: OPENAI_DEVICE_AUTH_USERCODE_URL,
  tokenUrl: OPENAI_DEVICE_AUTH_TOKEN_URL,
  inputPageUrl: OPENAI_DEVICE_AUTH_INPUT_PAGE_URL,
} as const;
