import {
  BIGMODEL_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type ApiClient,
} from "@zcode/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import { BigModelProviderAdapter } from "./bigmodelProviderAdapter.js";
import { OpenAIProviderAdapter } from "./openaiProviderAdapter.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";
import { ZaiProviderAdapter } from "./zaiProviderAdapter.js";

/** 根据运行时配置创建可用 provider adapter */
export function createOAuthProviderAdapters(
  config: OAuthRuntimeConfig,
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  const adapters: OAuthProviderAdapter[] = [];
  const apiClient = options.apiClient;
  if (!apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }

  for (const providerConfig of config.providers) {
    switch (providerConfig.id) {
      case BIGMODEL_PROVIDER_ID:
        adapters.push(new BigModelProviderAdapter(providerConfig, apiClient));
        break;
      case ZAI_PROVIDER_ID:
        adapters.push(new ZaiProviderAdapter(providerConfig, apiClient));
        break;
      case OPENAI_PROVIDER_ID:
        // openai 是独立身份域（与 z.ai 域互不删凭据），协议见 openaiProviderAdapter。
        adapters.push(new OpenAIProviderAdapter(providerConfig, apiClient));
        break;
      default:
        // 未知 provider 直接忽略，避免单个配置错误拖垮全部登录能力。
        break;
    }
  }

  return adapters;
}

export type {
  LoopbackDeviceCodeProviderAdapter,
  OAuthProviderAdapter,
  OAuthProviderContext,
} from "./providerAdapter.js";
