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
