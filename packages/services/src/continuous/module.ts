/**
 * continuous 模块清单：长期自主改进（Continuous）的领域、应用与适配器。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const continuousModule = {
  id: "continuous",
  requires: ["shared"],
  provides: ["continuous-service-contract"],
  publicEntrypoints: ["contract.ts"],
} as const;
