// ============================================================
// Continuous 命令隔离提供方（CT-11 第 3 条）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-11 第 3 条——「声明测试由受控
// argv 端口执行……实际限制文件/网络副作用。缺少可信隔离实现继续返回不可用，不能把
// request.sandbox.enabled 当证明」。
//
// 隔离的信任不来自声称，来自**构造期自证**：提供方就位时在同一 profile 下真实执行
// 两条金丝雀——①在允许目录内的写入必须成功（profile 没有把命令整个废掉）；②在允许
// 目录之外的写入必须被操作系统拒绝、③出网必须被拒绝。任何一条不符即视为不可用
//（fail closed，回 confined_execution_not_supported）。
//
// darwin 实现：seatbelt（/usr/bin/sandbox-exec，纯语法 profile）。Apple 标记为
// deprecated 但在当前系统仍执行；这正是需要自证而不是信任可执行文件存在的原因——
// 未来版本移除或语义变化时，金丝雀会让提供方自动退场，而不是悄悄失去隔离。
// 其他平台（linux/win32）无免安装可信实现：恒 unavailable，由平台执行模式
//（observe_only）与缺省拒绝兜底，不伪装隔离。
//
// 已知边界（如实声明，不宣称完整沙箱）：
//   - profile 只约束文件写入与网络；读取不限制（观察需要读）；
//   - 允许目录内的进程仍可在允许目录内做任意事（包括写坏 worktree——那是变更量
//     上限与检查点恢复的职责范围，不是命令隔离的）；
//   - 时间类/syscall 类攻击（如 fork 炸弹、ptrace）不在本 profile 的承诺内。

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export interface ContinuousIsolationProvider {
  /** 稳定键（证据记录用）：darwin-seatbelt / test-passthrough 等。 */
  readonly key: string;
  /** 构造期自证已通过（可用性唯一依据；请求侧的任何声称不算数）。 */
  readonly verified: boolean;
  /**
   * 自证明细（verified=false 时的诊断面；不含用户数据）。
   */
  readonly verification?:
    | { insideWriteAllowed: boolean; outsideWriteDenied: boolean; networkDenied: boolean }
    | undefined;
  /**
   * 把受控 argv 包装为带隔离的 argv。writableDirs 必须是 realpath 归一后的绝对路径。
   */
  wrap(argv: readonly string[], writableDirs: readonly string[]): string[];
}

/** darwin seatbelt profile（纯语法）：写仅限允许目录 + /dev/null，网络全拒。 */
export function darwinSeatbeltProfile(writableDirs: readonly string[]): string {
  // 路径含双引号会使 profile 语法注入；这类目录名直接拒绝构造（不是转义——宁可不跑）。
  for (const dir of writableDirs) {
    if (dir.includes('"'))
      throw new Error(`continuous isolation: writable dir contains quote: ${dir}`);
  }
  const allows = [
    '(allow file-write-data (literal "/dev/null"))',
    ...writableDirs.map((dir) => `(allow file-write* (subpath "${dir}"))`),
  ];
  return `(version 1)(allow default)(deny file-write*)${allows.join("")}(deny network*)`;
}

interface SpawnOutcome {
  exitCode: number | null;
}

function runArgvWithProfile(profile: string, argv: string[], cwd: string): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...argv], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    child.once("error", () => resolve({ exitCode: null }));
    child.once("close", (code) => resolve({ exitCode: code }));
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * darwin seatbelt 提供方：verified 只有在三条金丝雀全部符合预期时才为 true。
 * canaryRoot 由调用方给出（测试可指向临时目录）；生产装配用 os.tmpdir() 下的私有目录。
 * 网络金丝雀用真实可解析域名（example.com）：无沙箱时应能连通（exit 0），沙箱生效时
 * 连 DNS/UDP 都被拒（exit 非 0）——不使用 .invalid 这类必然解析失败的域名，否则离线
 * 环境会把「无隔离」误判成「已隔离」。
 */
export async function createDarwinSeatbeltProvider(options: {
  canaryRoot?: string;
}): Promise<ContinuousIsolationProvider> {
  const key = "darwin-seatbelt";
  const unverified = (detail: {
    insideWriteAllowed: boolean;
    outsideWriteDenied: boolean;
    networkDenied: boolean;
  }) => ({
    key,
    verified: false,
    verification: detail,
    wrap: () => [],
  });
  if (platform !== "darwin") {
    return unverified({
      insideWriteAllowed: false,
      outsideWriteDenied: false,
      networkDenied: false,
    });
  }
  const probeDir = await mkdtemp(join(options.canaryRoot ?? tmpdir(), "continuous-sbx-"));
  const allowedDir = join(probeDir, "allowed");
  const deniedFile = join(probeDir, "outside", "canary.txt");
  await mkdir(allowedDir, { recursive: true });
  await mkdir(join(probeDir, "outside"), { recursive: true });
  try {
    const allowedReal = await realpath(allowedDir);
    const profile = darwinSeatbeltProfile([allowedReal]);
    // ① 允许目录内写入必须成功（隔离没有把命令废掉）。
    const inside = join(allowedDir, "canary.txt");
    await runArgvWithProfile(
      profile,
      [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1],'x')", inside],
      allowedDir,
    );
    const insideWriteAllowed = await pathExists(inside);
    // ② 允许目录外写入必须被 OS 拒绝。
    await runArgvWithProfile(
      profile,
      [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1],'x')", deniedFile],
      allowedDir,
    );
    const outsideWriteDenied = !(await pathExists(deniedFile));
    // ③ 出网必须被拒绝：成功连接 exit 0（隔离失效），任何非 0（DNS 被拒/连接被拒）为已拒。
    const networkCanary = [
      process.execPath,
      "-e",
      "fetch('https://example.com/').then(()=>process.exit(0)).catch(()=>process.exit(3))",
    ];
    const network = await runArgvWithProfile(profile, networkCanary, allowedDir);
    // 对照组（无沙箱）：对照组都连不上（离线环境）时，金丝雀无法证明任何事——
    // 不能把「离线导致 fetch 失败」当成「沙箱拒绝了网络」，按未验证处理（fail closed）。
    const control = await new Promise<SpawnOutcome>((resolve) => {
      const child = spawn(networkCanary[0]!, networkCanary.slice(1), {
        cwd: allowedDir,
        stdio: ["ignore", "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      child.once("error", () => resolve({ exitCode: null }));
      child.once("close", (code) => resolve({ exitCode: code }));
    });
    const networkDenied = network.exitCode !== 0 && control.exitCode === 0;
    const verification = { insideWriteAllowed, outsideWriteDenied, networkDenied };
    if (!insideWriteAllowed || !outsideWriteDenied || !networkDenied) {
      return unverified(verification);
    }
    return {
      key,
      verified: true,
      verification,
      wrap: (argv, writableDirs) => [
        "/usr/bin/sandbox-exec",
        "-p",
        darwinSeatbeltProfile(writableDirs),
        ...argv,
      ],
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 测试组合专用直通提供方（test composition 注入，docs/testing §2 允许的 fixture 面）：
 * verified 恒真但 key 明示 passthrough——证据记录会如实标注「无 OS 隔离」，不冒充。
 */
export function createPassthroughIsolationProvider(): ContinuousIsolationProvider {
  return {
    key: "test-passthrough",
    verified: true,
    wrap: (argv) => [...argv],
  };
}
