import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV } from "@zcode/provider-node";
import {
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USERCODE_URL,
  OPENAI_OAUTH_TOKEN_URL,
} from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { loginOpenAICli, logoutZCodeCli } from "../src/auth-login.js";
import { createStandaloneProviderRuntimeHeadersPort } from "../src/app/standalone-account-provider-runtime.js";

// zcode-builtin.json 提供 account:openai-plan 规则；登录后的默认模型选择依赖它。
const BUILTIN_CONFIG_PATH = resolve(
  import.meta.dirname,
  "../../../../../config/provider/zcode-builtin.json",
);

/** 构造签名不校验的 id_token：payload 为 base64url JSON（与客户端解析逻辑同信任模型）。 */
function buildIdToken(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${segment}.signature`;
}

const ID_TOKEN = buildIdToken({
  sub: "user-sub-1",
  email: "dev@example.com",
  chatgpt_account_id: "acct-123",
});

interface FakeHttpRouting {
  deviceAuthPollStatuses?: number[];
  refreshTokenPayload?: Record<string, unknown>;
  refreshTokenStatus?: number;
}

function createFakeHttpClient(routing: FakeHttpRouting = {}) {
  const requests: { body: string; url: string }[] = [];
  let pollIndex = 0;
  const client: HttpClientPort = {
    async request(request: HttpClientRequest): Promise<HttpClientResponse> {
      const body = new TextDecoder().decode(request.body ?? new Uint8Array());
      requests.push({ body, url: request.url });
      const respond = (status: number, payload: unknown): HttpClientResponse => {
        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        return {
          body: bytes,
          bytes: bytes.byteLength,
          durationMs: 0,
          headers: { "content-type": "application/json" },
          status,
          statusText: "",
          url: request.url,
        };
      };
      if (request.url === OPENAI_DEVICE_AUTH_USERCODE_URL) {
        return respond(200, {
          device_auth_id: "device-auth-1",
          interval: 1,
          expires_in: 900,
          user_code: "ABCD-EFGH",
        });
      }
      if (request.url === OPENAI_DEVICE_AUTH_TOKEN_URL) {
        const statuses = routing.deviceAuthPollStatuses ?? [404, 200];
        const status = statuses[Math.min(pollIndex, statuses.length - 1)] ?? 200;
        pollIndex += 1;
        if (status !== 200) {
          return respond(status, {});
        }
        return respond(200, {
          authorization_code: "auth-code-1",
          code_verifier: "server-verifier",
        });
      }
      if (request.url === OPENAI_OAUTH_TOKEN_URL) {
        const grantType = new URLSearchParams(body).get("grant_type");
        if (grantType === "authorization_code") {
          return respond(200, {
            access_token: "access-1",
            id_token: ID_TOKEN,
            refresh_token: "refresh-1",
            expires_in: 3600,
          });
        }
        return respond(routing.refreshTokenStatus ?? 200, {
          access_token: "access-2",
          expires_in: 3600,
          ...(routing.refreshTokenPayload ?? {}),
        });
      }
      throw new Error(`Unexpected URL in test: ${request.url}`);
    },
  };
  return { client, requests };
}

function createFakeCredentialStore(initial: Record<string, string> = {}): {
  deletedKeys: string[];
  saved: Record<string, string>;
  store: Record<string, string>;
  credentialStore: SharedZCodeCredentialStore;
} {
  const storeRecord: Record<string, string> = { ...initial };
  const saved: Record<string, string> = {};
  const deletedKeys: string[] = [];
  const credentialStore: SharedZCodeCredentialStore = {
    filePath: "/tmp/fake-credentials.json",
    async clearZaiLoginCredentials() {
      throw new Error("openai 登录不得触碰 z.ai 域清理路径");
    },
    async delete(key) {
      deletedKeys.push(key);
      delete storeRecord[key];
    },
    async deleteIfValue(key, expectedValue) {
      if (storeRecord[key] === expectedValue) {
        delete storeRecord[key];
        return true;
      }
      return false;
    },
    async deleteIfValues(expectedValues) {
      const result: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(expectedValues)) {
        result[key] = storeRecord[key] === value;
        if (result[key]) delete storeRecord[key];
      }
      return result;
    },
    async deleteManyIfValue(guardKey, expectedGuardValue, keysToDelete) {
      if (storeRecord[guardKey] !== expectedGuardValue) return false;
      for (const key of keysToDelete) delete storeRecord[key];
      return true;
    },
    async load(key) {
      return storeRecord[key] ?? null;
    },
    async loadMany(keys) {
      return Object.fromEntries(keys.map((key) => [key, storeRecord[key] ?? null]));
    },
    async save(key, value) {
      storeRecord[key] = value;
      saved[key] = value;
    },
    async saveMany(entries) {
      Object.assign(storeRecord, entries);
      Object.assign(saved, entries);
    },
    async saveManyIfValue(guardKey, expectedGuardValue, entries) {
      if (storeRecord[guardKey] !== expectedGuardValue) return false;
      Object.assign(storeRecord, entries);
      Object.assign(saved, entries);
      return true;
    },
    async saveReplacing(key, value, replacedKeys) {
      storeRecord[key] = value;
      saved[key] = value;
      for (const replaced of replacedKeys) delete storeRecord[replaced];
    },
    async saveZaiLoginCredentials() {
      throw new Error("openai 登录不得写 z.ai 域凭据");
    },
  };
  return { credentialStore, deletedKeys, saved, store: storeRecord };
}

test("loginOpenAICli --no-browser 走设备码流程并写 Desktop 同名凭据 key", async () => {
  const fake = createFakeCredentialStore();
  const { client, requests } = createFakeHttpClient();
  const tmpDir = mkdtempSync(join(tmpdir(), "openai-login-test-"));
  const personalConfigPath = join(tmpDir, "personal.json");
  writeFileSync(personalConfigPath, "{}\n");
  const deviceCodeEvents: { userCode: string; inputPageUrl: string }[] = [];

  try {
    const result = await loginOpenAICli({
      credentialStore: fake.credentialStore,
      env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: BUILTIN_CONFIG_PATH },
      httpClient: client,
      noBrowser: true,
      onDeviceCode: (data) => {
        deviceCodeEvents.push(data);
      },
      personalConfigPath,
      sleep: async () => {},
    });

    assert.equal(result.method, "device-code");
    assert.equal(result.providerId, "openai");
    assert.equal(result.user.user_id, "acct-123");
    assert.equal(result.user.email, "dev@example.com");
    assert.match(result.model, /^account:openai-plan\//);
    assert.deepEqual(deviceCodeEvents, [
      { userCode: "ABCD-EFGH", inputPageUrl: "https://auth.openai.com/codex/device" },
    ]);

    // 凭据 key 与 Desktop 同名；active provider 指向 openai；z.ai 域 key 不被触碰。
    assert.equal(fake.saved["oauth:openai:access_token"], "access-1");
    assert.equal(fake.saved["oauth:openai:refresh_token"], "refresh-1");
    assert.equal(fake.saved["oauth:active_provider"], "openai");
    const userInfo = JSON.parse(fake.saved["oauth:openai:user_info"] ?? "{}");
    assert.equal(userInfo.id, "acct-123");
    assert.equal(userInfo.rawProfile.chatgpt_account_id, "acct-123");
    assert.ok(Number.parseInt(fake.saved["oauth:openai:expires_at"] ?? "0", 10) > 0);
    assert.equal(fake.saved["oauth:zai:access_token"], undefined);
    assert.equal(fake.saved["zcodejwttoken"], undefined);

    // 设备码换 token 的 redirect_uri 用 OpenAI 固定值，verifier 用服务端返回值。
    const tokenRequest = requests.find(
      (request) =>
        request.url === OPENAI_OAUTH_TOKEN_URL &&
        request.body.includes("grant_type=authorization_code"),
    );
    assert.ok(tokenRequest, "authorization_code token exchange missing");
    assert.match(
      tokenRequest.body,
      /redirect_uri=https%3A%2F%2Fauth\.openai\.com%2Fdeviceauth%2Fcallback/,
    );
    assert.match(tokenRequest.body, /code_verifier=server-verifier/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loginOpenAICli loopback 主流程：固定 1455 回调接收授权码后换 token", async () => {
  const fake = createFakeCredentialStore();
  const { client, requests } = createFakeHttpClient();
  const tmpDir = mkdtempSync(join(tmpdir(), "openai-login-loopback-"));
  const personalConfigPath = join(tmpDir, "personal.json");
  writeFileSync(personalConfigPath, "{}\n");
  let capturedAuthorizeUrl = "";

  try {
    // 浏览器由 fake 代开；真实回调由测试用 authorize URL 里解析出的 state 自行发起。
    const loginPromise = loginOpenAICli({
      credentialStore: fake.credentialStore,
      env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: BUILTIN_CONFIG_PATH },
      httpClient: client,
      openBrowser: async () => ({ command: "test", opened: true }),
      onAuthorizeUrl: (authorizeUrl) => {
        capturedAuthorizeUrl = authorizeUrl;
      },
      personalConfigPath,
    });
    // 轮询等待 loopback server 就绪（authorize URL 回调出现即已在监听）。
    for (let i = 0; i < 100 && !capturedAuthorizeUrl; i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(capturedAuthorizeUrl, "authorize URL 未回调");
    const state = new URL(capturedAuthorizeUrl).searchParams.get("state");
    assert.ok(state, "authorize URL 缺少 state");
    assert.match(
      capturedAuthorizeUrl,
      /redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback/,
    );
    assert.match(capturedAuthorizeUrl, /code_challenge_method=S256/);

    await new Promise<void>((resolveCallback, rejectCallback) => {
      get(
        `http://localhost:1455/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
        (response) => {
          response.resume();
          response.on("end", resolveCallback);
        },
      ).on("error", rejectCallback);
    });

    const result = await loginPromise;
    assert.equal(result.method, "loopback");
    assert.equal(result.providerId, "openai");
    assert.equal(result.user.user_id, "acct-123");
    assert.equal(fake.saved["oauth:openai:access_token"], "access-1");
    assert.equal(fake.saved["oauth:active_provider"], "openai");

    // loopback 主流程换 token 的 redirect_uri 与 PKCE verifier 均为本地生成。
    const tokenRequest = requests.find(
      (request) =>
        request.url === OPENAI_OAUTH_TOKEN_URL &&
        request.body.includes("grant_type=authorization_code"),
    );
    assert.ok(tokenRequest, "authorization_code token exchange missing");
    assert.match(
      tokenRequest.body,
      /redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback/,
    );
    const verifier = new URLSearchParams(tokenRequest.body).get("code_verifier") ?? "";
    // RFC 7636：verifier 43-128 字符。
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier 长度异常: ${verifier.length}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("standalone headers port：token 未到期直接下发 apiKey 与 chatgpt-account-id 头", async () => {
  const fake = createFakeCredentialStore({
    "oauth:openai:access_token": "access-1",
    "oauth:openai:expires_at": String(Date.now() + 10 * 60_000),
    "oauth:openai:refresh_token": "refresh-1",
    "oauth:openai:user_info": JSON.stringify({ id: "acct-123", username: "dev@example.com" }),
  });
  const { client } = createFakeHttpClient();
  const port = createStandaloneProviderRuntimeHeadersPort(
    fake.credentialStore,
    {},
    { httpClient: client, now: Date.now },
  );
  const result = await port.refreshBeforeModelRequest({
    accountAccess: { accountType: "openai", entitled: true, type: "chatgpt-account" },
    attempt: 1,
    modelId: "gpt-5.4",
    providerId: "account:openai-plan",
    reason: "model-request",
  });
  assert.deepEqual(result, {
    headersApplied: true,
    requestAuth: {
      apiKey: "access-1",
      headers: { "chatgpt-account-id": "acct-123" },
    },
  });
});

test("standalone headers port：临近过期触发轮换刷新并落盘新 refresh_token", async () => {
  const fake = createFakeCredentialStore({
    "oauth:openai:access_token": "access-1",
    "oauth:openai:expires_at": String(Date.now() + 30_000), // 60s 主动刷新窗口内
    "oauth:openai:refresh_token": "refresh-1",
    "oauth:openai:user_info": JSON.stringify({ id: "acct-123" }),
  });
  const { client } = createFakeHttpClient({
    refreshTokenPayload: { refresh_token: "refresh-2" },
  });
  const port = createStandaloneProviderRuntimeHeadersPort(
    fake.credentialStore,
    {},
    { httpClient: client, now: Date.now },
  );
  const result = await port.refreshBeforeModelRequest({
    accountAccess: { accountType: "openai", entitled: true, type: "chatgpt-account" },
    attempt: 1,
    providerId: "account:openai-plan",
    reason: "model-request",
  });
  assert.equal(result.requestAuth?.apiKey, "access-2");
  // 轮换语义：新 refresh_token 必须替换旧值并持久化。
  assert.equal(fake.saved["oauth:openai:refresh_token"], "refresh-2");
  assert.equal(fake.saved["oauth:openai:access_token"], "access-2");
});

test("standalone headers port：refresh 失效仅清 openai 域凭据与 active 指针", async () => {
  const fake = createFakeCredentialStore({
    "oauth:active_provider": "openai",
    "oauth:bigmodel:access_token": "bigmodel-token",
    "oauth:openai:access_token": "access-1",
    "oauth:openai:expires_at": String(Date.now() + 30_000),
    "oauth:openai:refresh_token": "refresh-1",
    "oauth:openai:user_info": JSON.stringify({ id: "acct-123" }),
    zcodejwttoken: "jwt-1",
  });
  const { client } = createFakeHttpClient({ refreshTokenStatus: 401 });
  const port = createStandaloneProviderRuntimeHeadersPort(
    fake.credentialStore,
    {},
    { httpClient: client, now: Date.now },
  );
  await assert.rejects(
    port.refreshBeforeModelRequest({
      accountAccess: { accountType: "openai", entitled: true, type: "chatgpt-account" },
      attempt: 1,
      providerId: "account:openai-plan",
      reason: "model-request",
    }),
    /重新登录|重新执行/,
  );
  assert.equal(fake.store["oauth:openai:access_token"], undefined);
  assert.equal(fake.store["oauth:openai:refresh_token"], undefined);
  assert.equal(fake.store["oauth:openai:user_info"], undefined);
  assert.equal(fake.store["oauth:active_provider"], undefined);
  // z.ai 域凭据与共享 JWT 不动。
  assert.equal(fake.store["oauth:bigmodel:access_token"], "bigmodel-token");
  assert.equal(fake.store["zcodejwttoken"], "jwt-1");
});

test("logoutZCodeCli 按 active_provider 分域清理：active=openai 仅清 openai 域与指针", async () => {
  const fake = createFakeCredentialStore({
    "oauth:active_provider": "openai",
    "oauth:bigmodel:access_token": "bigmodel-token",
    "oauth:openai:access_token": "access-1",
    "oauth:openai:expires_at": String(Date.now() + 60_000),
    "oauth:openai:refresh_token": "refresh-1",
    "oauth:openai:user_info": JSON.stringify({ id: "acct-123" }),
    "oauth:zai:access_token": "zai-token",
    zcodejwttoken: "jwt-1",
  });
  const result = await logoutZCodeCli({ credentialStore: fake.credentialStore, env: {} });
  assert.equal(result.provider, "openai");
  assert.equal(fake.store["oauth:openai:access_token"], undefined);
  assert.equal(fake.store["oauth:openai:refresh_token"], undefined);
  assert.equal(fake.store["oauth:openai:user_info"], undefined);
  assert.equal(fake.store["oauth:openai:expires_at"], undefined);
  assert.equal(fake.store["oauth:active_provider"], undefined);
  // 反向亦然（spec §2.3）：openai 域登出不得删 z.ai 域凭据与共享 JWT。
  assert.equal(fake.store["oauth:zai:access_token"], "zai-token");
  assert.equal(fake.store["oauth:bigmodel:access_token"], "bigmodel-token");
  assert.equal(fake.store["zcodejwttoken"], "jwt-1");
});

test("logoutZCodeCli active=zai 维持 z.ai 域清理，不跨域删 openai 凭据", async () => {
  const fake = createFakeCredentialStore({
    "oauth:active_provider": "zai",
    "oauth:openai:access_token": "access-1",
    "oauth:openai:refresh_token": "refresh-1",
    "oauth:zai:access_token": "zai-token",
    zcodejwttoken: "jwt-1",
  });
  const result = await logoutZCodeCli({
    credentialStore: fake.credentialStore,
    env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: BUILTIN_CONFIG_PATH },
  });
  assert.equal(result.provider, "zai");
  assert.equal(fake.store["oauth:zai:access_token"], undefined);
  assert.equal(fake.store["zcodejwttoken"], undefined);
  // openai 是独立身份域：z.ai 域登出不删 openai 凭据，可再直接切回。
  assert.equal(fake.store["oauth:openai:access_token"], "access-1");
  assert.equal(fake.store["oauth:openai:refresh_token"], "refresh-1");
});

test("standalone headers port：刷新在途期间登出（凭据被清）时跳过写回，不复活凭据", async () => {
  const fake = createFakeCredentialStore({
    "oauth:openai:access_token": "access-1",
    "oauth:openai:expires_at": String(Date.now() + 30_000), // 60s 主动刷新窗口内
    "oauth:openai:refresh_token": "refresh-1",
    "oauth:openai:user_info": JSON.stringify({ id: "acct-123" }),
  });
  const client: HttpClientPort = {
    async request(request: HttpClientRequest): Promise<HttpClientResponse> {
      // 刷新响应返回前模拟另一进程登出：openai 域 key 已被清空。
      delete fake.store["oauth:openai:access_token"];
      delete fake.store["oauth:openai:refresh_token"];
      delete fake.store["oauth:openai:expires_at"];
      const payload = { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      return {
        body: bytes,
        bytes: bytes.byteLength,
        durationMs: 0,
        headers: { "content-type": "application/json" },
        status: 200,
        statusText: "",
        url: request.url,
      };
    },
  };
  const port = createStandaloneProviderRuntimeHeadersPort(fake.credentialStore, {}, {
    httpClient: client,
    now: Date.now,
  });
  const result = await port.refreshBeforeModelRequest({
    accountAccess: { accountType: "openai", entitled: true, type: "chatgpt-account" },
    attempt: 1,
    providerId: "account:openai-plan",
    reason: "model-request",
  });
  // 刷新出的 access_token 仍服务本次请求；条件事务守护下已清除的凭据不被写回复活。
  assert.equal(result.requestAuth?.apiKey, "access-2");
  assert.equal(fake.store["oauth:openai:access_token"], undefined);
  assert.equal(fake.store["oauth:openai:refresh_token"], undefined);
  assert.equal(fake.store["oauth:openai:expires_at"], undefined);
});
