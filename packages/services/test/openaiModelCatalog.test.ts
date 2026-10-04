// 规格 openai-oauth-provider §2.8：账号模型目录动态同步单测。
// 覆盖：visibility/版本门控过滤、缓存落盘与 TTL、空清单不视为新鲜、
// 拉取失败回退同账号旧缓存（换账号不串用）、无 token 直返 null、
// availability 集成的三态（models/null/unavailable）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpenAIModelCatalogService } from "../src/model-provider/openaiModelCatalog.js";
import { validateOpenAIAccountProviderAvailability } from "../src/model-provider/codingPlanProviderAvailability.js";

interface CatalogHarnessOptions {
  readonly modelIds?: readonly string[];
  readonly accountId?: string;
  /** 默认登录态 "token-1"；显式传 null 表示未登录。 */
  readonly token?: string | null;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function createCatalogHarness(options: CatalogHarnessOptions = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "openai-catalog-"));
  const credentials = new Map<string, string>();
  const token = options.token === undefined ? "token-1" : options.token;
  if (token !== null) {
    credentials.set("oauth:openai:access_token", token);
    credentials.set(
      "oauth:openai:user_info",
      JSON.stringify({ id: options.accountId ?? "account-1" }),
    );
  }
  let fetchCount = 0;
  const service = createOpenAIModelCatalogService({
    credentialService: { load: async (key) => credentials.get(key) ?? null },
    configDir,
    ttlMs: options.ttlMs,
    ...(options.now ? { now: options.now } : {}),
    fetchImpl: async () => {
      fetchCount += 1;
      return Response.json({
        models: (options.modelIds ?? ["gpt-x", "gpt-y"]).map((slug, index) => ({
          slug,
          visibility: slug.includes("hidden") ? "hide" : "list",
          minimal_client_version: index === 0 ? "0.200.0" : "0.144.0",
        })),
      });
    },
  });
  return {
    service,
    configDir,
    get fetchCount() {
      return fetchCount;
    },
    credentials,
    async cleanup() {
      await rmSync(configDir, { recursive: true, force: true });
    },
  };
}

test("目录拉取过滤版本门控与隐藏模型，结果落盘后不再重复请求", async (t) => {
  const h = createCatalogHarness({ modelIds: ["gpt-new", "gpt-stable", "hidden-one"] });
  t.after(() => h.cleanup());
  const first = await h.service.resolveModelIds();
  // gpt-new 的 minimal_client_version(0.200.0) 高于默认指纹 0.159.0 被过滤；
  // hidden-one visibility=hide 被过滤。
  assert.deepEqual(first, ["gpt-stable"]);
  assert.equal(h.fetchCount, 1);
  const second = await h.service.resolveModelIds();
  assert.deepEqual(second, ["gpt-stable"]);
  assert.equal(h.fetchCount, 1, "新鲜缓存命中时不得重复拉取");
});

test("TTL 过期后重新拉取", async (t) => {
  let nowMs = 1_000_000;
  const h = createCatalogHarness({ now: () => nowMs, ttlMs: 60_000 });
  t.after(() => h.cleanup());
  await h.service.resolveModelIds();
  assert.equal(h.fetchCount, 1);
  nowMs += 61_000;
  await h.service.resolveModelIds();
  assert.equal(h.fetchCount, 2, "缓存过期后应重新拉取");
});

test("权威空清单不视为新鲜，下一轮重新拉取", async (t) => {
  const h = createCatalogHarness({ modelIds: ["hidden-only"] });
  t.after(() => h.cleanup());
  const first = await h.service.resolveModelIds();
  assert.deepEqual(first, [], "全部被过滤的目录是权威空清单而非 null");
  await h.service.resolveModelIds();
  assert.equal(h.fetchCount, 2, "空清单缓存不得阻止下一轮重新拉取");
});

test("未登录时直返 null 且不发请求", async (t) => {
  const h = createCatalogHarness({ token: null });
  t.after(() => h.cleanup());
  assert.equal(await h.service.resolveModelIds(), null);
  assert.equal(h.fetchCount, 0);
});

test("同账号失败回退旧缓存，换账号不得串用", async (t) => {
  let fail = false;
  let accountId = "account-1";
  const configDir = mkdtempSync(join(tmpdir(), "openai-catalog-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const credentials = new Map<string, string>([["oauth:openai:access_token", "token-1"]]);
  const writeCredentials = () =>
    credentials.set("oauth:openai:user_info", JSON.stringify({ id: accountId }));
  writeCredentials();
  let clock = 1_000_000;
  let fetchCount = 0;
  const service = createOpenAIModelCatalogService({
    credentialService: { load: async (key) => credentials.get(key) ?? null },
    configDir,
    ttlMs: 1, // 恒过期（配合注入时钟每轮推进），验证失败回退路径
    now: () => clock,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fail) throw new Error("network down");
      return Response.json({ models: [{ slug: "gpt-stable", visibility: "list" }] });
    },
  });
  assert.deepEqual(await service.resolveModelIds(), ["gpt-stable"]);
  clock += 1_000;
  fail = true;
  assert.deepEqual(
    await service.resolveModelIds(),
    ["gpt-stable"],
    "拉取失败但同账号旧缓存存在时回退旧缓存",
  );
  clock += 1_000;
  accountId = "account-2";
  writeCredentials();
  assert.equal(
    await service.resolveModelIds(),
    null,
    "换账号后的旧缓存不是当前账号事实，回静态兜底",
  );
  assert.ok(fetchCount >= 3);
});

test("availability 集成：models 三态投影", async (t) => {
  const provider = {
    providerId: "account:openai-plan",
    family: "openai" as const,
    planKind: "start-plan" as const,
  };
  const credentialStore = new Map<string, string>([["oauth:openai:access_token", "token-1"]]);
  const credentialService = { load: async (key: string) => credentialStore.get(key) ?? null };

  const withCatalog = await validateOpenAIAccountProviderAvailability([provider], {
    credentialService,
    openAIModelCatalog: { resolveModelIds: async () => ["gpt-x"] },
  });
  assert.deepEqual(withCatalog["account:openai-plan"], {
    kind: "available",
    models: ["gpt-x"],
  });

  const withoutModels = await validateOpenAIAccountProviderAvailability([provider], {
    credentialService,
    openAIModelCatalog: { resolveModelIds: async () => null },
  });
  assert.deepEqual(withoutModels["account:openai-plan"], { kind: "available" });

  const rejected = await validateOpenAIAccountProviderAvailability([provider], {
    credentialService,
    openAIModelCatalog: {
      resolveModelIds: async () => {
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(rejected["account:openai-plan"], { kind: "available" });

  credentialStore.delete("oauth:openai:access_token");
  const unauthenticated = await validateOpenAIAccountProviderAvailability([provider], {
    credentialService,
  });
  assert.deepEqual(unauthenticated["account:openai-plan"], {
    kind: "unavailable",
    reason: "coding_plan_not_authenticated",
  });
  t.assert.ok(true);
});
