// 规格 cotaya-brand-dataspace：主数据根目录名为 .cotaya（home 语义），项目级 .zcode/ 保持。
// 上游合并时最容易静默回退的就是这两组字符串——用可注入的公开解析函数钉住，
// 不依赖真实 HOME。
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAppConfigDir, getZCodeDataRootDir, setDataBaseDir } from "../src/paths.js";
import {
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
} from "../src/subagents/subagentStorage.js";

test("home data root is .cotaya under the resolved dataBaseDir", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "cotaya-data-root-"));
  setDataBaseDir(baseDir);
  try {
    assert.ok(getZCodeDataRootDir().endsWith(join(baseDir, ".cotaya")));
    assert.ok(getAppConfigDir().endsWith(join(baseDir, ".cotaya", "v2")));
  } finally {
    setDataBaseDir(null);
  }
});

test("user-level roots follow .cotaya with injected home", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "cotaya-fake-home-"));
  const userRoot = await resolveUserSubagentRoot({ homeDir: fakeHome });
  assert.equal(userRoot, join(fakeHome, ".cotaya", "agents"));
});

test("project-level directories keep the upstream .zcode convention", () => {
  const workspacePath = join(tmpdir(), "example-project");
  assert.equal(resolveWorkspaceSubagentRoot(workspacePath), join(workspacePath, ".zcode", "agents"));
});
