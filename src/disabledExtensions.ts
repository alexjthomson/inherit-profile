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
 *   尝试使用 better-sqlite3 (同步) 读取 profile 目录下
 *   globalStorage/state.vscdb 中 key 为
 *   'extensionsIdentifiers/disabled' 的 JSON 值。
 *   如果 better-sqlite3 不可用（如 Native 模块与 Electron ABI 不兼容），
 *   自动降级为 child_process.fork 方式读取。
 *
 * 函数列表（Functions）:
 *   - getDisabledExtensions(profileDir)     [export] 读取禁用扩展 ID 列表
 */

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

const DISABLED_KEY = "extensionsIdentifiers/disabled";

// 尝试加载 better-sqlite3, 如果失败则记录警告
let Database: any = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require("better-sqlite3");
} catch {
  console.warn(
    "better-sqlite3 native module not available. " +
    "Falling back to child process for disabled extension detection.",
  );
}

/**
 * 读取指定 Profile 目录中已被禁用的扩展 ID 列表。
 * @param profileDir Profile 的绝对路径 (如 .../profiles/10a9f58d)
 * @returns 被禁用的扩展 ID 数组 (如 ["vizards.deepseek-v4-for-copilot"])
 */
export function getDisabledExtensions(profileDir: string): string[] {
  const dbPath = path.join(profileDir, "globalStorage", "state.vscdb");
  try {
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    if (Database) {
      // 方式 1: 直接使用 better-sqlite3
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get(DISABLED_KEY) as { value: string } | undefined;
        if (!row?.value) return [];
        return parseDisabledIds(row.value);
      } finally {
        db.close();
      }
    }

    // 方式 2: 降级为 child_process.execSync (用系统 Node.js)
    return readDisabledViaChildProcess(dbPath);
  } catch (err) {
    console.warn(
      `Failed to read disabled extensions from \`${dbPath}\`:`,
      err,
    );
    return [];
  }
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
 * 降级方案: 通过 child_process 启动独立的 Node.js 进程读取 SQLite。
 * 使用 system Node.js (其中 better-sqlite3 可以正常工作) 避免 Electron ABI 问题。
 */
function readDisabledViaChildProcess(dbPath: string): string[] {
  const script = `
    const Database = require(${JSON.stringify(
      path.join(__dirname, "..", "node_modules", "better-sqlite3"),
    )});
    const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(${JSON.stringify(DISABLED_KEY)});
      console.log(JSON.stringify(row?.value || '[]'));
    } finally {
      db.close();
    }
  `;
  try {
    const result = execSync(
      `"C:\\Program Files\\nodejs\\node.exe" -e ${JSON.stringify(script)}`,
      { encoding: "utf-8", timeout: 5000 },
    );
    return parseDisabledIds(result.trim());
  } catch (err) {
    console.warn("Child process fallback for disabled extensions failed:", err);
    return [];
  }
}
