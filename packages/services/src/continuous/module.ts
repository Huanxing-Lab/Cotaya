/**
 * continuous 模块清单：长期自主改进（Continuous）的领域、应用与适配器。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外暴露 contract.ts 与
 * contract-interfaces.ts（后者是接口 + RPC 描述符的 browser-safe 叶子：包根 index.ts 与
 * renderer 只消费它，避免经 contract.ts 的实现类 value 再导出把 node:* 链拉进浏览器图）。
 * CT-02 起 adapters 复用 services 核心的公开 Git 边界（git/providers、git/repo、paths），
 * 因此声明对 services 的依赖；不得依赖 Runtime 实现（apps/zcode-cli）。
 */
export const continuousModule = {
  id: "continuous",
  requires: ["shared", "services"],
  provides: ["continuous-service-contract"],
  publicEntrypoints: ["contract.ts", "contract-interfaces.ts"],
} as const;
