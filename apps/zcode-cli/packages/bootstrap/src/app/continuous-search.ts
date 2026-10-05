// ============================================================
// Continuous 受限递归搜索（CT-11 第 1 条）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-11 第 1 条——「受限递归搜索：逐个
// 实际目标检查 Scope、forbidden、protected 和链接目标，不能先读全目录再仅过滤文件名；
// 允许路径的上级目录只用于导航」。
//
// 实现纪律：
//   - 目录遍历是导航：允许列出 executionPath 内的任意目录以继续下行，但列目录本身
//     不授予其中任何文件的读取权；
//   - 每个实际候选目标在进入结果（以及被读内容）之前，都要过完整的
//     checkContinuousFilePath（Scope/forbidden/protected/角色/candidate）+ realpath
//     链接目标检查——与单文件读同一条判定路径，不允许「先收集全目录再按文件名过滤」；
//   - 不跟随目录符号链接下行（防逃逸换链）；文件符号链接按其目标判定，目标越界
//     或目标被拒即整体拒绝该条目（不返回、不读内容）；
//   - 有界：访问条目数与返回条目数双重上限，超限置 truncated（不静默截断语义）。
//
// 内容读取（searchText）经注入的 readTarget 回调完成——即 io-guards 的 fd 受检读
// （continuous-fd-io），本模块不另行打开文件。

import { readdir, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  FileSystemPortError,
  type FileSystemListDirectoryEntry,
  type FileSystemNodeKind,
} from "@zcode/contracts";
import type {
  ContinuousExecutionPolicyConfig,
  ContinuousFilePathCheckInput,
  ContinuousFileOperation,
} from "./continuous-execution-policy.js";
import { checkContinuousFilePath } from "./continuous-execution-policy.js";

export type ContinuousActorRoleRef = ContinuousFilePathCheckInput["role"];
type PathCheck = Parameters<typeof checkContinuousFilePath>[1];

/** 遍历的硬上限：巨树上的纵深防线（结果上限之外）。 */
const MAX_VISITED_ENTRIES = 50_000;
/** 下行深度上限（防目录自环/病态深树）。 */
const MAX_DEPTH = 64;

export interface RestrictedSearchDeps {
  config(): ContinuousExecutionPolicyConfig;
  role: ContinuousActorRoleRef;
}

/** 目标内容读取（fd 受检读的窄注入面；返回 null 表示不可读/被拒）。 */
export type TargetContentReader = (absolutePath: string) => Promise<string | null>;

/** 解析已存在路径的 realpath；不存在时折叠到最近存在父目录（与 io-guards 同语义）。 */
export async function existingRealPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent === path || parent.length === 0) return path;
    return `${await existingRealPathOf(parent)}/${path.slice(path.lastIndexOf("/") + 1)}`;
  }
}

function nodeKindOf(isDirectory: boolean, isSymbolicLink: boolean): FileSystemNodeKind {
  if (isSymbolicLink) return "symlink";
  return isDirectory ? "directory" : "file";
}

function denySearch(reason: string): never {
  throw new FileSystemPortError({
    code: "permission_denied",
    message: `continuous scope_denied: ${reason}`,
  });
}

/** 遍历根/列目录目标的共同前置：realpath 解析后必须仍在 executionPath 内。 */
async function requireInsideExecutionPath(
  config: ContinuousExecutionPolicyConfig,
  path: string,
): Promise<string> {
  const canonicalRoot = await realpath(config.executionPath).catch(() => config.executionPath);
  const resolved = await existingRealPathOf(path);
  if (!(resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}/`))) {
    denySearch("outside_execution_path");
  }
  return canonicalRoot;
}

/**
 * 单目标完整判定：词法 + realpath（链接目标必须也在允许范围内）。
 * false 的目标一律不进结果、不读内容——包括所有「Scope 外/forbidden/protected/
 * 链接目标越界」的情形（理由不区分暴露，避免探测面）。
 * canonical 化与 io-guards.checked 同款：realpath 归一 executionPath 后按同一相对位置
 * 复查（macOS /var → /private/var 等别名目录不产生两次口径）。
 */
export async function checkSearchTarget(
  deps: RestrictedSearchDeps,
  absolutePath: string,
  operation: ContinuousFileOperation,
): Promise<boolean> {
  const config = deps.config();
  const lexical = checkContinuousFilePath(config, {
    role: deps.role,
    operation,
    path: absolutePath,
  });
  if (!lexical.allowed) return false;
  const resolved = await existingRealPathOf(absolutePath);
  const style = config.pathStyle === "win32" ? win32 : posix;
  const canonicalRoot = await realpath(config.executionPath).catch(() => config.executionPath);
  const canonicalPath =
    style.isAbsolute(absolutePath) && style.isAbsolute(config.executionPath)
      ? canonicalRoot + style.sep + style.relative(config.executionPath, absolutePath)
      : absolutePath;
  const physical = checkContinuousFilePath({ ...config, executionPath: canonicalRoot }, {
    role: deps.role,
    operation,
    path: canonicalPath,
    resolvedRealPath: resolved,
  } satisfies PathCheck);
  if (!physical.allowed) return false;
  // 链接目标本身也必须在允许范围内（与 io-guards.checked 同一条纪律：不能从允许目录
  // 链接到 Scope 外/受保护文件再读出来）。
  if (resolved !== canonicalPath) {
    const target = checkContinuousFilePath({ ...config, executionPath: canonicalRoot }, {
      role: deps.role,
      operation,
      path: resolved,
    } satisfies PathCheck);
    return target.allowed;
  }
  return true;
}

/** 列目录（纯导航）：目录本身必须在 executionPath 内（realpath 含链接解析）。 */
export async function listDirectoryRestricted(
  deps: RestrictedSearchDeps,
  absoluteDir: string,
): Promise<FileSystemListDirectoryEntry[]> {
  await requireInsideExecutionPath(deps.config(), absoluteDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  return entries.map((entry) => ({
    kind: nodeKindOf(entry.isDirectory(), entry.isSymbolicLink()),
    name: entry.name,
    path: `${absoluteDir.replace(/\/$/, "")}/${entry.name}`,
  }));
}

export interface RestrictedWalkOptions {
  /** glob（相对遍历根，"/" 分隔；支持 *、?、**）。 */
  pattern?: string;
  maxResults: number;
  signal?: AbortSignal;
}

export interface RestrictedWalkEntry {
  absolutePath: string;
  kind: FileSystemNodeKind;
}

/**
 * 受限递归遍历：从根目录下行（不跟随目录符号链接），对每个匹配 glob 的实际目标执行
 * 逐目标判定，只产出通过判定的条目。导航与读取分离：目录下行不要求目录本身在
 * allowedPaths 内（否则任何深层允许路径都不可达——「上级目录只用于导航」）。
 */
export async function walkRestricted(
  deps: RestrictedSearchDeps,
  rootDir: string,
  options: RestrictedWalkOptions,
): Promise<{ entries: RestrictedWalkEntry[]; truncated: boolean }> {
  const rootInfo = await stat(rootDir).catch(() => undefined);
  if (rootInfo === undefined || !rootInfo.isDirectory()) return { entries: [], truncated: false };
  await requireInsideExecutionPath(deps.config(), rootDir);
  const matcher =
    options.pattern === undefined ? undefined : createRestrictedGlobMatcher(options.pattern);
  const out: RestrictedWalkEntry[] = [];
  let visited = 0;
  let truncated = false;
  const resolvedRoot = await realpath(rootDir);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    if (out.length >= options.maxResults) {
      truncated = true;
      break;
    }
    if (options.signal?.aborted) throw new Error("aborted");
    const { dir, depth } = queue.shift()!;
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of dirents) {
      visited += 1;
      if (visited > MAX_VISITED_ENTRIES) return { entries: out, truncated: true };
      if (options.signal?.aborted) throw new Error("aborted");
      const absolute = `${dir.replace(/\/$/, "")}/${entry.name}`;
      const relative = absolute.slice(resolvedRoot.length + 1);
      if (entry.isDirectory()) {
        // 目录符号链接不跟随（导航层防逃逸；链接目录下的内容不经本遍历暴露）。
        if (entry.isSymbolicLink()) continue;
        if (depth < MAX_DEPTH) queue.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (matcher !== undefined && !matcher.test(relative, entry.name)) continue;
      // 逐目标完整判定：通过才产出（产出后才可能被读内容）。
      if (await checkSearchTarget(deps, absolute, "read")) {
        out.push({ absolutePath: absolute, kind: nodeKindOf(false, entry.isSymbolicLink()) });
        if (out.length >= options.maxResults) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { entries: out, truncated };
}

export interface RestrictedTextSearchResult {
  files: string[];
  entries: Array<{ path: string; lineNumber?: number; text?: string; count?: number }>;
  numMatches: number;
  truncated: boolean;
}

/**
 * 受限文本搜索：与文件遍历同一条逐目标判定；内容经注入的受检读取（readTarget）取得，
 * 本模块不经任何其它路径读文件。outputMode 支持 content / files_with_matches / count。
 */
export async function searchTextRestricted(
  deps: RestrictedSearchDeps,
  input: {
    path: string;
    pattern: string;
    glob?: string;
    ignoreCase?: boolean;
    headLimit?: number;
    outputMode?: "content" | "files_with_matches" | "count";
  },
  readTarget: TargetContentReader,
): Promise<RestrictedTextSearchResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.ignoreCase === true ? "i" : "");
  } catch {
    throw new FileSystemPortError({
      code: "invalid_pattern",
      message: `continuous search: invalid pattern ${input.pattern}`,
    });
  }
  const globMatcher =
    input.glob === undefined ? undefined : createRestrictedGlobMatcher(input.glob);
  const headLimit = input.headLimit ?? 200;
  const mode = input.outputMode ?? "content";
  const info = await stat(input.path).catch(() => undefined);
  if (info === undefined) {
    throw new FileSystemPortError({
      code: "not_found",
      path: input.path,
      message: `No such path: ${input.path}`,
    });
  }
  const targets: string[] = info.isDirectory()
    ? (await walkRestricted(deps, input.path, { maxResults: 5_000 })).entries.map(
        (entry) => entry.absolutePath,
      )
    : [input.path];
  const entries: RestrictedTextSearchResult["entries"] = [];
  const files: string[] = [];
  let numMatches = 0;
  let truncated = false;
  for (const target of targets) {
    if (globMatcher !== undefined) {
      const base = target.slice(target.lastIndexOf("/") + 1);
      if (!globMatcher.test(base, base)) continue;
    }
    if (!info.isDirectory() && !(await checkSearchTarget(deps, target, "read"))) continue;
    const content = await readTarget(target);
    if (content === null) continue;
    const lines = content.split("\n");
    let fileCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index]!)) continue;
      fileCount += 1;
      numMatches += 1;
      if (mode === "content" && entries.length < headLimit) {
        entries.push({ path: target, lineNumber: index + 1, text: lines[index] });
      }
      if (numMatches > headLimit) {
        truncated = true;
        break;
      }
    }
    if (fileCount > 0) files.push(target);
    if (mode === "files_with_matches" && files.length >= headLimit) truncated = true;
    if (mode === "count" && entries.length < headLimit) {
      entries.push({ path: target, count: fileCount });
    }
    if (truncated) break;
  }
  return { files, entries, numMatches, truncated };
}

/** 极简 glob → RegExp（支持 *、?、**；转义其余字符）。覆盖 files.glob 的常用子集。 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment === "**") return "(?:.*)";
      const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      return escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    })
    .join("/");
  return new RegExp(`^${source}$`);
}

/**
 * 与 adapters/fs 私有 createGlobMatcher 同语义：不含 "/" 的模式按文件名匹配
 * （`*.tsx` 命中任意深度），含 "/" 的按遍历根相对路径匹配。
 */
export function createRestrictedGlobMatcher(pattern: string): {
  test: (relativePath: string, fileName: string) => boolean;
} {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const regex = globToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : regex;
  return {
    test: (relativePath, fileName) =>
      regex.test(relativePath) || (basenameRegex !== undefined && basenameRegex.test(fileName)),
  };
}
