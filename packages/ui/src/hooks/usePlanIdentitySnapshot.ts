import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback } from "react";
import {
  getModelProviderFamilySpec,
  isZhipuAccountProviderFamily,
  normalizeProviderFamilyDomain,
  resolvePlanIdentitySnapshot,
  type PlanIdentitySnapshot,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { resolveEntitledAccountProviderAccessFingerprint } from "@/lib/accountProviderAccess.js";
import {
  buildUsageEntitlementCacheKey,
  USAGE_ENTITLEMENT_CACHE_TTL_MS,
} from "@/lib/usageEntitlementCache.js";

export function usePlanIdentitySnapshot(
  providerFamilyDomain: ProviderFamilyDomain | null | undefined,
  connectionSelection: ProviderFamilyConnectionSelection | null | undefined,
  usageStatsService?: IUsageStatsService,
): () => PlanIdentitySnapshot {
  const normalizedDomain = normalizeProviderFamilyDomain(providerFamilyDomain);
  // Plan Identity（个人/Start 套餐快照）是 z.ai 身份域概念；openai 是独立身份域，
  // 无 z.ai 套餐权益可查，直接按无 domain 处理，避免构造 zhipu-account 身份。
  const zhipuDomain = isZhipuAccountProviderFamily(normalizedDomain) ? normalizedDomain : null;
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const familySpec = zhipuDomain ? getModelProviderFamilySpec(zhipuDomain) : null;
  const codingPlanProviderId = familySpec
    ? connectionSelection?.kind === "team-coding-plan"
      ? familySpec.teamCodingPlanProviderId
      : familySpec.individualCodingPlanProviderId
    : "";
  const startPlanProviderId = familySpec?.startPlanProviderId ?? "";
  const codingPlanRefreshFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    codingPlanProviderId,
  );
  const codingPlanEntitlement = useUsageEntitlementWithService(usageStatsService, {
    enabled: Boolean(zhipuDomain && codingPlanRefreshFingerprint),
    includeSubscription: true,
    preferredProviderId: codingPlanProviderId,
    accountAccess: zhipuDomain
      ? {
          type: "zhipu-account",
          family: zhipuDomain,
          ...(connectionSelection?.kind === "team-coding-plan"
            ? ({
                planKind: "team-coding-plan",
                productId: connectionSelection.productId,
                organizationId: connectionSelection.organizationId,
                projectId: connectionSelection.projectId,
              } as const)
            : ({ planKind: "individual-coding-plan" } as const)),
        }
      : undefined,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: codingPlanProviderId,
      providerFingerprint: codingPlanRefreshFingerprint,
    }),
    refreshOnMount: false,
  });
  const startPlanEntitlement = useUsageEntitlementWithService(
    usageStatsService,
    buildStartPlanEntitlementOptions(providerSettingsView, startPlanProviderId),
  );

  return useCallback(
    () =>
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: normalizedDomain,
        codingPlanEntitlement: codingPlanEntitlement.snapshot,
        startPlanEntitlement: startPlanEntitlement.snapshot,
        now: Date.now(),
        entitlementCacheTtlMs: USAGE_ENTITLEMENT_CACHE_TTL_MS,
      }),
    [
      codingPlanEntitlement.snapshot,
      connectionSelection,
      normalizedDomain,
      startPlanEntitlement.snapshot,
    ],
  );
}
