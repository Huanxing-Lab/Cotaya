import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  OPENAI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
} from "@zcode/shared";
import { accountProviderCredentialKey } from "../model-provider/accountProviderCredentialKey.js";
import type { AccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";

interface OAuthProviderLogoutDependencies {
  readonly accountProviderCredentialStore: Pick<AccountProviderCredentialStore, "deleteApiKey">;
  readonly refreshAccountProviders?: (reason: string) => Promise<unknown>;
}

export function createOAuthProviderLogoutHandler(
  dependencies: OAuthProviderLogoutDependencies,
): (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void> {
  return async (provider, accountIdentity) => {
    const providerIds = resolveProviderIds(provider);
    if (!providerIds) return;

    if (providerIds.codingPlan && accountIdentity?.trim()) {
      await dependencies.accountProviderCredentialStore.deleteApiKey(
        accountProviderCredentialKey({
          providerId: providerIds.codingPlan,
          planKind: "individual-coding-plan",
          accountIdentity,
        }),
      );
    }
    // openai 域无 z.ai Coding Plan 派生 key，但登出后 account:openai-plan 的
    // entitled/current 投影必须刷新，否则连接态残留到下一次账号事件。
    await dependencies.refreshAccountProviders?.(`oauth-logout:${provider}`);
  };
}

function resolveProviderIds(provider: OAuthProviderId): {
  readonly codingPlan: string | null;
} | null {
  if (provider === ZAI_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    };
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }
  if (provider === OPENAI_PROVIDER_ID) {
    // openai 是独立身份域：无个人 Coding Plan 派生 key，仅触发账号投影刷新。
    return { codingPlan: null };
  }
  return null;
}
