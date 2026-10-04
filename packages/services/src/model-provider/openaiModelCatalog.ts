// 规格 openai-oauth-provider §2.8：非 z.ai/bigmodel 账号 provider 的模型目录
// 动态同步。OpenAI 首个实现：账号解析周期内拉 GET /models，取 visibility=list
// 且版本门控通过的 slug，经 availability.models → 账号层 builtinModelIds 覆盖
// zcode-builtin.json 静态清单；拉取失败且无缓存时返回 null（不投影），静态清单
// 兜底。与 cc-switch 的 codex_oauth_models 等价：动态目录只决定「有哪些模型」，
// 模型能力（ctx/reasoning 档位）仍来自静态校准规则。
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import {
  compareOpenAIClientVersion,
  OPENAI_PROVIDER_ID,
  resolveOpenAICodexBaseUrl,
  resolveOpenAICodexClientVersion,
  resolveOpenAICodexOriginator,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface OpenAIModelCatalogCredentialService {
  load(key: string): Promise<string | null>;
}

export interface OpenAIModelCatalogService {
  /** 当前账号的可列模型 id；null 表示本轮无法判定（调用方不得投影，静态清单兜底）。 */
  resolveModelIds(): Promise<readonly string[] | null>;
}

export interface OpenAIModelCatalogOptions {
  readonly credentialService: OpenAIModelCatalogCredentialService;
  /** 凭据文件所在配置目录（~/.cotaya/v2）；缓存写到 model-catalog/openai.json。 */
  readonly configDir: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: { warn(message: string): void };
  readonly ttlMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly now?: () => number;
}

interface OpenAIModelCatalogCache {
  readonly schemaVersion: number;
  readonly accountId: string;
  readonly fetchedAtMs: number;
  readonly modelIds: readonly string[];
}

interface OpenAIModelsResponseEntry {
  readonly slug?: unknown;
  readonly visibility?: unknown;
  readonly minimal_client_version?: unknown;
}

export function createOpenAIModelCatalogService(
  options: OpenAIModelCatalogOptions,
): OpenAIModelCatalogService {
  const logger = options.logger ?? createServiceLogger("openai-model-catalog");
  const cacheFilePath = join(options.configDir, "model-catalog", "openai.json");
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let inflightRefresh: Promise<readonly string[] | null> | null = null;

  async function loadTokenMaterial(): Promise<{
    readonly accessToken: string;
    readonly accountId: string;
  } | null> {
    const accessToken = (
      await options.credentialService.load(`oauth:${OPENAI_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!accessToken) return null;
    let accountId = "";
    try {
      const rawUserInfo = await options.credentialService.load(
        `oauth:${OPENAI_PROVIDER_ID}:user_info`,
      );
      const parsed = rawUserInfo ? (JSON.parse(rawUserInfo) as { id?: unknown }) : null;
      const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
      if (id) accountId = id;
    } catch {
      // user_info 损坏不应阻断目录同步；退化为无账号隔离的缓存（下次登录刷新）。
    }
    return { accessToken, accountId };
  }

  async function readCache(): Promise<OpenAIModelCatalogCache | null> {
    let raw: string;
    try {
      raw = await readFile(cacheFilePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OpenAIModelCatalogCache>;
      if (
        parsed?.schemaVersion !== CATALOG_SCHEMA_VERSION ||
        typeof parsed.accountId !== "string" ||
        typeof parsed.fetchedAtMs !== "number" ||
        !Array.isArray(parsed.modelIds) ||
        parsed.modelIds.some((id) => typeof id !== "string")
      ) {
        return null;
      }
      return {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        accountId: parsed.accountId,
        fetchedAtMs: parsed.fetchedAtMs,
        modelIds: Object.freeze([...parsed.modelIds]),
      };
    } catch {
      return null;
    }
  }

  async function persistCache(cache: OpenAIModelCatalogCache): Promise<void> {
    try {
      await mkdir(join(options.configDir, "model-catalog"), { recursive: true });
      await atomicWritePrivateTextFile(
        cacheFilePath,
        JSON.stringify(
          {
            schemaVersion: cache.schemaVersion,
            accountId: cache.accountId,
            fetchedAtMs: cache.fetchedAtMs,
            modelIds: cache.modelIds,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      // 缓存写失败只影响下次启动的首帧速度，不改变本轮返回的目录。
      logger.warn(`OpenAI 模型目录缓存写入失败：${String(error)}`);
    }
  }

  async function fetchModelIds(material: {
    readonly accessToken: string;
    readonly accountId: string;
  }): Promise<readonly string[]> {
    const clientVersion = resolveOpenAICodexClientVersion(options.env);
    const response = await fetchImpl(
      `${resolveOpenAICodexBaseUrl(options.env)}/models?client_version=${encodeURIComponent(clientVersion)}`,
      {
        headers: {
          Authorization: `Bearer ${material.accessToken}`,
          ...(material.accountId ? { "chatgpt-account-id": material.accountId } : {}),
          originator: resolveOpenAICodexOriginator(options.env),
          version: clientVersion,
        },
        signal: AbortSignal.timeout(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`GET /models HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { models?: unknown };
    if (!Array.isArray(payload.models)) {
      throw new Error("GET /models 响应缺少 models 数组");
    }
    const modelIds: string[] = [];
    for (const entry of payload.models as OpenAIModelsResponseEntry[]) {
      const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
      if (!slug) continue;
      // hide 的模型是后端内部用途（如 auto-review），不得进入用户可选清单。
      if (entry.visibility !== "list") continue;
      // 版本门控之外的模型请求时会 400 requires a newer version，提前过滤。
      const minVersion =
        typeof entry.minimal_client_version === "string" ? entry.minimal_client_version : "";
      if (minVersion && compareOpenAIClientVersion(minVersion, clientVersion) > 0) continue;
      modelIds.push(slug);
    }
    return Object.freeze(modelIds);
  }

  return {
    async resolveModelIds(): Promise<readonly string[] | null> {
      const material = await loadTokenMaterial();
      if (!material) return null;
      const cache = await readCache();
      const now = options.now?.() ?? Date.now();
      if (
        cache &&
        cache.accountId === material.accountId &&
        // 缓存里的权威空清单不视为新鲜：空结果更可能来自后端异常响应，
        // 让它在下一轮重新拉取，而不是把「无模型」钉死 24 小时。
        now - cache.fetchedAtMs < ttlMs &&
        cache.modelIds.length > 0
      ) {
        return cache.modelIds;
      }
      if (inflightRefresh) return inflightRefresh;
      inflightRefresh = (async () => {
        try {
          const modelIds = await fetchModelIds(material);
          await persistCache({
            schemaVersion: CATALOG_SCHEMA_VERSION,
            accountId: material.accountId,
            fetchedAtMs: options.now?.() ?? Date.now(),
            modelIds,
          });
          return modelIds;
        } catch (error) {
          logger.warn(`OpenAI 模型目录拉取失败：${String(error)}`);
          // 换账号后的旧缓存不是当前账号的事实，宁可回静态兜底也不能串用。
          return cache && cache.accountId === material.accountId ? cache.modelIds : null;
        } finally {
          inflightRefresh = null;
        }
      })();
      return inflightRefresh;
    },
  };
}
