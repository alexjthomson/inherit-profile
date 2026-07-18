/**
 * =============================================================================
 * inherit-profile-plus — 禁用扩展读取
 * =============================================================================
 *
 * 用途（Purpose）:
 *   VS Code 将每个 Profile 的扩展禁用状态存储在 SQLite 数据库
 *   state.vscdb 中，而非 extensions.json。本模块负责从该数据库
 *   读取已禁用的扩展 ID 列表。
 *
 * 工作机制（How it works）:
 *   使用 sql.js (纯 JS WASM SQLite) 读取 profile 目录下
 *   globalStorage/state.vscdb 中 key 为
 *   'extensionsIdentifiers/disabled' 的 JSON 值。
 *   纯 JS 实现，无需 native 模块编译。
 *
 * 函数列表（Functions）:
 *   - getDisabledExtensions(profileDir)     [export] 读取禁用扩展 ID 列表
 */

import * as path from "path";
import * as fs from "fs";

const DISABLED_KEY = "extensionsIdentifiers/disabled";

// 延迟初始化 sql.js，避免模块加载时执行
let sqlJsInit: Promise<any> | null = null;

function getSqlJs() {
  if (!sqlJsInit) {
    sqlJsInit = import("sql.js").then((mod) =>
      mod.default({
        locateFile: (file: string) =>
          path.join(__dirname, "..", "node_modules", "sql.js", "dist", file),
      }),
    );
  }
  return sqlJsInit;
}

function parseDisabledIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => item?.id).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 读取指定 Profile 目录中已被禁用的扩展 ID 列表。
 * @param profileDir Profile 的绝对路径 (如 .../profiles/10a9f58d)
 * @returns 被禁用的扩展 ID 数组 (如 ["vizards.deepseek-v4-for-copilot"])
 */
export async function getDisabledExtensions(
  profileDir: string,
): Promise<string[]> {
  const dbPath = path.join(profileDir, "globalStorage", "state.vscdb");
  try {
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    try {
      const stmt = db.prepare(
        "SELECT value FROM ItemTable WHERE key = ?",
      );
      stmt.bind([DISABLED_KEY]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as { value: string };
        return parseDisabledIds(row.value);
      }
      return [];
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(
      `Failed to read disabled extensions from \`${dbPath}\`:`,
      err,
    );
    return [];
  }
}
