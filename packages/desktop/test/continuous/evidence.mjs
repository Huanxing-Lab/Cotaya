// CT-09 证据汇总（docs/testing/continuous.md §2「每次执行的隔离和证据」）。
//
// 证据至少包括：源码 commit、Node/Electron 版本、OS、模型类型、case ID、start/end、exit code、
// traceId/programId/cycleId/runId/sessionId、截图、关键服务事实（SQL facts）和实际 diff。
// 全部落盘内容先脱敏：凭据（Authorization/bearer/api key/token）、用户 home 路径 → ~、
// 内部服务地址只保留 host。截图与 trace 由 playwright 写入后只记录相对路径。

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SECRET_PATTERNS = [
  /\b(Authorization\s*:\s*)(Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[-_]?key\s*[:=]\s*)["']?[A-Za-z0-9._-]{8,}["']?/gi,
  /\b(access[-_]?token\s*[:=]\s*)["']?[A-Za-z0-9._-]{8,}["']?/gi,
  /\b(sk-[A-Za-z0-9]{8,})\b/g,
];

/** 脱敏：凭据值打码；真实用户 home 路径折叠为 ~（不记录个人路径，§2）。 */
export function sanitizeText(input) {
  let text = String(input);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => `${prefix}<redacted>`);
  }
  text = text.replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "<redacted-key>");
  const home = os.homedir();
  if (home && home !== "/") text = text.split(home).join("~");
  return text;
}

export async function writeSanitized(run, relativePath, content) {
  // 校验用解析路径，写盘用原始 join 路径：assertInsideRoot 返回的是「最近存在祖先」的
  // realpath，目标文件尚未创建时它会是父目录——绝不能当写盘目标（否则 EISDIR）。
  const target = path.join(run.dirs.artifacts, relativePath);
  run.assertInsideRoot(target, relativePath);
  await mkdirSync(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    sanitizeText(typeof content === "string" ? content : JSON.stringify(content, null, 2)),
    "utf8",
  );
  return target;
}

export function appendSanitizedNdjson(run, relativePath, record) {
  const target = path.join(run.dirs.artifacts, relativePath);
  run.assertInsideRoot(target, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `${sanitizeText(JSON.stringify(record))}\n`, "utf8");
  return target;
}

/** 每个用例的证据目录（screenshots/trace/commands/protocol/db-facts/usage/git/diff）。 */
export function createCaseEvidence(run, caseId) {
  const caseDir = path.join(run.dirs.cases, caseId);
  mkdirSync(path.join(caseDir, "screenshots"), { recursive: true });
  run.assertInsideRoot(caseDir, `case:${caseId}`);
  const evidence = [];
  return {
    caseDir,
    list: () => evidence,
    async screenshot(window, name) {
      const file = path.join(caseDir, "screenshots", `${name}.png`);
      await window.screenshot({ path: file });
      evidence.push({ kind: "screenshot", path: file });
      return file;
    },
    async tracingStart(context) {
      await context.tracing().start({ screenshots: true, snapshots: true });
    },
    async tracingStop(context) {
      const file = path.join(caseDir, "trace.zip");
      await context.tracing().stop({ path: file });
      evidence.push({ kind: "trace", path: file });
      return file;
    },
    async record(name, data) {
      const file = await writeSanitized(run, path.join("cases", caseId, name), data);
      evidence.push({ kind: name, path: file });
      return file;
    },
    async recordRaw(name, content) {
      const file = path.join(caseDir, name);
      run.assertInsideRoot(file, `case:${caseId}:${name}`);
      writeFileSync(file, content, "utf8");
      evidence.push({ kind: name, path: file });
      return file;
    },
    reference(kind, detail) {
      evidence.push({ kind, ...detail });
    },
  };
}

/**
 * 只读 SQL facts：打开 tasks-index（只读模式）执行白名单查询，把服务层业务事实
 * （program/cycle/queue/usage/event 计数与关键行）取回作为证据。
 * 不用 SQL 写任何状态——E2E 的成功状态必须由用户动作产生（测试文档 §8）。
 */
export async function collectSqliteFacts(dbPath, queries) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const facts = { dbPath, tables: [], rows: {} };
    facts.tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'continuous_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    for (const [name, sql] of Object.entries(queries)) {
      facts.rows[name] = database.prepare(sql).all();
    }
    return facts;
  } finally {
    database.close();
  }
}

/** git 事实（before/after 快照已由 fixtures 提供）；这里补充 diff 文本与 hash 摘要。 */
export async function diffSummary(diffText) {
  const files = new Map();
  for (const line of diffText.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) {
      const file = match[2];
      const entry = files.get(file) ?? { added: 0, removed: 0 };
      files.set(file, entry);
    }
  }
  let current = null;
  for (const line of diffText.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) current = fileMatch[1];
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      const entry = files.get(current);
      if (entry) entry.added += 1;
    }
    if (current && line.startsWith("-") && !line.startsWith("---")) {
      const entry = files.get(current);
      if (entry) entry.removed += 1;
    }
  }
  return {
    sha256: createHash("sha256").update(diffText).digest("hex"),
    files: [...files.entries()].map(([file, counts]) => ({ file, ...counts })),
  };
}

export async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
