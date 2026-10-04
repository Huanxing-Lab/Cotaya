import { OPENAI_REFRESH_BEFORE_EXPIRY_MS, type ApiClient, type OAuthTokenSet } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { isOpenAIRefreshInvalidError } from "./providers/openaiProviderAdapter.js";
import { OpenAIProviderAdapter } from "./providers/openaiProviderAdapter.js";
import { createOpenAIProviderRuntimeConfig } from "./providers/openaiProviderConfig.js";

const log = createServiceLogger("openaiRequestAuth");

/** OpenAI 模型通道请求鉴权材料：access_token 作 apiKey，chatgpt-account-id 为必带动态头。 */
export interface OpenAIRequestAuthMaterial {
  apiKey: string;
  headers: { "chatgpt-account-id": string };
}

export interface OpenAIRequestAuthRefresherOptions {
  readonly apiClient: ApiClient;
  readonly env?: NodeJS.ProcessEnv;
  /** 读取 oauth:openai:* token set（含 expires_at）。 */
  readonly loadTokenSet: () => Promise<OAuthTokenSet | null>;
  /** 刷新结果落盘（refresh_token 轮换：新值必须替换旧值并持久化）。 */
  readonly saveTokenSet: (tokenSet: OAuthTokenSet) => Promise<void>;
  /** 读取 chatgpt_account_id（user_info.id）。 */
  readonly loadChatGPTAccountId: () => Promise<string | null>;
  /** refresh 明确失效（过期/重放/作废）时回调；由注入方执行仅限 openai 域的清理。 */
  readonly onCredentialInvalid?: () => Promise<void>;
  readonly now?: () => number;
}

export interface OpenAIRequestAuthRefresher {
  resolveRequestAuth(): Promise<OpenAIRequestAuthMaterial | null>;
}

/**
 * OpenAI（ChatGPT 账号）请求鉴权解析器。
 *
 * - 触发点在 AccountProviderRequestAuthService.resolveCurrent（模型请求每次经
 *   refreshBeforeModelRequest 反向 RPC 取新材料），不引入定时器轮询的第二条刷新路径；
 * - 过期前 60 秒主动刷新，刷新带 single-flight 互斥：并发请求共享同一次轮换，
 *   防止双刷导致 refresh_token 一次性语义下的轮换竞态；
 * - refresh 明确失效时返回 null（调用方按凭据不可用处理）并回调清理；
 *   真正的会话清理由注入的 onCredentialInvalid 在 OAuth 会话变更队列内执行。
 */
export function createOpenAIRequestAuthRefresher(
  options: OpenAIRequestAuthRefresherOptions,
): OpenAIRequestAuthRefresher {
  const now = options.now ?? Date.now;
  // 刷新协议实现与登录共用同一 adapter 边界（纯函数式使用：不依赖其登录会话缓存）。
  const adapter = new OpenAIProviderAdapter(
    createOpenAIProviderRuntimeConfig(options.env ?? process.env),
    options.apiClient,
  );
  let refreshInFlight: Promise<OAuthTokenSet | null> | null = null;

  const refreshSingleFlight = async (tokenSet: OAuthTokenSet): Promise<OAuthTokenSet | null> => {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const refreshed = await adapter.refreshToken(tokenSet, {
            providerId: adapter.providerId,
            state: "",
            redirectUri: adapter.redirectUri,
            now,
          });
          // 写回前复核会话事实（对齐 OAuthService.refreshToken 的复核语义）：刷新在途
          // 期间用户可能已登出或完成新登录，直接写回会凭空复活已清除的凭据、或覆盖
          // 更新的轮换结果。openai 材料解析不依赖 active_provider（切到 z.ai 域后仍可
          // 用 openai 模型，轮换结果本就应落盘），因此只复核 access_token 快照一致性。
          const current = await options.loadTokenSet();
          if (current?.accessToken !== tokenSet.accessToken) {
            log.info("openai refresh write-back skipped; credential changed during refresh");
            return refreshed;
          }
          await options.saveTokenSet(refreshed);
          return refreshed;
        } catch (error) {
          if (isOpenAIRefreshInvalidError(error)) {
            log.info("openai refresh token invalid; credential requires re-login");
            await options.onCredentialInvalid?.().catch((callbackError: unknown) => {
              log.warn("openai credential invalid cleanup failed", { error: callbackError });
            });
          } else {
            log.warn("openai token refresh failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return null;
        } finally {
          refreshInFlight = null;
        }
      })();
    }
    return refreshInFlight;
  };

  return {
    async resolveRequestAuth(): Promise<OpenAIRequestAuthMaterial | null> {
      const tokenSet = await options.loadTokenSet();
      if (!tokenSet?.accessToken) {
        return null;
      }
      let accessToken = tokenSet.accessToken;
      // 过期前 60 秒主动刷新；expires_at 缺失（历史数据）时按已过期处理尽快校准。
      const expiresSoon =
        tokenSet.refreshToken !== undefined &&
        (tokenSet.expiresAt === undefined ||
          tokenSet.expiresAt - now() <= OPENAI_REFRESH_BEFORE_EXPIRY_MS);
      if (expiresSoon && tokenSet.refreshToken) {
        const refreshed = await refreshSingleFlight(tokenSet);
        if (!refreshed?.accessToken) {
          return null;
        }
        accessToken = refreshed.accessToken;
      }
      const accountId = (await options.loadChatGPTAccountId())?.trim();
      if (!accountId) {
        // chatgpt-account-id 是 codex 通道的必带头；缺失说明登录态不完整，按不可用处理。
        return null;
      }
      return { apiKey: accessToken, headers: { "chatgpt-account-id": accountId } };
    },
  };
}
