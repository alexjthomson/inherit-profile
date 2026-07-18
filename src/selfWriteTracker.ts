/**
 * =============================================================================
 * inherit-profile-plus — 自写内容跟踪器
 * =============================================================================
 *
 * 用途（Purpose）:
 *   跟踪扩展自身对文件的写入内容，用于区分"自身写入"和"外部编辑"。
 *   防止文件监听器对自身写入产生反应，避免无限循环触发。
 *
 * 工作机制（How it works）:
 *   1. record(filePath, content) — 记录写入路径和内容
 *   2. isSelfWrite(filePath, content) — 检查某路径的最新内容是否匹配记录
 *   3. forget(filePath) — 清除某路径的记录
 *   使用 Map<string, string> 存储路径→内容的映射
 *
 * 依赖关系（Dependencies）:
 *   无外部依赖，纯 TypeScript 实现
 *
 * 被谁使用（Used by）:
 *   - src/profiles.ts — writeManagedFile / isManagedFileSelfWrite
 *   - src/profileWatchers.ts — 区分自身写入与外部编辑
 *
 * 导出列表（Exports）:
 *   - SelfWriteTracker (class)  自写内容跟踪器类
 *     - record(filePath, content)    记录写入
 *     - isSelfWrite(filePath, content)  判断是否为自身写入
 *     - forget(filePath)             清除记录
 */

/**
 * Tracks the content this extension itself most recently wrote to a given
 * file path.
 *
 * This is used to distinguish between file system events caused by this
 * extension's own writes (e.g. inserting the inherited settings block) and
 * genuine external edits (e.g. the user editing and saving the file), so
 * that file watchers which react to changes do not re-trigger themselves
 * and cause an infinite loop.
 */
export class SelfWriteTracker {
  private readonly lastWrittenContentByPath = new Map<string, string>();

  /**
   * Records that `content` was just written to `filePath` by this
   * extension.
   */
  record(filePath: string, content: string): void {
    this.lastWrittenContentByPath.set(filePath, content);
  }

  /**
   * @returns Returns `true` if `content` matches the last content this
   * extension recorded for `filePath` (i.e. this looks like our own write
   * rather than an external edit).
   */
  isSelfWrite(filePath: string, content: string): boolean {
    return this.lastWrittenContentByPath.get(filePath) === content;
  }

  /**
   * Forgets any recorded content for `filePath`, so the next change to it is
   * always treated as external.
   */
  forget(filePath: string): void {
    this.lastWrittenContentByPath.delete(filePath);
  }
}
