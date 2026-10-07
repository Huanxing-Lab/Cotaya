// Continuous 第一版受保护路径判定（CT-02，规格 §7）：
// 禁止自主修改 binary、lockfile、依赖定义和测试基础设施；禁止删除/弱化测试以制造通过。
// 纯字符串规则，无 IO；路径为 executionPath 内的 repo 相对路径（"/" 分隔）。

/** lockfile：内容锁定依赖图，自主改动无法通过验证且必然冲突。 */
const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "gemfile.lock",
  "pipfile.lock",
  "go.sum",
  "flake.lock",
  "deno.lock",
]);

/** 依赖定义：第一版不自主增删依赖（规格 §7）。 */
const DEPENDENCY_MANIFEST_BASENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "cargo.toml",
  "composer.json",
  "gemfile",
  "deno.json",
  "deno.jsonc",
  "mix.exs",
]);

/** 测试基础设施：测试入口、fixture 与 runner 配置不允许被自主修改或删除。 */
const TEST_INFRASTRUCTURE_SEGMENTS = new Set([
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "test",
  "tests",
  "e2e",
]);

const TEST_FILE_NAME_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /-test\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /_test\.rs$/,
  /\.test\.mjs$/,
];

const TEST_RUNNER_CONFIG_PATTERNS = [
  /^(jest|vitest|karma|mocha|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /^(jest|vitest|karma|mocha|playwright|cypress)\.setup\.[cm]?[jt]s$/,
];

/** binary/媒体/字体/归档/可执行：第一版禁止自主修改 binary（规格 §7）。 */
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "icns",
  "tiff",
  "avif",
  "mov",
  "mp4",
  "webm",
  "mp3",
  "wav",
  "aac",
  "flac",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "exe",
  "dll",
  "dylib",
  "so",
  "bin",
  "dat",
  "pdf",
  "jar",
  "class",
  "wasm",
  "node",
]);

export type ContinuousProtectedPathReason =
  | "lockfile"
  | "dependency_manifest"
  | "test_infrastructure"
  | "binary";

/** 判定 repo 相对路径是否落入第一版受保护集合；返回原因或 null（未受保护）。 */
export function continuousProtectedPathReason(
  repoRelativePath: string,
): ContinuousProtectedPathReason | null {
  const normalized = repoRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) {
    return null;
  }
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1]!.toLowerCase();

  if (LOCKFILE_BASENAMES.has(basename)) {
    return "lockfile";
  }
  if (DEPENDENCY_MANIFEST_BASENAMES.has(basename)) {
    return "dependency_manifest";
  }

  const hasTestSegment = segments.some((segment) =>
    TEST_INFRASTRUCTURE_SEGMENTS.has(segment.toLowerCase()),
  );
  const matchesTestName = TEST_FILE_NAME_PATTERNS.some((pattern) => pattern.test(basename));
  const matchesRunnerConfig = TEST_RUNNER_CONFIG_PATTERNS.some((pattern) => pattern.test(basename));
  if (hasTestSegment || matchesTestName || matchesRunnerConfig) {
    return "test_infrastructure";
  }

  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".") + 1) : "";
  if (BINARY_EXTENSIONS.has(extension)) {
    return "binary";
  }
  return null;
}
