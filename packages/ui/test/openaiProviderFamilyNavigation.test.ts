import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { connectionSelectionMatchesNavigationItem } from "../src/settings/model-provider-section/useModelProviderNavigation.js";
import type { ModelProviderNavItem } from "../src/settings/model-provider-section/constants.js";

type NavigationItemInput = Exclude<ModelProviderNavItem, { type: "codingPlanLoading" }>;

function createPresetItem(presetId: string): NavigationItemInput {
  return {
    key: `preset:${presetId}`,
    type: "preset",
    presetId,
    label: presetId,
    provider: null,
    displayName: presetId,
    statusActive: false,
  };
}

function createCodingPlanItem(presetId: string): NavigationItemInput {
  return {
    key: `coding:${presetId}`,
    type: "codingPlan",
    presetId,
    oauthProviderId: "zai",
    label: presetId,
    providerName: presetId,
    provider: null,
    status: "purchased",
    statusActive: false,
  };
}

test("openai 的 individual 选择必须匹配品牌 preset 入口（修复设置页误报连接不可用）", () => {
  const item = createPresetItem(BUILTIN_MODEL_PROVIDER_IDS.openaiPlan);
  assert.equal(
    connectionSelectionMatchesNavigationItem("openai", { kind: "individual-coding-plan" }, item),
    true,
  );
});

test("openai 选择不得匹配其他 family 的 codingPlan item", () => {
  const zaiItem = createCodingPlanItem(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
  assert.equal(
    connectionSelectionMatchesNavigationItem("openai", { kind: "individual-coding-plan" }, zaiItem),
    false,
  );
});

test("openai 的 team/start 选择形状不匹配 preset 入口", () => {
  const item = createPresetItem(BUILTIN_MODEL_PROVIDER_IDS.openaiPlan);
  assert.equal(
    connectionSelectionMatchesNavigationItem("openai", { kind: "start-plan" }, item),
    false,
  );
  assert.equal(
    connectionSelectionMatchesNavigationItem(
      "openai",
      { kind: "team-coding-plan", productId: "p", organizationId: "o", projectId: "j" },
      item,
    ),
    false,
  );
});

test("z.ai 域 individual 选择仍只匹配 codingPlan item，preset 入口不承载连接选择", () => {
  const codingItem = createCodingPlanItem(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
  assert.equal(
    connectionSelectionMatchesNavigationItem("zai", { kind: "individual-coding-plan" }, codingItem),
    true,
  );
  assert.equal(
    connectionSelectionMatchesNavigationItem(
      "zai",
      { kind: "individual-coding-plan" },
      createPresetItem(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan),
    ),
    false,
  );
});
