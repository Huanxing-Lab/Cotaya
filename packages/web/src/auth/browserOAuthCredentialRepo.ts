import {
  BIGMODEL_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthCachedSessionRestoreResult,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import { toUserInfo } from "./zaiWebOAuthProvider.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const ZAI_USER_INFO_KEY = "oauth:zai:user_info";
const BIGMODEL_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const BIGMODEL_USER_INFO_KEY = "oauth:bigmodel:user_info";
// openai 是独立身份域（spec openai-oauth-provider §2.3）：key 与 Desktop 凭据文件同名，
// 读写/清理均不触碰 z.ai 域 key 与共享 zcodejwttoken。
const OPENAI_ACCESS_TOKEN_KEY = "oauth:openai:access_token";
const OPENAI_REFRESH_TOKEN_KEY = "oauth:openai:refresh_token";
const OPENAI_USER_INFO_KEY = "oauth:openai:user_info";
const OPENAI_EXPIRES_AT_KEY = "oauth:openai:expires_at";
const OAUTH_PENDING_NONCE_KEY = "oauth_pending_nonce";
const OAUTH_PENDING_PROVIDER_KEY = "oauth_pending_provider";
const OAUTH_PENDING_OPENAI_DEVICE_KEY = "oauth_pending_openai_device";

/** 本仓支持的登录 provider。private 分享的 owner 身份是 provider 特定的，两边都要能登。 */
export type WebOAuthProviderId =
  | typeof ZAI_PROVIDER_ID
  | typeof BIGMODEL_PROVIDER_ID
  | typeof OPENAI_PROVIDER_ID;

function isWebOAuthProviderId(value: unknown): value is WebOAuthProviderId {
  return value === ZAI_PROVIDER_ID || value === BIGMODEL_PROVIDER_ID || value === OPENAI_PROVIDER_ID;
}

/** openai 设备码流程的 pending 记录：页面刷新后仍可继续轮询直到过期。 */
export interface WebOpenAIPendingDeviceLogin {
  deviceAuthId: string;
  userCode: string;
  inputPageUrl: string;
  pollIntervalMs: number;
  expiresAt: number;
}

/**
 * 每个 provider 用独立的 key 段。
 *
 * 刻意不复用一套「中性」key：zai 的两个 key 已经在线上承载着 /remote 的登录态，换 key 会
 * 让所有已登录用户在发版当天掉线。加一段 bigmodel 前缀是零风险的做法，代价只是多一个映射。
 */
interface WebOAuthProviderCredentialKeys {
  accessToken: string;
  userInfo: string;
  /** openai 域独有：refresh token 与过期时刻（z.ai 域生命周期由共享 zcode JWT 承载）。 */
  refreshToken?: string;
  expiresAt?: string;
}

function providerKeys(provider: WebOAuthProviderId): WebOAuthProviderCredentialKeys {
  if (provider === OPENAI_PROVIDER_ID) {
    return {
      accessToken: OPENAI_ACCESS_TOKEN_KEY,
      userInfo: OPENAI_USER_INFO_KEY,
      refreshToken: OPENAI_REFRESH_TOKEN_KEY,
      expiresAt: OPENAI_EXPIRES_AT_KEY,
    };
  }
  return provider === BIGMODEL_PROVIDER_ID
    ? { accessToken: BIGMODEL_ACCESS_TOKEN_KEY, userInfo: BIGMODEL_USER_INFO_KEY }
    : { accessToken: ZAI_ACCESS_TOKEN_KEY, userInfo: ZAI_USER_INFO_KEY };
}

interface BrowserOAuthCredentialRepoStorage {
  localStorage: Storage;
  sessionStorage: Storage;
}

interface BrowserOAuthCredentialRepoOptions {
  now?: () => number;
}

interface WebZaiTokenSet {
  zcodeJwtToken: string;
  zaiAccessToken: string;
  expiresAt?: number;
}

function getBrowserStorage(): BrowserOAuthCredentialRepoStorage {
  return {
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
  };
}

function hasText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 浏览器 OAuth 凭据仓储：统一收敛 localStorage/sessionStorage 读写，避免业务层散落认证状态判断。 */
export class BrowserOAuthCredentialRepo {
  private readonly localStorage: Storage;
  private readonly sessionStorage: Storage;
  private readonly now: () => number;

  constructor(
    storage: BrowserOAuthCredentialRepoStorage = getBrowserStorage(),
    options: BrowserOAuthCredentialRepoOptions = {},
  ) {
    this.localStorage = storage.localStorage;
    this.sessionStorage = storage.sessionStorage;
    this.now = options.now ?? Date.now;
  }

  saveTokenSet(tokenSet: WebZaiTokenSet | OAuthTokenSet, provider: WebOAuthProviderId): void {
    if (provider === OPENAI_PROVIDER_ID) {
      // openai 域只接收 OAuthTokenSet 形状（设备码换 token 产物）；WebZaiTokenSet 是
      // z.ai 后端包装，混入即调用方接错了流程，尽早暴露而不是写入半套凭据。
      if (!("accessToken" in tokenSet) || !tokenSet.accessToken) {
        throw new Error("OpenAI token set 缺少 accessToken");
      }
      // openai 域不写共享 zcodejwttoken：z.ai 域凭据在切换登录后仍要保留
      // （spec §2.3 身份域并存），这里也不能删除它。
      this.localStorage.setItem(OPENAI_ACCESS_TOKEN_KEY, tokenSet.accessToken);
      this.writeOptionalKey(OPENAI_REFRESH_TOKEN_KEY, tokenSet.refreshToken);
      this.writeOptionalKey(
        OPENAI_EXPIRES_AT_KEY,
        typeof tokenSet.expiresAt === "number" && Number.isFinite(tokenSet.expiresAt)
          ? String(tokenSet.expiresAt)
          : undefined,
      );
      return;
    }

    const accessToken =
      "zaiAccessToken" in tokenSet ? tokenSet.zaiAccessToken : tokenSet.accessToken;
    const zcodeJwtToken = tokenSet.zcodeJwtToken;

    this.localStorage.setItem(providerKeys(provider).accessToken, accessToken);
    if (zcodeJwtToken) {
      this.localStorage.setItem(ZCODE_JWT_TOKEN_KEY, zcodeJwtToken);
    } else {
      this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    }
  }

  private writeOptionalKey(key: string, value: string | undefined): void {
    if (value) {
      this.localStorage.setItem(key, value);
    } else {
      this.localStorage.removeItem(key);
    }
  }

  saveUserInfo(user: unknown, provider: WebOAuthProviderId): void {
    const rawUserInfo = JSON.stringify(user);
    this.localStorage.setItem(providerKeys(provider).userInfo, rawUserInfo);
  }

  setActiveProvider(provider: WebOAuthProviderId | null): void {
    if (!provider) {
      this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
      return;
    }

    this.localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
  }

  getActiveProvider(): OAuthProviderId | null {
    return this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
  }

  loadCachedSession(): UserInfo | null {
    const result = this.loadCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  loadCachedSessionState(): OAuthCachedSessionRestoreResult {
    const activeProvider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    // openai 是独立身份域：恢复按 oauth:openai:expires_at 判定，不检查共享 zcode JWT
    // （残留 z.ai 域旧 JWT 不参与 openai 会话判定，spec §2.5）。
    if (activeProvider === OPENAI_PROVIDER_ID) {
      return this.loadOpenAISyncSessionState();
    }

    const zcodeJwtToken = this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY);
    // 一次只有一个 activeProvider（切换 provider = 重新登录并覆盖），所以按它选 key 段读。
    const keys = isWebOAuthProviderId(activeProvider) ? providerKeys(activeProvider) : null;
    const accessToken = keys ? this.localStorage.getItem(keys.accessToken) : null;
    const rawUserInfo = keys ? this.localStorage.getItem(keys.userInfo) : null;

    if (!keys || !hasText(zcodeJwtToken) || !hasText(accessToken) || !hasText(rawUserInfo)) {
      if (this.hasAnyStoredCredential()) {
        // active 指针丢失时残留凭据无法归属，恢复干净起点（维持既有清理行为）；
        // active 明确是 z.ai 域时只清本域，openai 域凭据不受牵连（spec §2.3 身份域并存）。
        if (keys) {
          this.clearZaiDomainCredentials();
        } else {
          this.clearAll();
        }
      }
      return { status: "signed-out" };
    }

    if (resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      // Web localStorage 之前只检查 JWT 是否存在，过期后仍会恢复伪登录态。
      // 只清 z.ai 域与指针：openai 域凭据属于另一身份域，不得连带删除。
      this.clearZaiDomainCredentials();
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    try {
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      if (userInfo) {
        return { status: "authenticated", userInfo };
      }
    } catch {
      // localStorage 可能留下旧版或手工写入的损坏 JSON。
      // 这里按未登录处理并清理残缺态，避免 Web 远控入口误判成已登录后继续连接。
    }

    this.clearZaiDomainCredentials();
    return { status: "signed-out" };
  }

  /**
   * openai 域的同步恢复视图（getZCodeJwtToken 等同步读取用）。
   * token 过期时不清凭据：异步的 WebAuthService.restoreCachedSessionState 还要尝试
   * 一次 refresh 轮换，这里清掉会把可自愈的登录态误杀。
   */
  private loadOpenAISyncSessionState(): OAuthCachedSessionRestoreResult {
    const accessToken = this.localStorage.getItem(OPENAI_ACCESS_TOKEN_KEY);
    const rawUserInfo = this.localStorage.getItem(OPENAI_USER_INFO_KEY);
    const expiresAt = this.parseOpenAIExpiresAt();

    if (!hasText(accessToken) || !hasText(rawUserInfo) || expiresAt === undefined) {
      return { status: "signed-out" };
    }
    if (expiresAt <= this.now()) {
      return { status: "signed-out" };
    }

    try {
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      if (userInfo) {
        return { status: "authenticated", userInfo };
      }
    } catch {
      // 损坏 JSON 按未登录处理，与 z.ai 域一致；同样只清 openai 域。
    }
    this.clearOpenAIDomain();
    return { status: "signed-out" };
  }

  /** 读取 openai 域 token 组（供异步恢复/刷新链路使用；毫秒时间戳字符串落盘）。 */
  loadOpenAITokenSet(): OAuthTokenSet | null {
    const accessToken = this.localStorage.getItem(OPENAI_ACCESS_TOKEN_KEY);
    if (!hasText(accessToken)) {
      return null;
    }
    const refreshToken = this.localStorage.getItem(OPENAI_REFRESH_TOKEN_KEY);
    const expiresAt = this.parseOpenAIExpiresAt();
    return {
      accessToken,
      ...(hasText(refreshToken) ? { refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  private parseOpenAIExpiresAt(): number | undefined {
    const raw = this.localStorage.getItem(OPENAI_EXPIRES_AT_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  loadZCodeJwtToken(): string | null {
    // openai 是独立身份域且不持有 zcode JWT：active 为 openai 时不得借用 z.ai 域
    // 残留 JWT 发请求，否则会出现「展示 OpenAI 身份却用 z.ai 凭据调用」的跨域混用。
    if (this.localStorage.getItem(ACTIVE_PROVIDER_KEY) === OPENAI_PROVIDER_ID) {
      return null;
    }
    const session = this.loadCachedSessionState();
    if (session.status !== "authenticated") return null;
    return this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY)?.trim() || null;
  }

  private hasAnyStoredCredential(): boolean {
    return Boolean(
      this.localStorage.getItem(ACTIVE_PROVIDER_KEY) ||
      this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_USER_INFO_KEY) ||
      this.localStorage.getItem(BIGMODEL_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(BIGMODEL_USER_INFO_KEY) ||
      this.localStorage.getItem(OPENAI_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(OPENAI_USER_INFO_KEY),
    );
  }

  /** 仅清 z.ai 域凭据（zai ↔ bigmodel 同域互删 + 共享 zcode JWT）与 active 指针。 */
  private clearZaiDomainCredentials(): void {
    this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    this.localStorage.removeItem(ZAI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(ZAI_USER_INFO_KEY);
    this.localStorage.removeItem(BIGMODEL_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(BIGMODEL_USER_INFO_KEY);
  }

  /** 仅清 openai 域凭据与 active 指针；z.ai 域凭据与共享 zcode JWT 不动（spec §2.3）。 */
  clearOpenAIDomain(): void {
    this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    this.localStorage.removeItem(OPENAI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(OPENAI_REFRESH_TOKEN_KEY);
    this.localStorage.removeItem(OPENAI_USER_INFO_KEY);
    this.localStorage.removeItem(OPENAI_EXPIRES_AT_KEY);
  }

  /** 按身份域登出：openai 只清 openai 段，z.ai 域（zai/bigmodel）维持既有互删语义。 */
  clearProviderDomain(provider: WebOAuthProviderId): void {
    if (provider === OPENAI_PROVIDER_ID) {
      this.clearOpenAIDomain();
      return;
    }
    this.clearZaiDomainCredentials();
  }

  clearAll(): void {
    this.clearZaiDomainCredentials();
    this.clearOpenAIDomain();
  }

  savePendingNonce(nonce: string): void {
    this.sessionStorage.setItem(OAUTH_PENDING_NONCE_KEY, nonce);
  }

  loadPendingNonce(): string | null {
    return this.sessionStorage.getItem(OAUTH_PENDING_NONCE_KEY);
  }

  clearPendingNonce(): void {
    this.sessionStorage.removeItem(OAUTH_PENDING_NONCE_KEY);
  }

  savePendingOpenAIDeviceLogin(pending: WebOpenAIPendingDeviceLogin): void {
    this.sessionStorage.setItem(OAUTH_PENDING_OPENAI_DEVICE_KEY, JSON.stringify(pending));
  }

  loadPendingOpenAIDeviceLogin(): WebOpenAIPendingDeviceLogin | null {
    const raw = this.sessionStorage.getItem(OAUTH_PENDING_OPENAI_DEVICE_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<WebOpenAIPendingDeviceLogin>;
      const required = [parsed.deviceAuthId, parsed.userCode, parsed.inputPageUrl];
      if (
        required.every((value) => typeof value === "string" && value.trim().length > 0) &&
        typeof parsed.pollIntervalMs === "number" &&
        Number.isFinite(parsed.pollIntervalMs) &&
        typeof parsed.expiresAt === "number" &&
        Number.isFinite(parsed.expiresAt)
      ) {
        return {
          deviceAuthId: parsed.deviceAuthId!,
          userCode: parsed.userCode!,
          inputPageUrl: parsed.inputPageUrl!,
          pollIntervalMs: parsed.pollIntervalMs,
          expiresAt: parsed.expiresAt,
        };
      }
    } catch {
      // 损坏 JSON 按无 pending 处理并清理，避免设备码轮询卡死在坏数据上。
    }
    this.clearPendingOpenAIDeviceLogin();
    return null;
  }

  clearPendingOpenAIDeviceLogin(): void {
    this.sessionStorage.removeItem(OAUTH_PENDING_OPENAI_DEVICE_KEY);
  }

  /**
   * 记住这次跳出去登录用的是哪个 provider。
   *
   * 回调页必须知道用哪个 provider 换 token（authorize 参数名、token 响应里 access_token
   * 的位置都不同）。跟 nonce 放同一个 sessionStorage：两者本来就要一起校验、一起清。
   */
  savePendingProvider(provider: WebOAuthProviderId): void {
    this.sessionStorage.setItem(OAUTH_PENDING_PROVIDER_KEY, provider);
  }

  loadPendingProvider(): WebOAuthProviderId | null {
    const stored = this.sessionStorage.getItem(OAUTH_PENDING_PROVIDER_KEY);
    return isWebOAuthProviderId(stored) ? stored : null;
  }

  clearPendingProvider(): void {
    this.sessionStorage.removeItem(OAUTH_PENDING_PROVIDER_KEY);
  }
}
