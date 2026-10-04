import type { ProviderSettingsView } from "@zcode/services";
import {
  isZhipuAccountProviderFamily,
  resolveModelProviderFamilySpecByProviderId,
} from "@zcode/shared";
import type { UseUsageEntitlementOptions } from "@/hooks/useUsageEntitlement.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";

/** 设置、输入框与提交推荐复用原权益缓存；账号身份由 Account Source 的连接指纹提供。 */
export function buildStartPlanEntitlementOptions(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  const inspection = resolveAccountProviderInspectionAccess(view, providerId);
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  const family = resolveModelProviderFamilySpecByProviderId(providerId);
  // Start Plan 是 z.ai 身份域专属；openai 无此权益，不构造 zhipu-account 身份。
  const zhipuFamilyId = family && isZhipuAccountProviderFamily(family.id) ? family.id : null;
  const fingerprint = inspection
    ? JSON.stringify([provider?.accountState?.connectionKey ?? view?.revision, inspection])
    : "";
  return {
    enabled: Boolean(inspection && zhipuFamilyId),
    preferredProviderId: providerId,
    accountAccess: zhipuFamilyId
      ? { type: "zhipu-account", family: zhipuFamilyId, planKind: "start-plan" }
      : undefined,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({ providerId, providerFingerprint: fingerprint }),
    refreshOnMount: false,
  };
}
