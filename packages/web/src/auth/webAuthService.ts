import {
  ApiError,
  OPENAI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCachedSessionRestoreResult,
  type OAuthDeviceCodeStartInfo,
  type UserInfo,
} from "@zcode/shared";
import {
  BrowserOAuthCredentialRepo,
  type WebOAuthProviderId,
} from "./browserOAuthCredentialRepo.js";
import {
  buildOAuthState,
  buildReturnToCallbackUrl,
  isTrustedDevReturnTo,
  parseOAuthState,
  parseOptionalUrl,
  resolveSafeAppReturnTo,
} from "./oauthStateCodec.js";
import { WEB_ZAI_OAUTH_CONFIG, type WebZaiOAuthConfig } from "./webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "./zaiWebOAuthProvider.js";
import {
  OpenAIWebOAuthProvider,
  isOpenAIWebRefreshInvalidError,
} from "./openaiWebOAuthProvider.js";

interface WebAuthServiceRuntime {
  assign(url: string): void;
  createNonce(): string;
  getCurrentHref(): string;
  getCurrentOrigin(): string;
  replace(url: string): void;
}

interface WebAuthServiceDependencies {
  config?: WebZaiOAuthConfig;
  provider?: ZaiWebOAuthProvider;
  openAIProvider?: OpenAIWebOAuthProvider;
  repo?: BrowserOAuthCredentialRepo;
  runtime?: WebAuthServiceRuntime;
}

interface WebAuthLoginOptions {
  devReturnTo?: string;
  appReturnTo?: string;
  redirectUri?: string;
  /** 缺省 zai，保持 /remote 等既有入口行为不变。 */
  provider?: WebOAuthProviderId;
}

export interface WebAuthCallbackResult {
  userInfo: UserInfo;
  appReturnTo: string | null;
}

/** 设备码轮询的会话级结果：authenticated 时凭据已落盘、active 指针已切换。 */
export type WebOpenAIDeviceLoginPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "authenticated"; userInfo: UserInfo };

function createBrowserNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDefaultRuntime(): WebAuthServiceRuntime {
  return {
    assign: (url) => {
      window.location.assign(url);
    },
    createNonce: createBrowserNonce,
    getCurrentHref: () => window.location.href,
    getCurrentOrigin: () => window.location.origin,
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

export class WebAuthService {
  private readonly config: WebZaiOAuthConfig;
  private readonly provider: ZaiWebOAuthProvider;
  private readonly openAIProvider: OpenAIWebOAuthProvider;
  private readonly repo: BrowserOAuthCredentialRepo;
  private readonly runtime: WebAuthServiceRuntime;

  constructor(dependencies: WebAuthServiceDependencies = {}) {
    this.config = dependencies.config ?? WEB_ZAI_OAUTH_CONFIG;
    this.provider = dependencies.provider ?? new ZaiWebOAuthProvider(this.config);
    this.openAIProvider = dependencies.openAIProvider ?? new OpenAIWebOAuthProvider();
    this.repo = dependencies.repo ?? new BrowserOAuthCredentialRepo();
    this.runtime = dependencies.runtime ?? createDefaultRuntime();
  }

  startLogin(options: WebAuthLoginOptions = {}): void {
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    if (provider === OPENAI_PROVIDER_ID) {
      // Web 端无法监听 localhost loopback，openai 只走设备码（spec §2.1）；
      // 重定向式 startLogin 不适用，调用方应使用 startOpenAIDeviceCodeLogin。
      throw new Error("OpenAI 登录在 Web 端仅支持设备码流程（startOpenAIDeviceCodeLogin）");
    }
    const nonce = this.runtime.createNonce();
    this.repo.savePendingNonce(nonce);
    this.repo.savePendingProvider(provider);

    const state = buildOAuthState({
      nonce,
      app_return_to: options.appReturnTo ?? this.runtime.getCurrentHref(),
      ...(options.devReturnTo ? { return_to: options.devReturnTo } : {}),
    });

    this.runtime.assign(
      this.provider.buildAuthorizeUrl({
        state,
        provider,
        redirectUri: options.redirectUri ?? this.config.redirectUri,
      }),
    );
  }

  async handleCallback(url: string): Promise<WebAuthCallbackResult | null> {
    const callback = this.provider.parseCallbackParams(url);
    const statePayload = parseOAuthState(callback.state);
    if (!statePayload) {
      throw new Error("OAuth state is invalid");
    }

    const returnToUrl = parseOptionalUrl(statePayload.return_to);
    if (returnToUrl && returnToUrl.origin !== this.runtime.getCurrentOrigin()) {
      if (this.config.allowDevReturnToRedirect && isTrustedDevReturnTo(returnToUrl)) {
        const redirectUrl = buildReturnToCallbackUrl(returnToUrl.toString(), {
          ...(callback.code ? { code: callback.code } : {}),
          ...(callback.error ? { error: callback.error } : {}),
          state: callback.state,
        });
        if (redirectUrl) {
          this.runtime.replace(redirectUrl);
          return null;
        }
      }
    }

    if (callback.error) {
      throw new Error(`OAuth login failed: ${callback.error}`);
    }

    if (!callback.code) {
      throw new Error("OAuth callback missing code");
    }

    const pendingNonce = this.repo.loadPendingNonce();
    if (statePayload.nonce !== pendingNonce) {
      throw new Error("OAuth CSRF 检测失败");
    }
    // provider 必须取跳转前记下的那个：authorize 参数名和 token 响应里 access_token 的位置
    // 都是 provider 特定的。缺失时按 zai 兜底，保持旧回调链接可用。
    const provider = this.repo.loadPendingProvider() ?? ZAI_PROVIDER_ID;
    this.repo.clearPendingNonce();
    this.repo.clearPendingProvider();

    const callbackRedirectUri = ["/cn/share/callback", "/share/callback"].includes(
      new URL(url).pathname,
    )
      ? this.config.shareRedirectUri
      : this.config.redirectUri;
    const exchange = await this.provider.exchangeToken({
      code: callback.code,
      state: callback.state,
      provider,
      redirectUri: callbackRedirectUri,
    });

    this.repo.saveTokenSet(exchange.tokenSet, provider);
    this.repo.saveUserInfo(exchange.rawUserInfo, provider);
    this.repo.setActiveProvider(provider);

    return {
      userInfo: exchange.userInfo,
      appReturnTo: resolveSafeAppReturnTo(statePayload.app_return_to, {
        currentOrigin: this.runtime.getCurrentOrigin(),
      }),
    };
  }

  // ---- OpenAI 设备码登录（Web 端唯一流程，spec §2.1/§2.2） ----

  /**
   * 发起设备码登录：申请 user_code 并把 pending 记录写入 sessionStorage，
   * 页面刷新后可凭记录继续轮询直到过期。返回给 UI 展示的输码信息不含 deviceAuthId。
   */
  async startOpenAIDeviceCodeLogin(): Promise<OAuthDeviceCodeStartInfo> {
    const challenge = await this.openAIProvider.requestDeviceCode();
    this.repo.savePendingOpenAIDeviceLogin(challenge);
    return {
      userCode: challenge.userCode,
      inputPageUrl: challenge.inputPageUrl,
      pollIntervalMs: challenge.pollIntervalMs,
      expiresAt: challenge.expiresAt,
    };
  }

  /**
   * 单次轮询设备码状态。UI 按 pollIntervalMs 驱动调用：
   * pending=继续等待；expired=流程过期（pending 已清理）；authenticated=兑换并落盘完成。
   * 5xx/网络抖动按 pending 处理（保留凭据与 pending，下个 tick 重试），
   * 其余 4xx 协议错误向上抛出由 UI 呈现。
   */
  async pollPendingOpenAIDeviceCodeLogin(): Promise<WebOpenAIDeviceLoginPollResult> {
    const challenge = this.repo.loadPendingOpenAIDeviceLogin();
    if (!challenge) {
      return { status: "expired" };
    }
    if (challenge.expiresAt <= Date.now()) {
      this.repo.clearPendingOpenAIDeviceLogin();
      return { status: "expired" };
    }

    let result;
    try {
      result = await this.openAIProvider.pollDeviceCodeToken(challenge);
    } catch (error) {
      if (isTransientOpenAIPollError(error)) {
        return { status: "pending" };
      }
      throw error;
    }

    if (result.status === "expired") {
      this.repo.clearPendingOpenAIDeviceLogin();
      return { status: "expired" };
    }
    if (result.status === "pending") {
      return { status: "pending" };
    }

    const exchange = await this.openAIProvider.exchangeDeviceCodeToken({
      authorizationCode: result.authorizationCode,
      codeVerifier: result.codeVerifier,
    });
    this.repo.saveTokenSet(exchange.tokenSet, OPENAI_PROVIDER_ID);
    this.repo.saveUserInfo(
      { ...exchange.userInfo, rawProfile: exchange.rawProfile },
      OPENAI_PROVIDER_ID,
    );
    this.repo.setActiveProvider(OPENAI_PROVIDER_ID);
    this.repo.clearPendingOpenAIDeviceLogin();
    return { status: "authenticated", userInfo: exchange.userInfo };
  }

  /** 读取未过期的 pending 设备码（面板刷新恢复用）；无记录或已过期返回 null。 */
  loadPendingOpenAIDeviceCodeLogin(): OAuthDeviceCodeStartInfo | null {
    const pending = this.repo.loadPendingOpenAIDeviceLogin();
    if (!pending || pending.expiresAt <= Date.now()) {
      return null;
    }
    return {
      userCode: pending.userCode,
      inputPageUrl: pending.inputPageUrl,
      pollIntervalMs: pending.pollIntervalMs,
      expiresAt: pending.expiresAt,
    };
  }

  /** 放弃进行中的设备码登录（关闭面板/显式取消时调用）。 */
  cancelOpenAIDeviceCodeLogin(): void {
    this.repo.clearPendingOpenAIDeviceLogin();
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    if (this.repo.getActiveProvider() === OPENAI_PROVIDER_ID) {
      return this.restoreOpenAICachedSessionState();
    }
    return this.repo.loadCachedSessionState();
  }

  /**
   * openai 启动恢复（与 host OAuthService 等价，spec §2.5）：未过期直接恢复；
   * 已过期且有 refresh_token 时刷新一次；刷新明确失效只清 openai 域凭据，
   * z.ai 域凭据与共享 zcodejwttoken 不动。
   */
  private async restoreOpenAICachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    const tokenSet = this.repo.loadOpenAITokenSet();
    if (!tokenSet) {
      return { status: "signed-out" };
    }

    const syncState = this.repo.loadCachedSessionState();
    if (syncState.status === "authenticated") {
      return syncState;
    }
    if (!tokenSet.refreshToken) {
      // access token 已过期且没有 refresh_token：凭据无法自愈，按失效清理后引导重登。
      this.repo.clearOpenAIDomain();
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    try {
      const refreshed = await this.openAIProvider.refreshToken(tokenSet);
      this.repo.saveTokenSet(refreshed, OPENAI_PROVIDER_ID);
      const restored = this.repo.loadCachedSessionState();
      return restored.status === "authenticated"
        ? restored
        : { status: "reauthentication-required", reason: "jwt-expired" };
    } catch (error) {
      if (isOpenAIWebRefreshInvalidError(error)) {
        this.repo.clearOpenAIDomain();
      } else {
        // 网络/服务端瞬时失败：保留本地凭据（下次仍可重试），本次按需重登引导。
        console.warn("[web-openai-oauth]", "cached session refresh failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }
  }

  getZCodeJwtToken(): string | null {
    return this.repo.loadZCodeJwtToken();
  }

  async logout(): Promise<void> {
    // 按身份域登出：openai 只清 openai 段与指针；z.ai 域维持既有互删语义
    // （spec §2.3：登出不触碰另一身份域凭据）。
    const activeProvider = this.repo.getActiveProvider();
    if (activeProvider === OPENAI_PROVIDER_ID) {
      this.repo.clearOpenAIDomain();
      return;
    }
    this.repo.clearAll();
  }
}

/** 5xx/超时/网络抖动视为瞬时错误：设备码轮询继续等待而不是立刻失败。 */
function isTransientOpenAIPollError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (error.status ?? 0) >= 500;
  }
  // fetch 网络失败（TypeError）与 AbortSignal.timeout（DOMException）可重试；
  // 其余 Error（如 2xx 响应 payload 无效）是协议层失败，必须立刻上抛而不是空转到过期。
  return error instanceof TypeError || error instanceof DOMException;
}

export function createWebAuthService(): WebAuthService {
  return new WebAuthService();
}
