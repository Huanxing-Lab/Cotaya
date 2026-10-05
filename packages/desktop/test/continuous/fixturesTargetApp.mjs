// CT-09 目标应用 fixture（docs/testing/continuous.md §3「目标应用」）。
//
// 临时 Git fixture 内的可启动 UI 页面：header spacing、390px sidebar overflow、
// empty state 对比度三个已知问题 + Settings navigation（需要 Decision 的候选）。
// 测试命令是明确 argv 的 node 脚本（verify.mjs），不用 shell 拼接、不引入依赖。
//
// 注意区分：这是「被改进的目标应用」，不是 Continuous 控制页面；候选 done 必须同时有
// 代码 diff、本测试脚本通过、目标页面浏览器证据和独立 reviewer 结果（测试文档 §3）。

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HEADER_STYLES = `:root {
  --header-padding-y: 4px;
  --empty-contrast: #9aa0a6;
}
.app-header {
  display: flex;
  align-items: center;
  padding: var(--header-padding-y) 8px;
  gap: 4px;
}
`;

const SIDEBAR_STYLES = `.app-sidebar {
  width: 420px;
  min-width: 420px;
  overflow-x: visible;
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .app-sidebar { width: 420px; }
}
`;

const PAGE_MARKUP = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fixture target app</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="app-header" data-testid="target-app-header">
      <h1>Fixture app</h1>
      <nav><button type="button" aria-label="Open menu">Menu</button></nav>
    </header>
    <div class="app-body">
      <aside class="app-sidebar" data-testid="target-app-sidebar" aria-label="Primary">
        <ul>
          <li><a href="#/home" aria-current="page">Home</a></li>
          <li><a href="#/projects">Projects</a></li>
          <li><a href="#/settings">Settings</a></li>
        </ul>
      </aside>
      <main class="app-main">
        <section class="empty-state" data-testid="target-app-empty">
          <p>No projects yet</p>
        </section>
      </main>
    </div>
  </body>
</html>
`;

const VERIFY_SCRIPT = `#!/usr/bin/env node
// 目标应用自测命令（argv 明确：node test/verify.mjs [--json]）。
// 检查三个已知 UI 问题是否已被修复：header padding、390px sidebar overflow、empty state 对比度。
// 初始 fixture 处于「有问题」状态，该脚本以非零退出——候选修复后必须通过本脚本才允许提交。
import { readFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const css = readFileSync(path.join(root, "..", "styles.css"), "utf8");
const asJson = process.argv.includes("--json");
const failures = [];

const headerPadding = Number(/--header-padding-y:\\s*([0-9]+)px/.exec(css)?.[1] ?? 0);
if (headerPadding < 12) failures.push("header-padding-too-small");

const sidebarRule = /@media \\(max-width: 480px\\)\\s*\\{\\s*\\.app-sidebar\\s*\\{[^}]*width:\\s*(\\d+)px;[^}]*\\}\\s*\\}/.exec(css)?.[1];
const sidebarOverflow = /\\.app-sidebar\\s*\\{[^}]*overflow-x:\\s*hidden/.test(css);
if (!sidebarRule || Number(sidebarRule) > 390 || !sidebarOverflow) failures.push("sidebar-overflow-at-390");

const contrast = /--empty-contrast:\\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1] ?? "#9aa0a6";
const luminance = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  const scale = (channel) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * scale((value >> 16) & 0xff) + 0.7152 * scale((value >> 8) & 0xff) + 0.0722 * scale(value & 0xff);
};
const ratio = (luminance("#ffffff") + 0.05) / (luminance(contrast) + 0.05);
if (ratio < 4.5) failures.push("empty-state-contrast-below-4-5");

const result = { ok: failures.length === 0, failures, contrastRatio: Number(ratio.toFixed(2)) };
if (asJson) console.log(JSON.stringify(result));
else console.log(result.ok ? "target app checks passed" : \`target app checks failed: \${failures.join(", ")}\`);
process.exitCode = result.ok ? 0 : 1;
`;

/** 把目标应用文件写进 Git fixture 仓库（已知问题状态）。 */
export function writeTargetAppFiles(repoDir) {
  writeFileSync(path.join(repoDir, "index.html"), PAGE_MARKUP, "utf8");
  writeFileSync(
    path.join(repoDir, "styles.css"),
    `${HEADER_STYLES}\n${SIDEBAR_STYLES}\n.empty-state { color: var(--empty-contrast); }\n.app-body { display: flex; }\n`,
    "utf8",
  );
  mkdirSync(path.join(repoDir, "test"), { recursive: true });
  writeFileSync(path.join(repoDir, "test", "verify.mjs"), VERIFY_SCRIPT, "utf8");
  writeFileSync(
    path.join(repoDir, "package.json"),
    `${JSON.stringify(
      {
        name: "continuous-e2e-target-app",
        private: true,
        type: "module",
        scripts: { test: "node test/verify.mjs" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * 启动目标应用静态服务器（真实浏览器验证对象；进程由 runner 登记，随 suite 停止）。
 * 只读文件、只服务 repoDir 内的路径（resolve 后必须仍在 repoDir 内，防 traversal）。
 */
export function createTargetAppServer(run, { repoDir, host = "127.0.0.1" } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const candidate = path.resolve(repoDir, relative);
    if (!candidate.startsWith(`${path.resolve(repoDir)}${path.sep}`)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = readFileSync(candidate);
      response.writeHead(200, {
        "content-type": MIME_TYPES[path.extname(candidate)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  const started = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address()));
  });
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    // keep-alive socket 会挂住测试进程事件循环（fetch/undici 复用连接），关闭时主动断开。
    server.closeAllConnections?.();
  };
  run.cleanupFns.push(close);
  return {
    started,
    url: async () => `http://${host}:${(await started).port}/`,
    close,
  };
}
