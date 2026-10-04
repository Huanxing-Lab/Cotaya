// 规格 openai-oauth-provider §2.3/2.5：openai 与 z.ai 身份域并存、loopback/设备码
// 编排、启动恢复（token 过期 + refresh）、登出边界的 OAuthService 级测试。
// loopback server 用随机端口起真实 HTTP server（不占用协议固定端口 1455）；
// 设备码 fallback 用"端口被占"的 adapter 桩触发。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ApiClient,
  ApiRequestInit,
  OAuthCallbackParams,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { OPENAI_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import { OpenAIProviderAdapter } from "../src/oauth/providers/openaiProviderAdapter.js";
import { createOpenAIProviderRuntimeConfig } from "../src/oauth/providers/openaiProviderConfig.js";
import {
  startOpenAILoopbackCallbackServer,
  type OpenAILoopbackCallbackServer,
} from "../src/oauth/providers/openaiLoopbackCallbackServer.js";
import type {
  OAuthProviderAdapter,
  OAuthProviderContext,
} from "../src/oauth/providers/providerAdapter.js";

class MemoryCredentialService implements ICredentialService {
  readonly store = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeIdToken(payload: Record<string, unknown>): string {
  const base64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${base64Url('{"alg":"RS256"}')}.${base64Url(JSON.stringify(payload))}.sig`;
}

const OPENAI_ID_TOKEN = makeIdToken({
  sub: "openai-sub-1",
  email: "chatgpt-user@example.com",
  chatgpt_account_id: "chatgpt-acct-1",
});

/** openai token 端点假实现：exchange 与 refresh 共用，按 grant_type 分流。 */
function createOpenAITokenApiClient(options: {
  refreshStatus?: number;
  refreshPayload?: unknown;
}): ApiClient & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    async request(input: string | URL, init?: ApiRequestInit) {
      const url = new URL(input.toString());
      const body = typeof init?.body === "string" ? init.body : "";
      if (init?.method === "POST") {
        bodies.push(`${url.pathname} ${body}`);
      }
      if (url.pathname === "/oauth/token") {
        if (body.includes("grant_type=refresh_token")) {
          return options.refreshStatus === 401
            ? jsonResponse(options.refreshPayload ?? { error: "refresh_token_expired" }, 401)
            : jsonResponse(
                options.refreshPayload ?? {
                  access_token: "openai-at-2",
                  refresh_token: "openai-rt-2",
                  expires_in: 3600,
                },
              );
        }
        return jsonResponse({
          access_token: "openai-at-1",
          refresh_token: "openai-rt-1",
          id_token: OPENAI_ID_TOKEN,
          expires_in: 3600,
        });
      }
      return jsonResponse({ error: `no route ${url.pathname}` }, 404);
    },
  };
}

/** z.ai 域桩 adapter：只验证身份域互斥语义，不走真实协议。 */
class StubZaiProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = ZAI_PROVIDER_ID;
  readonly meta: OAuthProviderMeta = {
    id: ZAI_PROVIDER_ID,
    displayName: "Z.ai",
    enabled: true,
    order: 1,
  };
  readonly redirectUri = "zcode://oauth/callback";
  readonly apiClient: ApiClient;
  constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }
  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    return { code: parsed.searchParams.get("code")!, state: parsed.searchParams.get("state")! };
  }
  buildAuthorizeUrl(context: OAuthProviderContext): string {
    return `https://chat.z.ai/api/oauth/authorize?state=${context.state}`;
  }
  async exchangeToken(params: OAuthCallbackParams): Promise<OAuthTokenSet> {
    return { accessToken: `zai-biz-${params.code}`, zcodeJwtToken: `zai-jwt-${params.code}` };
  }
  async fetchUserInfo(): Promise<OAuthUserProfile> {
    return { id: "zai-user-1", username: "zai-user", displayName: "zai-user" };
  }
  normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** 测试用 openai adapter：loopback 端口可注入（随机端口/模拟被占）。 */
class TestOpenAIProviderAdapter extends OpenAIProviderAdapter {
  readonly lastServers: OpenAILoopbackCallbackServer[] = [];
  constructor(
    apiClient: ApiClient,
    private readonly loopbackMode: "ephemeral" | "busy",
  ) {
    super(createOpenAIProviderRuntimeConfig({}), apiClient);
  }
  async startLoopbackCallbackServer(
    onCallback: (url: string) => void,
  ): Promise<{ port: number; stop(): void }> {
    if (this.loopbackMode === "busy") {
      throw Object.assign(new Error("listen EADDRINUSE: address already in use"), {
        code: "EADDRINUSE",
      });
    }
    const server = await startOpenAILoopbackCallbackServer({ port: 0, onCallback });
    this.lastServers.push(server);
    return server;
  }
}

function seedZaiDomain(credentialService: MemoryCredentialService): void {
  credentialService.store.set("oauth:zai:access_token", "zai-at-old");
  credentialService.store.set("oauth:zai:refresh_token", "zai-rt-old");
  credentialService.store.set(
    "oauth:zai:user_info",
    JSON.stringify({ id: "zai-user-1", username: "zai-user", displayName: "zai-user" }),
  );
  credentialService.store.set("zcodejwttoken", "zcode-jwt-old");
}

function createService(
  credentialService: MemoryCredentialService,
  apiClient: ApiClient,
  options: { loopbackMode?: "ephemeral" | "busy"; now?: () => number } = {},
): { service: OAuthService; openAIAdapter: TestOpenAIProviderAdapter } {
  const openAIAdapter = new TestOpenAIProviderAdapter(
    apiClient,
    options.loopbackMode ?? "ephemeral",
  );
  const service = new OAuthService(credentialService, {
    apiClient,
    env: {},
    now: options.now ?? Date.now,
    adapters: [new StubZaiProviderAdapter(apiClient), openAIAdapter],
  });
  return { service, openAIAdapter };
}

/** 通过随机端口 loopback server 完成 openai 登录（不占用协议固定端口 1455）。 */
async function loginOpenAI(
  service: OAuthService,
  openAIAdapter: TestOpenAIProviderAdapter,
): Promise<void> {
  const start = await service.startOAuthWithPolling(OPENAI_PROVIDER_ID);
  const server = openAIAdapter.lastServers.at(-1)!;
  const response = await fetch(
    `http://127.0.0.1:${server.port}/auth/callback?code=openai-code&state=${start.state}`,
  );
  assert.equal(response.status, 200);
  const result = await service.pollPendingOAuth();
  assert.equal(result?.kind, "session");
}

test("openai loopback 登录：凭据落盘且不触碰 z.ai 域与共享 JWT", async () => {
  const credentialService = new MemoryCredentialService();
  seedZaiDomain(credentialService);
  const apiClient = createOpenAITokenApiClient({});
  const { service, openAIAdapter } = createService(credentialService, apiClient);

  const start = await service.startOAuthWithPolling(OPENAI_PROVIDER_ID);
  assert.equal(start.provider, OPENAI_PROVIDER_ID);
  assert.equal(start.deviceCode, undefined);
  assert.match(start.authorizeUrl, /https:\/\/auth\.openai\.com\/oauth\/authorize\?/);

  // loopback server（随机端口）收到浏览器回调后，由 pollPendingOAuth 驱动完成。
  const server = openAIAdapter.lastServers.at(-1)!;
  const callbackResponse = await fetch(
    `http://127.0.0.1:${server.port}/auth/callback?code=openai-code-1&state=${start.state}`,
  );
  assert.equal(callbackResponse.status, 200);

  const result = await service.pollPendingOAuth();
  assert.equal(result?.kind, "session");
  if (result?.kind === "session") {
    assert.equal(result.provider, OPENAI_PROVIDER_ID);
    assert.equal(result.userInfo.id, "chatgpt-acct-1");
    assert.equal(result.userInfo.username, "chatgpt-user@example.com");
  }

  // oauth:openai:* + active provider 落盘；z.ai 域与 zcodejwttoken 原样保留。
  assert.equal(credentialService.store.get("oauth:active_provider"), OPENAI_PROVIDER_ID);
  assert.equal(credentialService.store.get("oauth:openai:access_token"), "openai-at-1");
  assert.equal(credentialService.store.get("oauth:openai:refresh_token"), "openai-rt-1");
  assert.ok(credentialService.store.get("oauth:openai:expires_at"));
  const userInfo = JSON.parse(credentialService.store.get("oauth:openai:user_info")!) as {
    id: string;
  };
  assert.equal(userInfo.id, "chatgpt-acct-1");
  assert.equal(credentialService.store.get("oauth:zai:access_token"), "zai-at-old");
  assert.equal(credentialService.store.get("oauth:zai:refresh_token"), "zai-rt-old");
  assert.equal(credentialService.store.get("zcodejwttoken"), "zcode-jwt-old");

  // 状态不匹配的回调必须被拒绝（state 校验仍由 handleCallback 承担）。
  await assert.rejects(
    service.handleCallback("http://localhost:1455/auth/callback?code=x&state=bad-state"),
    /state/,
  );
});

test("身份域来回切换互不清：zai 登录不清 openai，登出只清 active 域", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient = createOpenAITokenApiClient({});
  const { service, openAIAdapter } = createService(credentialService, apiClient);

  // 1) openai 登录。
  await loginOpenAI(service, openAIAdapter);

  // 2) 切换登录 zai（deep link 流程）：active 指针切换，openai 凭据保留。
  const zaiStart = await service.startOAuth(ZAI_PROVIDER_ID);
  const zaiResult = await service.handleCallback(
    `zcode://oauth/callback?code=znew&state=${zaiStart.state}`,
  );
  assert.equal(zaiResult?.kind, "session");
  assert.equal(credentialService.store.get("oauth:active_provider"), ZAI_PROVIDER_ID);
  assert.equal(credentialService.store.get("oauth:zai:access_token"), "zai-biz-znew");
  assert.equal(credentialService.store.get("zcodejwttoken"), "zai-jwt-znew");
  assert.equal(credentialService.store.get("oauth:openai:access_token"), "openai-at-1");
  assert.equal(credentialService.store.get("oauth:openai:refresh_token"), "openai-rt-1");
  assert.ok(credentialService.store.get("oauth:openai:user_info"));

  // 3) 登出 active（zai）：仅清 z.ai 域与共享 JWT，openai 凭据仍在（可切回）。
  await service.logout();
  assert.equal(credentialService.store.has("oauth:active_provider"), false);
  assert.equal(credentialService.store.get("oauth:zai:access_token"), undefined);
  assert.equal(credentialService.store.get("zcodejwttoken"), undefined);
  assert.equal(credentialService.store.get("oauth:openai:access_token"), "openai-at-1");
  assert.equal(credentialService.store.get("oauth:openai:refresh_token"), "openai-rt-1");
});

test("端口被占自动降级设备码：usercode 下发、404 等待、2xx 完成登录", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient: ApiClient & { pollCalls: number } = {
    pollCalls: 0,
    async request(input: string | URL, init?: ApiRequestInit) {
      const url = new URL(input.toString());
      if (url.pathname === "/api/accounts/deviceauth/usercode") {
        return jsonResponse({
          device_auth_id: "da-1",
          user_code: "WDJB-MJHT",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.pathname === "/api/accounts/deviceauth/token") {
        apiClient.pollCalls += 1;
        if (apiClient.pollCalls === 1) {
          return jsonResponse({}, 404);
        }
        return jsonResponse({ authorization_code: "dc-1", code_verifier: "server-verifier" });
      }
      if (url.pathname === "/oauth/token") {
        const body = typeof init?.body === "string" ? init.body : "";
        assert.ok(
          body.includes("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback"),
        );
        return jsonResponse({
          access_token: "openai-at-1",
          refresh_token: "openai-rt-1",
          id_token: OPENAI_ID_TOKEN,
          expires_in: 3600,
        });
      }
      return jsonResponse({ error: "no route" }, 404);
    },
  };
  let nowMs = 1_000_000;
  const { service } = createService(credentialService, apiClient, {
    loopbackMode: "busy",
    now: () => nowMs,
  });

  const start = await service.startOAuthWithPolling(OPENAI_PROVIDER_ID);
  assert.ok(start.deviceCode, "端口被占时必须降级设备码并在响应中携带 userCode");
  assert.equal(start.deviceCode.userCode, "WDJB-MJHT");
  assert.equal(start.authorizeUrl, "https://auth.openai.com/codex/device");

  // 第一次轮询 404：继续等待。
  assert.equal(await service.pollPendingOAuth(), null);
  // 推进时钟越过轮询间隔后再次轮询：2xx → 换 token → 会话完成。
  nowMs += 2_000;
  const result = await service.pollPendingOAuth();
  assert.equal(result?.kind, "session");
  assert.equal(credentialService.store.get("oauth:active_provider"), OPENAI_PROVIDER_ID);
  assert.equal(credentialService.store.get("oauth:openai:access_token"), "openai-at-1");
});

test("设备码 410 过期：清 pending 并抛出可重试错误", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient: ApiClient = {
    async request(input: string | URL) {
      const url = new URL(input.toString());
      if (url.pathname === "/api/accounts/deviceauth/usercode") {
        return jsonResponse({
          device_auth_id: "da-1",
          user_code: "WDJB-MJHT",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.pathname === "/api/accounts/deviceauth/token") {
        return jsonResponse({}, 410);
      }
      return jsonResponse({ error: "no route" }, 404);
    },
  };
  const { service } = createService(credentialService, apiClient, {
    loopbackMode: "busy",
    now: () => 1_000_000,
  });
  await service.startOAuthWithPolling(OPENAI_PROVIDER_ID);
  await assert.rejects(service.pollPendingOAuth(), /过期/);
  // 过期后 pending 已清空，后续轮询为空。
  assert.equal(await service.pollPendingOAuth(), null);
});

test("设备码 2xx 但 payload 无效：按终态失败上抛，不空转到 challenge 过期", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient: ApiClient = {
    async request(input: string | URL) {
      const url = new URL(input.toString());
      if (url.pathname === "/api/accounts/deviceauth/usercode") {
        return jsonResponse({
          device_auth_id: "da-1",
          user_code: "WDJB-MJHT",
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.pathname === "/api/accounts/deviceauth/token") {
        // 2xx 但缺 authorization_code/code_verifier：协议终态失败（adapter 抛带
        // 4xx status 的 ApiError），不能按瞬时错误空转轮询到 challenge 过期。
        return jsonResponse({});
      }
      return jsonResponse({ error: "no route" }, 404);
    },
  };
  let nowMs = 1_000_000;
  const { service } = createService(credentialService, apiClient, {
    loopbackMode: "busy",
    now: () => nowMs,
  });
  await service.startOAuthWithPolling(OPENAI_PROVIDER_ID);
  await assert.rejects(service.pollPendingOAuth(), /authorization_code|code_verifier/);
  // 终态失败已清 pending，后续轮询为空（而非反复重试同一无效响应）。
  assert.equal(await service.pollPendingOAuth(), null);
  nowMs += 2_000;
  assert.equal(await service.pollPendingOAuth(), null);
});

test("启动恢复：未过期直接恢复；过期走 refresh；失效仅清 openai 域", async () => {
  // (a) 未过期 → authenticated。
  {
    const credentialService = new MemoryCredentialService();
    const apiClient = createOpenAITokenApiClient({});
    const { service, openAIAdapter } = createService(credentialService, apiClient);
    await loginOpenAI(service, openAIAdapter);
    seedZaiDomain(credentialService);

    const restored = await createService(
      credentialService,
      apiClient,
    ).service.restoreCachedSessionState();
    assert.equal(restored.status, "authenticated");
  }

  // (b) 已过期 + refresh 成功 → authenticated 且轮换后的 refresh_token 落盘。
  {
    const credentialService = new MemoryCredentialService();
    const apiClient = createOpenAITokenApiClient({});
    const { service, openAIAdapter } = createService(credentialService, apiClient);
    await loginOpenAI(service, openAIAdapter);
    seedZaiDomain(credentialService);
    // 手工把 expires_at 调到过去，模拟 token 已过期。
    credentialService.store.set("oauth:openai:expires_at", String(Date.now() - 1));

    const restored = await createService(
      credentialService,
      apiClient,
    ).service.restoreCachedSessionState();
    assert.equal(restored.status, "authenticated");
    assert.equal(credentialService.store.get("oauth:openai:refresh_token"), "openai-rt-2");
    assert.equal(credentialService.store.get("oauth:openai:access_token"), "openai-at-2");
  }

  // (c) 已过期 + refresh 401(refresh_token_expired) → reauth，且只清 openai 域。
  {
    const credentialService = new MemoryCredentialService();
    const apiClient = createOpenAITokenApiClient({ refreshStatus: 401 });
    const { service, openAIAdapter } = createService(credentialService, apiClient);
    await loginOpenAI(service, openAIAdapter);
    seedZaiDomain(credentialService);
    credentialService.store.set("oauth:openai:expires_at", String(Date.now() - 1));

    const restored = await createService(
      credentialService,
      apiClient,
    ).service.restoreCachedSessionState();
    assert.equal(restored.status, "reauthentication-required");
    assert.equal(credentialService.store.get("oauth:openai:access_token"), undefined);
    assert.equal(credentialService.store.get("oauth:openai:refresh_token"), undefined);
    assert.equal(credentialService.store.get("oauth:openai:expires_at"), undefined);
    assert.equal(credentialService.store.get("oauth:openai:user_info"), undefined);
    // z.ai 域与共享 JWT 不动。
    assert.equal(credentialService.store.get("oauth:zai:access_token"), "zai-at-old");
    assert.equal(credentialService.store.get("zcodejwttoken"), "zcode-jwt-old");
  }

  // (d) 已过期且无 refresh_token → reauth 并清理。
  {
    const credentialService = new MemoryCredentialService();
    const apiClient = createOpenAITokenApiClient({});
    const { service, openAIAdapter } = createService(credentialService, apiClient);
    await loginOpenAI(service, openAIAdapter);
    credentialService.store.delete("oauth:openai:refresh_token");
    credentialService.store.set("oauth:openai:expires_at", String(Date.now() - 1));

    const restored = await createService(
      credentialService,
      apiClient,
    ).service.restoreCachedSessionState();
    assert.equal(restored.status, "reauthentication-required");
    assert.equal(credentialService.store.get("oauth:openai:access_token"), undefined);
  }
});

test("openai 登出：仅清 openai 域与 active 指针", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient = createOpenAITokenApiClient({});
  const { service, openAIAdapter } = createService(credentialService, apiClient);
  seedZaiDomain(credentialService);

  await loginOpenAI(service, openAIAdapter);

  await service.logout(OPENAI_PROVIDER_ID);
  assert.equal(credentialService.store.has("oauth:active_provider"), false);
  assert.equal(credentialService.store.get("oauth:openai:access_token"), undefined);
  assert.equal(credentialService.store.get("oauth:openai:expires_at"), undefined);
  assert.equal(credentialService.store.get("oauth:zai:access_token"), "zai-at-old");
  assert.equal(credentialService.store.get("zcodejwttoken"), "zcode-jwt-old");
});

test("loopback 超时经 poll 侧抛出过期错误，不再静默清 pending 卡住 UI", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient = createOpenAITokenApiClient({});
  let nowMs = 1_000_000;
  const { service, openAIAdapter } = createService(credentialService, apiClient, {
    now: () => nowMs,
  });
  const start = await service.startOAuthWithPolling(OPENAI_PROVIDER_ID);
  assert.equal(start.deviceCode, undefined);

  // 未超时且无回调：返回 null 继续等待（既有语义）。
  assert.equal(await service.pollPendingOAuth(), null);

  // 越过 5 分钟 deadline：与 zai/bigmodel polling 一致抛出过期错误，pending 清空。
  nowMs += 5 * 60_000 + 1;
  await assert.rejects(service.pollPendingOAuth(), /过期/);
  assert.equal(await service.pollPendingOAuth(), null);
  // 测试内主动释放随机端口 server（真实超时定时器为 5 分钟，不等它触发）。
  openAIAdapter.lastServers.at(-1)!.stop();
});

test("restoreSession 对 openai 返回缓存 profile，不用占位 profile 覆盖 user_info", async () => {
  const credentialService = new MemoryCredentialService();
  const apiClient = createOpenAITokenApiClient({});
  const { service, openAIAdapter } = createService(credentialService, apiClient);
  await loginOpenAI(service, openAIAdapter);

  // openai 无远端 userinfo 端点：restoreSession 必须直接返回落盘的 user_info，
  // 否则 fetchUserInfo 的 state 空缓存 miss 会用 {id:"unknown"} 占位覆盖
  // chatgpt_account_id（chatgpt-account-id 请求头的来源）。
  const restored = await createService(credentialService, apiClient).service.restoreSession();
  assert.equal(restored?.id, "chatgpt-acct-1");
  assert.equal(restored?.username, "chatgpt-user@example.com");
  const userInfo = JSON.parse(credentialService.store.get("oauth:openai:user_info")!) as {
    id: string;
  };
  assert.equal(userInfo.id, "chatgpt-acct-1");
});
