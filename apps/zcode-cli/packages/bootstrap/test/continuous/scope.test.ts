// CT-02 执行策略单元测试：U-03（Scope 与变更量）、E-13（越界工具与恶意绕过）、
// E-14（变更量与外部修改）在策略层的部分。用例定义见 docs/testing/continuous.md §5/§8。
// 纯函数测试：文件系统/符号链接事实用临时目录 + realpath 采集后作为输入传入。
// 运行入口：node scripts/test-continuous.mjs --suite unit（tsx + node:test）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import type { ContinuousScopePolicy } from "@zcode/shared";
import {
  authorizeContinuousBuilderCandidate,
  checkContinuousCapability,
  checkContinuousFilePath,
  checkContinuousGitOperation,
  checkContinuousShellCommand,
  continuousActorCapabilities,
  validateContinuousDeclaredTestCommands,
  type ContinuousExecutionPolicyConfig,
} from "../../src/app/continuous-execution-policy.js";
import { checkContinuousChangeBudget } from "../../src/app/continuous-change-budget.js";
import { continuousProtectedPathReason } from "../../src/app/continuous-protected-paths.js";

const SCOPE: ContinuousScopePolicy = {
  allowedPaths: ["packages/ui/src"],
  forbiddenPaths: ["packages/ui/src/secret"],
  forbiddenCapabilities: [
    "push",
    "merge",
    "deploy",
    "db_migration",
    "backend_rewrite",
    "billing_auth",
  ],
};

function makeConfig(
  overrides: Partial<ContinuousExecutionPolicyConfig> = {},
): ContinuousExecutionPolicyConfig {
  return {
    executionPath: "/wt/program-1",
    workspacePath: "/repos/original",
    scope: SCOPE,
    declaredTestCommands: [{ argv: ["pnpm", "--dir", "target-app", "test"] }],
    activeCandidate: { candidateId: "cand-1", targetPaths: ["packages/ui/src/header"] },
    pathStyle: "posix",
    caseInsensitiveFs: false,
    ...overrides,
  };
}

const WRITE = { role: "builder" as const, operation: "write" as const };
const READ = { role: "observer" as const, operation: "read" as const };

test("U-03/E-13: 角色——observer/reviewer 只读，builder 才能写、跑测试、提交", () => {
  assert.deepEqual(continuousActorCapabilities("observer"), {
    canReadFiles: true,
    canWriteFiles: false,
    canRunDeclaredTests: false,
    canCommit: false,
  });
  assert.deepEqual(
    continuousActorCapabilities("reviewer"),
    continuousActorCapabilities("observer"),
  );

  const config = makeConfig();
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/header/x.ts" }).allowed,
    true,
  );
  for (const role of ["observer", "reviewer"] as const) {
    const denied = checkContinuousFilePath(config, {
      role,
      operation: "write",
      path: "packages/ui/src/header/x.ts",
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "role_read_only");
    assert.equal(
      checkContinuousShellCommand(config, { role, argv: ["pnpm", "--dir", "target-app", "test"] })
        .reason,
      "role_read_only",
    );
    assert.equal(
      checkContinuousGitOperation(config, {
        role,
        operation: "commit",
        verification: {
          testsPassed: true,
          browserVerified: true,
          reviewPassed: true,
        },
      }).reason,
      "role_read_only",
    );
  }
  assert.equal(continuousActorCapabilities("builder").canWriteFiles, true);
});

test("U-03/E-13: 路径——traversal、绝对外部路径、原始仓库、反斜杠、NUL 全部拒绝", () => {
  const config = makeConfig();
  const denials: Array<[string, string | undefined]> = [
    ["packages/../../../../../etc/passwd", "outside_execution_path"],
    ["/etc/passwd", "outside_execution_path"],
    ["../../repos/original/docs", "original_workspace_out_of_scope"],
    ["/repos/original/packages/ui/src/header/x.ts", "original_workspace_out_of_scope"],
    ["packages/ui/src/header/../../secret.js", "not_in_allowed_paths"],
    ["packages\\ui\\src\\header\\x.ts", "backslash_path"],
    ["packages/ui/src/header/x\0.ts", "invalid_path"],
  ];
  for (const [path, reason] of denials) {
    const decision = checkContinuousFilePath(config, { ...WRITE, path });
    assert.equal(decision.allowed, false, `应拒绝: ${JSON.stringify(path)}`);
    assert.equal(decision.code, "scope_denied");
    assert.equal(decision.reason, reason, `拒绝原因: ${JSON.stringify(path)}`);
  }
});

test("U-03: symlink 逃逸——realpath 落在 executionPath 之外即拒绝（真实符号链接采集）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ct02-scope-"));
  mkdirSync(join(tmp, "wt"), { recursive: true });
  const executionPath = realpathSync(join(tmp, "wt"));
  mkdirSync(join(executionPath, "packages/ui/src"), { recursive: true });
  const outsideTarget = join(tmp, "outside.txt");
  writeFileSync(outsideTarget, "outside");
  symlinkSync(outsideTarget, join(executionPath, "packages/ui/src/escape.ts"));

  const config = makeConfig({
    executionPath,
    workspacePath: realpathSync(tmp),
    activeCandidate: { candidateId: "cand-1", targetPaths: ["packages/ui/src"] },
  });
  const linkPath = join(executionPath, "packages/ui/src/escape.ts");
  const decision = checkContinuousFilePath(config, {
    ...WRITE,
    path: linkPath,
    resolvedRealPath: realpathSync(linkPath),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "symlink_escape");

  // 不带 realpath 证据时字符串路径合法（采集由执行适配器负责，策略不假设）
  assert.equal(checkContinuousFilePath(config, { ...WRITE, path: linkPath }).allowed, true);
});

test("U-03: 大小写——敏感文件系统按字节比较，不敏感系统折叠大小写防同文件绕过", () => {
  const sensitive = makeConfig();
  assert.equal(
    checkContinuousFilePath(sensitive, { ...WRITE, path: "Packages/UI/src/header/x.ts" }).reason,
    "not_in_allowed_paths",
  );

  // 不敏感 fs（darwin/win32）：大小写不同仍指向同一文件，必须仍在 Scope 判定内
  const insensitive = makeConfig({ caseInsensitiveFs: true });
  const allowed = checkContinuousFilePath(insensitive, {
    ...WRITE,
    path: "Packages/UI/src/header/x.ts",
  });
  assert.equal(allowed.allowed, true, "不敏感 fs 上的大小写变体是同一文件，不得借字符串差异绕过");
});

test("U-03/E-25: Windows 路径——分隔符、盘符相对、UNC 与冒号形态", () => {
  const config = makeConfig({
    executionPath: "C:\\wt\\program-1",
    workspacePath: "C:\\repos\\original",
    pathStyle: "win32",
    caseInsensitiveFs: true,
  });
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages\\ui\\src\\header\\x.ts" }).allowed,
    true,
    "win32 分隔符路径在 Scope 内必须可用（空格/分隔符不是拒绝理由）",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "C:foo.ts" }).reason,
    "invalid_path",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "\\\\server\\share\\x.ts" }).reason,
    "invalid_path",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages\\ui\\src\\header\\a:b.ts" }).reason,
    "invalid_path",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "D:\\other\\x.ts" }).reason,
    "outside_execution_path",
  );
});

test("U-03: 空格与 Unicode 路径在 Scope 内正常放行", () => {
  const config = makeConfig({
    activeCandidate: { candidateId: "cand-1", targetPaths: ["packages/ui/src"] },
  });
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/my header 组件.tsx" })
      .allowed,
    true,
  );
});

test("U-03: forbidden 路径、Scope 外路径与受保护路径各自拒绝", () => {
  const config = makeConfig({
    activeCandidate: { candidateId: "cand-1", targetPaths: ["packages/ui/src"] },
  });
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/secret/key.ts" }).reason,
    "forbidden_path",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/server/src/api.ts" }).reason,
    "not_in_allowed_paths",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/pnpm-lock.yaml" }).reason,
    "protected_path",
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/logo.png" }).reason,
    "protected_path",
  );
});

test("U-03: 受保护路径——lockfile、依赖定义、测试基础设施、binary（未知语义不扩大 allowed）", () => {
  assert.equal(continuousProtectedPathReason("pnpm-lock.yaml"), "lockfile");
  assert.equal(continuousProtectedPathReason("apps/web/package.json"), "dependency_manifest");
  assert.equal(continuousProtectedPathReason("apps/web/e2e/home.test.ts"), "test_infrastructure");
  assert.equal(
    continuousProtectedPathReason("packages/ui/src/button.test.tsx"),
    "test_infrastructure",
  );
  assert.equal(continuousProtectedPathReason("vitest.config.mts"), "test_infrastructure");
  assert.equal(continuousProtectedPathReason("assets/hero.png"), "binary");
  assert.equal(continuousProtectedPathReason("packages/ui/src/header/Header.tsx"), null);
});

test("U-03: builder 写入只落在当前候选授权路径内", () => {
  const config = makeConfig();
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/header/Header.tsx" })
      .allowed,
    true,
  );
  assert.equal(
    checkContinuousFilePath(config, { ...WRITE, path: "packages/ui/src/sidebar/Sidebar.tsx" })
      .reason,
    "not_in_candidate_paths",
  );
  const noCandidate = makeConfig({ activeCandidate: null });
  assert.equal(
    checkContinuousFilePath(noCandidate, { ...WRITE, path: "packages/ui/src/header/x.ts" }).reason,
    "candidate_inactive",
  );
});

test("U-03: builder 一次一个候选——不同候选占用期拒绝，同候选幂等", () => {
  assert.equal(
    authorizeContinuousBuilderCandidate({ candidateId: "cand-1", targetPaths: [] }, "cand-2")
      .reason,
    "candidate_busy",
  );
  assert.equal(
    authorizeContinuousBuilderCandidate({ candidateId: "cand-1", targetPaths: [] }, "cand-1")
      .allowed,
    true,
  );
  assert.equal(authorizeContinuousBuilderCandidate(null, "cand-2").allowed, true);
});

test("E-13: shell/外部工具——只放行与声明完全一致的 argv，任意 shell/push/migration 拒绝", () => {
  const config = makeConfig();
  const declared = ["pnpm", "--dir", "target-app", "test"];
  assert.equal(
    checkContinuousShellCommand(config, { role: "builder", argv: declared }).allowed,
    true,
  );
  assert.equal(
    checkContinuousShellCommand(config, { role: "builder", argv: ["pnpm", "--dir", "target-app"] })
      .reason,
    "undeclared_command",
    "前缀匹配不算声明命令",
  );
  assert.equal(
    checkContinuousShellCommand(config, {
      role: "builder",
      argv: ["sh", "-c", "pnpm --dir target-app test"],
    }).reason,
    "undeclared_command",
    "shell 包装一律拒绝（argv 语义即不经 shell）",
  );
  assert.equal(
    checkContinuousShellCommand(config, {
      role: "builder",
      argv: ["pnpm", "--dir", "target-app", "test; git push"],
    }).reason,
    "undeclared_command",
    "拼接注入不是已声明 argv",
  );
  assert.equal(
    checkContinuousShellCommand(config, {
      role: "builder",
      argv: ["git", "push", "origin", "main"],
    }).reason,
    "forbidden_capability",
  );
  assert.equal(
    checkContinuousShellCommand(config, { role: "builder", argv: ["git", "merge", "--abort"] })
      .reason,
    "forbidden_capability",
  );
  assert.equal(
    checkContinuousShellCommand(config, { role: "builder", argv: [] }).reason,
    "invalid_command",
  );
});

test("E-13: 声明校验拒绝 mutating git；能力面 mcp 写/关沙箱恒拒（yolo 不进入本策略）", () => {
  assert.equal(validateContinuousDeclaredTestCommands([{ argv: ["pnpm", "test"] }]).ok, true);
  const bad = validateContinuousDeclaredTestCommands([{ argv: ["git", "push"] }]);
  assert.equal(bad.ok, false);

  const config = makeConfig();
  assert.equal(checkContinuousCapability(config, "mcp_write").reason, "forbidden_capability");
  assert.equal(checkContinuousCapability(config, "sandbox_disable").reason, "forbidden_capability");
  assert.equal(checkContinuousCapability(config, "push").reason, "forbidden_capability");
  assert.equal(checkContinuousCapability(config, "db_migration").reason, "forbidden_capability");
});

test("U-03/E-12: git 操作——测试+浏览器+Review 全通过才允许本地 commit；push/merge 全禁", () => {
  const config = makeConfig();
  const verification = { testsPassed: true, browserVerified: true, reviewPassed: true };
  assert.equal(
    checkContinuousGitOperation(config, { role: "builder", operation: "commit", verification })
      .allowed,
    true,
  );
  assert.equal(
    checkContinuousGitOperation(config, {
      role: "builder",
      operation: "commit",
      verification: { ...verification, reviewPassed: false },
    }).reason,
    "validation_required",
  );
  assert.equal(
    checkContinuousGitOperation(config, { role: "builder", operation: "commit" }).reason,
    "validation_required",
  );
  assert.equal(
    checkContinuousGitOperation(config, { role: "builder", operation: "push" }).reason,
    "forbidden_capability",
  );
  assert.equal(
    checkContinuousGitOperation(config, { role: "builder", operation: "merge" }).reason,
    "forbidden_capability",
  );
  assert.equal(
    checkContinuousGitOperation(config, { role: "builder", operation: "db_migration" }).reason,
    "forbidden_capability",
  );
});

test("U-03/E-14: 累计文件/行数上限——去重、rename 双名额、binary 计文件不计行", () => {
  const limits = { maxFiles: 10, maxChangedLines: 400 };
  const applied = [
    { path: "packages/ui/src/a.ts", kind: "modify" as const, added: 50, removed: 10 },
    { path: "packages/ui/src/a.ts", kind: "modify" as const, added: 20, removed: 5 },
  ];
  assert.deepEqual(
    checkContinuousChangeBudget(limits, applied, []).projectedFiles,
    1,
    "同文件多次修改去重",
  );

  const renames = [
    {
      path: "packages/ui/src/new.ts",
      originalPath: "packages/ui/src/old.ts",
      kind: "rename" as const,
      added: 0,
      removed: 0,
    },
  ];
  assert.deepEqual(
    checkContinuousChangeBudget(limits, [], renames).projectedFiles,
    2,
    "rename 新旧路径各占名额",
  );

  const binary = [{ path: "assets/icon2.png", kind: "binary" as const, added: 0, removed: 0 }];
  assert.deepEqual(checkContinuousChangeBudget(limits, [], binary).projectedFiles, 1);

  const manyFiles = Array.from({ length: 10 }, (_, index) => ({
    path: `packages/ui/src/f${index}.ts`,
    kind: "modify" as const,
    added: 1,
    removed: 0,
  }));
  assert.equal(checkContinuousChangeBudget(limits, manyFiles, []).allowed, true);
  const overflow = checkContinuousChangeBudget(limits, manyFiles, [
    { path: "packages/ui/src/f10.ts", kind: "modify" as const, added: 1, removed: 0 },
  ]);
  assert.equal(overflow.allowed, false);
  assert.equal(overflow.code, "file_limit");

  const lineOverflow = checkContinuousChangeBudget(
    limits,
    [{ path: "packages/ui/src/big.ts", kind: "modify" as const, added: 395, removed: 10 }],
    [],
  );
  assert.equal(lineOverflow.allowed, false);
  assert.equal(lineOverflow.code, "line_limit");
  assert.equal(lineOverflow.projectedChangedLines, 405);
});
