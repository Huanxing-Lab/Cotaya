// CT-02 workspace 集成测试：I-04（worktree 与检查点）、E-02（未提交的用户改动受到保护）。
// 用例定义见 docs/testing/continuous.md §6/§8；全部使用真实 Git 仓库（子进程 git），
// 原工作区前后以 porcelain status + 逐文件 sha256 对照，禁止内存 mock 替代文件事实。
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node:test）。

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createWorkspacePreparation } from "../../src/continuous/adapters/workspacePreparation.js";
import { computeCandidateWriteFingerprint } from "../../src/continuous/adapters/candidateCheckpointStore.js";
import { WorkspacePreparationError } from "../../src/continuous/adapters/workspaceGitOps.js";

const execFileAsync = promisify(execFile);

const tmpRoot = mkdtempSync(join(tmpdir(), "continuous-ct02-"));
const fixedNow = 1_750_000_000_000;
const clock = { now: () => fixedNow };

function fixtureDir(name: string): string {
  return join(tmpRoot, name);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function initOriginRepo(name: string): Promise<string> {
  const repoDir = fixtureDir(name);
  mkdirSync(repoDir, { recursive: true });
  await git(repoDir, "init", "--initial-branch=main");
  await git(repoDir, "config", "user.email", "continuous@example.test");
  await git(repoDir, "config", "user.name", "Continuous Test");
  writeFile(join(repoDir, "packages", "ui", "src", "button.tsx"), "export const a = 1;\n");
  writeFile(join(repoDir, "docs", "readme.md"), "# v1\n");
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-m", "init");
  return repoDir;
}

/** 三类未提交改动：staged / unstaged / untracked（E-02 设置）。 */
async function seedUncommittedChanges(repoDir: string): Promise<void> {
  writeFileSync(join(repoDir, "docs", "readme.md"), "# v1\nstaged local edit\n");
  await git(repoDir, "add", "docs/readme.md");
  writeFileSync(join(repoDir, "packages", "ui", "src", "button.tsx"), "export const a = 2;\n");
  writeFile(join(repoDir, "notes", "local.txt"), "untracked local note\n");
}

interface RepoSnapshot {
  status: string;
  head: string;
  fileHashes: Record<string, string>;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function snapshotRepo(repoDir: string): Promise<RepoSnapshot> {
  return {
    status: await git(repoDir, "status", "--porcelain=v2", "--branch", "--untracked-files=all"),
    head: (await git(repoDir, "rev-parse", "HEAD")).trim(),
    fileHashes: {
      "docs/readme.md": hashFile(join(repoDir, "docs", "readme.md")),
      "packages/ui/src/button.tsx": hashFile(join(repoDir, "packages", "ui", "src", "button.tsx")),
      "notes/local.txt": hashFile(join(repoDir, "notes", "local.txt")),
    },
  };
}

function makeAdapter(worktreesRoot: string) {
  return createWorkspacePreparation({ worktreeRootDir: worktreesRoot, clock });
}

async function assertOriginalWorkspaceUntouched(
  repoDir: string,
  before: RepoSnapshot,
): Promise<void> {
  const after = await snapshotRepo(repoDir);
  assert.equal(
    after.status,
    before.status,
    "原工作区 Git 状态（staged/unstaged/untracked）必须原样",
  );
  assert.equal(after.head, before.head, "原工作区分支 HEAD 不能被推进");
  assert.deepEqual(after.fileHashes, before.fileHashes, "原工作区文件字节必须逐文件一致");
}

test("I-04/E-02: prepare 从 HEAD 创建分支/worktree，原工作区 staged/unstaged/untracked 字节不变", async () => {
  const repoDir = await initOriginRepo("origin-protect");
  await seedUncommittedChanges(repoDir);
  const before = await snapshotRepo(repoDir);

  const adapter = makeAdapter(fixtureDir("worktrees-protect"));
  const result = await adapter.prepare({
    programId: "prog-protect",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-protect",
  });

  assert.ok(result.executionPath.startsWith(join(fixtureDir("worktrees-protect"), "prog-protect")));
  assert.equal(result.branchName, "codex/continuous-prog-protect");
  assert.equal(result.baseCommit, before.head);
  assert.ok(existsSync(join(result.executionPath, "packages", "ui", "src", "button.tsx")));
  // worktree 从 HEAD 开始：不复制 staged/unstaged/untracked 的本地改动
  assert.equal(
    readFileSync(join(result.executionPath, "docs", "readme.md"), "utf8"),
    "# v1\n",
    "worktree 内容必须是 HEAD 版本，而不是原工作区 staged 版本",
  );
  assert.equal(
    readFileSync(join(result.executionPath, "packages", "ui", "src", "button.tsx"), "utf8"),
    "export const a = 1;\n",
  );
  assert.ok(
    !existsSync(join(result.executionPath, "notes", "local.txt")),
    "untracked 文件不得复制",
  );

  await assertOriginalWorkspaceUntouched(repoDir, before);
  const branch = await git(
    repoDir,
    "rev-parse",
    "--verify",
    "refs/heads/codex/continuous-prog-protect",
  );
  assert.equal(branch.trim(), before.head, "Program 分支必须指向所选 HEAD");
});

test("I-04: prepare 幂等；release 保留分支与提交，重新 prepare 复用同一 worktree", async () => {
  const repoDir = await initOriginRepo("origin-reuse");
  const adapter = makeAdapter(fixtureDir("worktrees-reuse"));

  const first = await adapter.prepare({
    programId: "prog-reuse",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-reuse",
  });

  // 在 worktree 内做一次候选提交，验证 release 不删除成果
  writeFileSync(
    join(first.executionPath, "packages", "ui", "src", "button.tsx"),
    "export const a = 9;\n",
  );
  await git(first.executionPath, "add", ".");
  await git(first.executionPath, "commit", "-m", "candidate 1");
  const tipBeforeRelease = (await git(first.executionPath, "rev-parse", "HEAD")).trim();

  const second = await adapter.prepare({
    programId: "prog-reuse",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-reuse",
  });
  assert.equal(second.executionPath, first.executionPath, "幂等 prepare 复用同一 executionPath");
  assert.equal(second.baseCommit, tipBeforeRelease, "已推进的分支 HEAD 如实返回");

  await adapter.release("prog-reuse");
  assert.ok(
    existsSync(join(first.executionPath, "packages", "ui", "src", "button.tsx")),
    "worktree 目录保留",
  );
  const tipAfterRelease = (
    await git(repoDir, "rev-parse", "refs/heads/codex/continuous-prog-reuse")
  ).trim();
  assert.equal(tipAfterRelease, tipBeforeRelease, "release 后分支与提交必须保留");

  const third = await adapter.prepare({
    programId: "prog-reuse",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-reuse",
  });
  assert.equal(
    third.executionPath,
    first.executionPath,
    "release 后重新 prepare 复用既有 worktree",
  );
});

test("I-04: 候选检查点恢复只动归属明确的路径；外部改动拒绝覆盖、不做整仓 reset", async () => {
  const repoDir = await initOriginRepo("origin-checkpoint");
  const adapter = makeAdapter(fixtureDir("worktrees-checkpoint"));
  const prepared = await adapter.prepare({
    programId: "prog-ckpt",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-ckpt",
  });
  const executionPath = prepared.executionPath;

  await adapter.createCandidateCheckpoint({
    programId: "prog-ckpt",
    candidateId: "cand-1",
    executionPath,
    ownedPaths: ["packages/ui/src/button.tsx", "packages/ui/src/new-file.tsx", "docs/readme.md"],
  });

  // 候选写入：修改既有文件 + 新增文件；docs/readme.md 不写（留作外部改动对照）
  writeFileSync(
    join(executionPath, "packages", "ui", "src", "button.tsx"),
    "export const a = 42;\n",
  );
  writeFileSync(
    join(executionPath, "packages", "ui", "src", "new-file.tsx"),
    "export const b = 1;\n",
  );
  // 非候选路径的无关未跟踪文件：恢复绝不触碰（禁止整仓 clean）
  writeFileSync(join(executionPath, "outside.txt"), "user artifact\n");
  // 外部并发改动（E-14 barrier 间外部编辑）
  writeFileSync(join(executionPath, "docs", "readme.md"), "# v1\nexternal edit\n");

  const outcomes = await adapter.restoreCandidateFiles({
    programId: "prog-ckpt",
    candidateId: "cand-1",
    candidateWrites: [
      {
        path: "packages/ui/src/button.tsx",
        contentOid: await computeCandidateWriteFingerprint(
          join(executionPath, "packages", "ui", "src", "button.tsx"),
        ),
      },
      {
        path: "packages/ui/src/new-file.tsx",
        contentOid: await computeCandidateWriteFingerprint(
          join(executionPath, "packages", "ui", "src", "new-file.tsx"),
        ),
      },
    ],
  });

  const byPath = new Map(outcomes.map((outcome) => [outcome.path, outcome]));
  assert.deepEqual(byPath.get("packages/ui/src/button.tsx"), {
    path: "packages/ui/src/button.tsx",
    action: "restored",
  });
  assert.deepEqual(byPath.get("packages/ui/src/new-file.tsx"), {
    path: "packages/ui/src/new-file.tsx",
    action: "deleted",
  });
  assert.deepEqual(byPath.get("docs/readme.md"), {
    path: "docs/readme.md",
    action: "refused",
    reason: "modified_without_attribution",
  });

  assert.equal(
    readFileSync(join(executionPath, "packages", "ui", "src", "button.tsx"), "utf8"),
    "export const a = 1;\n",
    "归属明确的修改必须恢复到检查点内容",
  );
  assert.ok(
    !existsSync(join(executionPath, "packages", "ui", "src", "new-file.tsx")),
    "候选新增文件删除",
  );
  assert.equal(
    readFileSync(join(executionPath, "docs", "readme.md"), "utf8"),
    "# v1\nexternal edit\n",
    "外部改动字节保持不动，不得覆盖",
  );
  assert.ok(existsSync(join(executionPath, "outside.txt")), "无关未跟踪文件不得被清理");

  // 检查点一次性消费：二次恢复显式失败，而不是基于过期状态重放
  await assert.rejects(
    adapter.restoreCandidateFiles({
      programId: "prog-ckpt",
      candidateId: "cand-1",
      candidateWrites: [],
    }),
    (error: unknown) =>
      error instanceof WorkspacePreparationError && error.code === "candidate_checkpoint_unknown",
  );
});

test("I-04/E-14: 候选写入后又遭外部编辑的路径拒绝恢复（externally_modified）", async () => {
  const repoDir = await initOriginRepo("origin-external");
  const adapter = makeAdapter(fixtureDir("worktrees-external"));
  const prepared = await adapter.prepare({
    programId: "prog-ext",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-ext",
  });
  const executionPath = prepared.executionPath;

  await adapter.createCandidateCheckpoint({
    programId: "prog-ext",
    candidateId: "cand-ext",
    executionPath,
    ownedPaths: ["packages/ui/src/button.tsx"],
  });

  writeFileSync(
    join(executionPath, "packages", "ui", "src", "button.tsx"),
    "export const a = 7;\n",
  );
  const fingerprint = await computeCandidateWriteFingerprint(
    join(executionPath, "packages", "ui", "src", "button.tsx"),
  );
  // 候选最后写入之后的外部编辑：指纹不再匹配
  writeFileSync(
    join(executionPath, "packages", "ui", "src", "button.tsx"),
    "export const a = 8;\n",
  );

  const outcomes = await adapter.restoreCandidateFiles({
    programId: "prog-ext",
    candidateId: "cand-ext",
    candidateWrites: [{ path: "packages/ui/src/button.tsx", contentOid: fingerprint }],
  });
  assert.deepEqual(outcomes, [
    {
      path: "packages/ui/src/button.tsx",
      action: "refused",
      reason: "externally_modified",
    },
  ]);
  assert.equal(
    readFileSync(join(executionPath, "packages", "ui", "src", "button.tsx"), "utf8"),
    "export const a = 8;\n",
    "归属不明时保持现状并留证，不得覆盖",
  );
});

test("I-04: 未登记的 executionPath 不能建检查点；symlink 路径拒绝恢复", async () => {
  const repoDir = await initOriginRepo("origin-guards");
  const adapter = makeAdapter(fixtureDir("worktrees-guards"));

  await assert.rejects(
    adapter.createCandidateCheckpoint({
      programId: "prog-guards",
      candidateId: "cand-x",
      executionPath: fixtureDir("worktrees-guards").concat("/not-managed"),
      ownedPaths: ["packages/ui/src/button.tsx"],
    }),
    (error: unknown) =>
      error instanceof WorkspacePreparationError && error.code === "worktree_not_managed",
  );

  const prepared = await adapter.prepare({
    programId: "prog-guards",
    workspacePath: repoDir,
    baseCommit: "HEAD",
    branchName: "codex/continuous-prog-guards",
  });
  await adapter.createCandidateCheckpoint({
    programId: "prog-guards",
    candidateId: "cand-link",
    executionPath: prepared.executionPath,
    ownedPaths: ["docs/link.md"],
  });
  // 用 symlink 替换目标文件：lstat 识别后拒绝读取/覆盖
  const { symlink, rm } = await import("node:fs/promises");
  await rm(join(prepared.executionPath, "docs", "link.md"), { force: true });
  writeFileSync(fixtureDir("outside-target.md"), "outside\n");
  await symlink(fixtureDir("outside-target.md"), join(prepared.executionPath, "docs", "link.md"));

  const outcomes = await adapter.restoreCandidateFiles({
    programId: "prog-guards",
    candidateId: "cand-link",
    candidateWrites: [],
  });
  assert.deepEqual(outcomes, [
    { path: "docs/link.md", action: "refused", reason: "symlink_present" },
  ]);
  assert.ok(existsSync(fixtureDir("outside-target.md")), "symlink 目标不被触碰");
});
