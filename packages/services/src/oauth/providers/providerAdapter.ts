import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthDeviceCodeChallenge,
  OAuthDeviceCodePollResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";

/** Provider 执行上下文 */
export interface OAuthProviderContext {
  providerId: OAuthProviderId;
  state: string;
  redirectUri: string;
  now: () => number;
}

/**
 * loopback 回调 + 设备码 fallback 能力（OpenAI；z.ai 域 provider 不实现）。
 * OAuthService 按该接口编排，避免在服务层写死 provider 判断。
 */
export interface LoopbackDeviceCodeProviderAdapter {
  /** 启动本地 loopback HTTP server；端口被占（EADDRINUSE）时抛错由调用方降级设备码。 */
  startLoopbackCallbackServer(
    onCallback: (url: string) => void,
  ): Promise<{ port: number; stop(): void }>;
  /** 发起设备码流程，返回用户需输入的一次性码与轮询参数。 */
  requestDeviceCode(context: OAuthProviderContext): Promise<OAuthDeviceCodeChallenge>;
  /** 轮询设备码状态：pending 继续等待、expired 过期、ready 拿到授权码与服务端 verifier。 */
  pollDeviceCodeToken(challenge: OAuthDeviceCodeChallenge): Promise<OAuthDeviceCodePollResult>;
  /** 设备码授权码换 token（redirect_uri 与 loopback 流程不同）。 */
  exchangeDeviceCodeToken(
    params: { authorizationCode: string; codeVerifier: string },
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet>;
}

/** OAuth provider 适配器：隔离协议差异 */
export interface OAuthProviderAdapter {
  readonly providerId: OAuthProviderId;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  parseCallbackParams(url: string): OAuthCallbackParams;
  buildAuthorizeUrl(context: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, context: OAuthProviderContext): Promise<OAuthTokenSet>;
  /** 将后端 polling 返回的 provider token 归一化为 Desktop 持久化语义。 */
  normalizePolledTokenSet?(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthTokenSet>;

  /** provider 级 legacy 凭据读取（用于升级兼容） */
  loadLegacyTokenSet?(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null>;

  normalizeError(error: unknown): Error;
}
