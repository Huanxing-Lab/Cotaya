// 根入口 browser-safe 回归（CT-10 评审修复）：packages/services 根 index.ts 会被
// renderer（desktop/web）经 value import 拉进浏览器包。曾在根入口 value 再导出 continuous
// 实现类（contract.ts → application/adapters 的 node:crypto、node:fs/promises、node:module、
// node:sqlite 链），esbuild --platform=browser 实测 17 处 node:* 不可解析，破坏 web 与
// desktop renderer 构建。本测试用真实 esbuild bundle 复现该构建形态，锁住「根入口不得
// 解析到任何 node:* 模块」的仓库分层约定（index.ts 内 conversation share / onboarding
// 注释声明的同一规则）。
import { build } from "esbuild";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const servicesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

test("根入口 src/index.ts 保持 browser-safe：bundle 无 node:* 解析错误", async () => {
  const result = await build({
    entryPoints: [path.join(servicesRoot, "index.ts")],
    bundle: true,
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  // build 未抛错即 0 个解析错误；再核对产物文本不含 node: 模块引用（双保险）。
  const text = result.outputFiles.map((file) => file.text).join("\n");
  const nodeRefs = text.match(/from\s*"node:[^"]*"|require\("node:[^"]*"\)/g) ?? [];
  if (nodeRefs.length > 0) {
    throw new Error(`browser bundle 解析到 node:* 模块: ${[...new Set(nodeRefs)].join(", ")}`);
  }
});
