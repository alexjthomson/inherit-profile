import * as path from "path";

/**
 * =============================================================================
 * inherit-profile-plus — JSONC 操作工具函数
 * =============================================================================
 *
 * 用途（Purpose）:
 *   纯工具/辅助函数模块。提供 JSONC（JSON with Comments）文件的各种操作函数，
 *   专为 VS Code settings.json 格式设计。不直接操作 Profile 或继承逻辑，
 *   只处理字符串和对象的转换。
 *
 * 工作机制（How it works）:
 *   所有函数都是纯函数（无副作用）或纯工具函数。主要功能：
 *
 *   1. 设置对象操作：
 *      - flattenSettings() — 将嵌套 settings 拍平
 *      - mergeFlattenedSettings() — 合并两个拍平后的设置对象
 *      - subtractSettings() — 返回 base 中不在 toRemove 里的项
 *      - sortSettings() — 按 key 字母序排序
 *      - stripManagedProfileSettings() — 从对象中移除内部标记 key
 *
 *   2. 标记常量：
 *      - INHERITED_SETTINGS_START_MARKER / END_MARKER — inherited 块起止标记
 *      - INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY — 内部门牌设置 key
 *      - INHERITED_PROFILE_META_KEY — 扩展继承元数据 key
 *      - NON_FLATTENABLE_SETTINGS — 不可拍平的设置 Key 集合
 *      - WARNING_COMMENT / WARNING_EXPLAIN — 继承块警告注释
 *
 *   3. 扩展操作：
 *      - isInheritedExtension() / isOptedOutExtension() — 检查扩展标记
 *      - markExtensionAsInherited() / markExtensionAsOptedOut() — 设置扩展标记
 *      - convertOldMarkers() — 旧标记格式转换（inheritedFromProfile → inheritProfile.inherited）
 *      - stripInheritedExtensions() — 移除继承的扩展
 *      - mergeInheritedExtensions() — 全量对账合并父级扩展
 *
 *   4. 字符串/文件操作：
 *      - buildInheritedSettingsBlock() — 构建 inherited 设置块
 *      - splitRawSettingsByClosingBrace() — 按最后一个 } 切开 JSON
 *      - insertBeforeClose() — 在关闭括号前插入内容
 *      - removeTrailingComma() — 移除末尾多余逗号（支持注释和字符串）
 *      - removeInsertionBoundarySetting() — 移除内部门牌设置行
 *      - findTabValue() — 检测 JSONC 文件的缩进风格
 *      - resolveParentSettingsPaths() — 解析父级 settings.json 路径
 *      - resolveParentExtensionsPaths() — 解析父级 extensions.json 路径
 *
 * 依赖关系（Dependencies）:
 *   - path — 路径拼接
 *   无其他外部依赖，纯 TypeScript 实现
 *
 * 被谁使用（Used by）:
 *   - src/profiles.ts — 所有继承逻辑均依赖此模块
 *   - src/profileWatchers.ts — 使用路径解析函数
 *
 * 导出列表（Exports）:
 *   --- 常量 ---
 *   - INHERITED_SETTINGS_START_MARKER                 inherited 块起始标记
 *   - INHERITED_SETTINGS_END_MARKER                   inherited 块结束标记
 *   - INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY       内部门牌设置 key
 *   - INHERITED_SETTINGS_INSERTION_BOUNDARY_VALUE     内部门牌设置 value
 *   - INHERITED_PROFILE_META_KEY                      扩展元数据 key
 *   - WARNING_COMMENT                                 继承块警告注释
 *   - WARNING_EXPLAIN                                 继承块说明注释
 *   - NON_FLATTENABLE_SETTINGS                        不可拍平的设置 Key 集合
 *
 *   --- 类型 ---
 *   - ExtensionEntry (interface)                      扩展条目接口
 *   - InheritedProfileMeta (interface)                继承元数据接口
 *
 *   --- 设置对象操作 ---
 *   - flattenSettings(settings, parentKey?, result?)  嵌套设置拍平
 *   - mergeFlattenedSettings(target, source)           合并两个拍平设置（source 优先）
 *   - subtractSettings(base, toRemove)                返回 base 中不在 toRemove 的项
 *   - sortSettings(settings)                          按 key 字母序排序
 *   - stripManagedProfileSettings(settings)           移除内部标记 key
 *
 *   --- 扩展操作 ---
 *   - getInheritedProfileMeta(ext)                    读取扩展的继承元数据
 *   - isInheritedExtension(ext)                       检查是否为继承的扩展
 *   - isOptedOutExtension(ext)                        检查是否为跳过继承的扩展
 *   - markExtensionAsInherited(ext)                   标记扩展为继承而来
 *   - markExtensionAsOptedOut(extId, originalExt?)    创建跳过继承的扩展条目
 *   - convertOldMarkers(ext)                          转换旧标记格式
 *   - stripInheritedExtensions(extensions)            移除所有继承的扩展
 *   - mergeInheritedExtensions(current, parents, originallyOwn)
 *                                                     全量对账合并父级扩展
 *
 *   --- 路径解析 ---
 *   - resolveParentSettingsPaths(names, profiles)     解析父级 settings.json 路径
 *   - resolveParentExtensionsPaths(names, profiles)   解析父级 extensions.json 路径
 *
 *   --- JSONC 字符串操作 ---
 *   - removeInsertionBoundarySetting(after)           移除内部门牌行
 *   - removeTrailingComma(text)                       移除末尾多余逗号
 *   - splitRawSettingsByClosingBrace(raw)             按最后一个 } 切分为两部分
 *   - findTabValue(raw)                               检测缩进风格（空格/制表符）
 *   - buildInheritedSettingsBlock(flattened, tab)     构建完整的 inherited 设置块
 *   - insertBeforeClose(beforeClose, block)           在关闭括号前插入内容
 *   - getLastMeaningfulCharacterIndex(text)           获取最后一个有意义的字符索引
 */

export const INHERITED_SETTINGS_START_MARKER =
  "// --- INHERITED SETTINGS MARKER START --- //";
export const INHERITED_SETTINGS_END_MARKER =
  "// --- INHERITED SETTINGS MARKER END --- //";
export const INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY =
  "inheritProfile._insertionBoundary";
export const INHERITED_SETTINGS_INSERTION_BOUNDARY_VALUE = false;

/**
 * Key used inside extension entry metadata to store inheritance state.
 * @see InheritedProfileMeta
 */
export const INHERITED_PROFILE_META_KEY = "inheritProfile";

export const WARNING_COMMENT =
  "// WARNING: Do not remove the inherited settings start and end markers.";
export const WARNING_EXPLAIN =
  "//          The markers are used to identify inserted inherited settings.";

/**
 * Well-known VS Code settings whose value is a JSON object that must be
 * treated as a single, opaque leaf value rather than a nested settings
 * namespace.
 *
 * The keys inside these objects are user/data defined (glob patterns,
 * language identifiers, color identifiers, environment variable names, etc.)
 * rather than nested setting names. Flattening into them would rewrite keys
 * such as `"README.md"` inside `files.exclude` into `files.exclude.README.md`,
 * which VS Code does not recognise as part of the original setting.
 *
 * @see https://github.com/alexjthomson/inherit-profile/issues/5
 */
export const NON_FLATTENABLE_SETTINGS: ReadonlySet<string> = new Set([
  "files.exclude",
  "files.watcherExclude",
  "files.readonlyInclude",
  "files.readonlyExclude",
  "files.associations",
  "search.exclude",
  "workbench.editorAssociations",
  "workbench.colorCustomizations",
  "editor.tokenColorCustomizations",
  "editor.semanticTokenColorCustomizations",
  "emmet.includeLanguages",
  "emmet.syntaxProfiles",
  "emmet.variables",
  "explorer.fileNesting.patterns",
  "terminal.integrated.env.linux",
  "terminal.integrated.env.osx",
  "terminal.integrated.env.windows",
  "terminal.integrated.profiles.linux",
  "terminal.integrated.profiles.osx",
  "terminal.integrated.profiles.windows",
  "workbench.editor.customLabels.patterns",
]);

/**
 * Recursively flattens settings into a single record that maps the setting key
 * to its value.
 *
 * Keys that match a known {@link NON_FLATTENABLE_SETTINGS} entry are kept as a
 * single leaf entry, even though their value is an object, since those
 * objects hold data (e.g. glob patterns) rather than nested settings.
 * @param settings Settings to flatten.
 * @param parentKey Parent key from previous iteration.
 * @param result Flattened result to return.
 * @returns Returns the flattened result.
 */
export function flattenSettings(
  settings: Record<string, any>,
  parentKey = "",
  result: Record<string, any> = {},
): Record<string, any> {
  for (const [key, value] of Object.entries(settings)) {
    const newKey = parentKey ? `${parentKey}.${key}` : key;
    const isFlattenableObject =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !NON_FLATTENABLE_SETTINGS.has(newKey);
    if (isFlattenableObject) {
      flattenSettings(value, newKey, result);
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

/**
 * Merges two flattened settings objects into one.
 * Keys from `source` override keys from `target`.
 *
 * Example:
 * target = { "editor.fontSize": "14", "files.autoSave": "off" }
 * source = { "editor.fontSize": "16" }
 * result = { "editor.fontSize": "16", "files.autoSave": "off" }
 */
export function mergeFlattenedSettings(
  target: Record<string, any>,
  source: Record<string, any>,
): Record<string, any> {
  return { ...target, ...source };
}

/**
 * Subtracts one set of settings from another.
 * @param base Base settings.
 * @param toRemove Settings to remove from the base.
 * @returns Returns `base` without keys that already exist in `toRemove`.
 */
export function subtractSettings(
  base: Record<string, any>,
  toRemove: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!(key in toRemove)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Sorts a given set of `settings` alphabetically (A to Z).
 * @param settings Settings to sort alphabetically.
 * @returns Returns the `settings`, but sorted alphabetically (A to Z).
 */
export function sortSettings(settings: Record<string, any>): Record<string, any> {
  return Object.keys(settings)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, any>>((acc, key) => {
      acc[key] = settings[key];
      return acc;
    }, {});
}

export function stripManagedProfileSettings<T>(
  settings: Record<string, T>,
): Record<string, T> {
  // 过滤所有 inheritProfile.* 私有键, 防止泄漏到子级 profile
  // 包括: _insertionBoundary, _originallyOwnExtensions, optedOutExtensions 等
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith("inheritProfile."))
  );
}

/**
 * Resolves the absolute path to each named parent profile's `settings.json`
 * file, preserving order and silently skipping any name that isn't present
 * in `profiles` (e.g. a configured parent profile that has been renamed or
 * deleted).
 * @param parentProfileNames Names of the parent profiles to resolve, as
 * configured via `inheritProfile.parents`.
 * @param profiles Mapping from profile name to its absolute directory.
 * @returns Absolute paths to each resolved parent profile's `settings.json`.
 */
export function resolveParentSettingsPaths(
  parentProfileNames: readonly string[],
  profiles: Readonly<Record<string, string>>,
): string[] {
  const settingsPaths: string[] = [];
  for (const parentProfileName of parentProfileNames) {
    const parentProfileDirectory = profiles[parentProfileName];
    if (parentProfileDirectory) {
      settingsPaths.push(path.join(parentProfileDirectory, "settings.json"));
    }
  }
  return settingsPaths;
}

/**
 * Shape of an entry inside a profile's `extensions.json` file that this
 * extension cares about. Extra fields are preserved but ignored.
 */
export interface ExtensionEntry {
  identifier?: { id?: string };
  metadata?: Record<string, any>;
  [key: string]: any;
}

/**
 * Metadata stored inside an extension entry's `metadata.inheritProfile` field.
 */
export interface InheritedProfileMeta {
  inherited?: boolean;   // true = 从父级继承来的
  optedOut?: boolean;    // true = 用户主动跳过此扩展的继承
}

// ---------------------------------------------------------------------------
// 辅助函数 — 基于 INHERITED_PROFILE_META_KEY 的标记读写
// ---------------------------------------------------------------------------

/**
 * Reads the inheritProfile metadata from an extension entry.
 */
export function getInheritedProfileMeta(ext: ExtensionEntry): InheritedProfileMeta | undefined {
  return ext?.metadata?.[INHERITED_PROFILE_META_KEY];
}

/**
 * Returns true if the extension is marked as inherited from a parent profile.
 */
export function isInheritedExtension(ext: ExtensionEntry): boolean {
  return getInheritedProfileMeta(ext)?.inherited === true;
}

/**
 * Returns true if the user has opted out of inheriting this extension.
 */
export function isOptedOutExtension(ext: ExtensionEntry): boolean {
  return getInheritedProfileMeta(ext)?.optedOut === true;
}

/**
 * Tags an extension entry as inherited from a parent profile.
 * Preserves existing metadata; only sets inheritProfile.inherited = true.
 */
export function markExtensionAsInherited<T extends ExtensionEntry>(ext: T): T {
  return {
    ...ext,
    metadata: {
      ...(ext.metadata ?? {}),
      [INHERITED_PROFILE_META_KEY]: { inherited: true },
    },
  };
}

/**
 * Creates a minimal extension entry representing an opted-out extension.
 * Preserves the original identifier if available (VS Code prefers full
 * identifier with id + uuid for reliable recognition).
 *
 * @param extId The extension ID to opt out of.
 * @param originalExt Optional original extension entry to preserve full
 *                    identifier and other fields from.
 */
export function markExtensionAsOptedOut(
  extId: string,
  originalExt?: ExtensionEntry,
): ExtensionEntry {
  const identifier = originalExt?.identifier ?? { id: extId };
  // Preserve non-metadata fields (version, location, etc.) if available
  const { metadata, ...rest } = originalExt ?? {};
  return {
    ...rest,
    identifier,
    metadata: {
      [INHERITED_PROFILE_META_KEY]: { optedOut: true },
    },
  };
}

/**
 * Converts the old `metadata.inheritedFromProfile` marker to the new
 * `metadata.inheritProfile.inherited` format.
 * If the entry already uses the new format, it is returned unchanged.
 */
export function convertOldMarkers<T extends ExtensionEntry>(ext: T): T {
  if (ext?.metadata?.inheritedFromProfile) {
    const { inheritedFromProfile, ...restMetadata } = ext.metadata;
    const newMetadata = {
      ...restMetadata,
      [INHERITED_PROFILE_META_KEY]: { inherited: true },
    };
    // 转换后如果 metadata 为空, 设为 undefined 避免写入空对象
    if (Object.keys(newMetadata).length === 0) {
      const { metadata, ...rest } = ext;
      return { ...rest } as T;
    }
    return {
      ...ext,
      metadata: newMetadata,
    };
  }
  return ext;
}

/**
 * Resolves the absolute path to each named parent profile's `extensions.json`
 * file, preserving order and silently skipping any name that isn't present
 * in `profiles`.
 */
export function resolveParentExtensionsPaths(
  parentProfileNames: readonly string[],
  profiles: Readonly<Record<string, string>>,
): string[] {
  const extPaths: string[] = [];
  for (const name of parentProfileNames) {
    const dir = profiles[name];
    if (dir) {
      extPaths.push(path.join(dir, "extensions.json"));
    }
  }
  return extPaths;
}

/**
 * Removes any extensions that were previously marked as inherited (i.e.
 * extensions with `metadata.inheritProfile.inherited === true`).
 *
 * Extensions that the user has opted out of inheriting
 * (`metadata.inheritProfile.optedOut === true`) are kept.
 *
 * @param extensions Extensions to filter.
 * @returns Returns `extensions` without any inherited entries.
 */
export function stripInheritedExtensions<T extends ExtensionEntry>(
  extensions: readonly T[],
): T[] {
  return extensions.filter(
    (ext) => !isInheritedExtension(ext) // 只清理 inherited, optedOut 保留
  );
}

/**
 * Full-reconciliation merge of parent extensions into the current profile.
 *
 * Instead of incrementally adding missing extensions, this function performs
 * a complete three-way reconciliation:
 *
 * 1. Classifies all current extensions into own / inherited / optedOut
 * 2. Discards all inherited entries (they will be recomputed)
 * 3. Walks parent profiles in order, applying the full reconciliation rules
 * 4. Handles revert-to-own (when a parent no longer provides an extension
 *    that was originally owned) and auto-opt-out (when a user deleted an
 *    inherited extension that the parent still provides)
 *
 * @param currentExtensions All extensions currently declared by the current profile.
 * @param parentProfiles Ordered list of parent profile names paired with their extensions.
 * @param originallyOwnExtensions Optional list of extension IDs that were originally
 *   owned by this profile (before being "taken over" by a parent).
 * @returns The merged result plus the updated originallyOwn list and a
 *   parentNameMap for backup purposes.
 */
export function mergeInheritedExtensions<T extends ExtensionEntry>(
  currentExtensions: readonly T[],
  parentProfiles: readonly { profileName: string; extensions: readonly T[] }[],
  originallyOwnExtensions?: readonly string[],
): { merged: T[]; originallyOwnExtensions: string[]; parentNameMap: Record<string, string> } {
  const originallyOwn = new Set(originallyOwnExtensions ?? []);

  // 1. 先将旧标记转换为新格式
  const converted = currentExtensions.map(convertOldMarkers);

  // 2. 分类: own / inherited / optedOut
  const ownMap: Record<string, T> = {};
  const optedOutMap: Record<string, boolean> = {};
  const inheritedFromPrev: Record<string, T> = {};

  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (!id) continue;
    if (isOptedOutExtension(ext)) {
      optedOutMap[id] = true;
    } else if (isInheritedExtension(ext)) {
      inheritedFromPrev[id] = ext;
    } else {
      ownMap[id] = ext;
    }
  }

  // 3. 从父级重新计算 inherited
  const inheritedMap: Record<string, T> = {};
  const visitedFromParent = new Set<string>();

  for (const { extensions } of parentProfiles) {
    for (const parentExt of extensions) {
      const id = parentExt?.identifier?.id;
      if (!id || visitedFromParent.has(id)) continue;
      visitedFromParent.add(id);

      if (optedOutMap[id]) continue;

      if (ownMap[id]) {
        // own → inherited, 记入 originallyOwn
        inheritedMap[id] = markExtensionAsInherited(ownMap[id]);
        delete ownMap[id];
        if (!originallyOwn.has(id)) {
          originallyOwn.add(id);
        }
      } else if (!inheritedMap[id]) {
        inheritedMap[id] = markExtensionAsInherited(
          parentExt as unknown as T
        );
      }
    }
  }

  // 4. 清理: 原本 inherited 但父级不再提供
  const newOptedOut: string[] = [];
  for (const [id, ext] of Object.entries(inheritedFromPrev)) {
    if (inheritedMap[id]) continue; // 父级仍有, 保留

    if (visitedFromParent.has(id)) {
      // 父级仍有但被用户删除 → 自动 opt-out
      newOptedOut.push(id);
    } else if (originallyOwn.has(id)) {
      // 父级不再提供, 但原本是 own → 退还为 own
      const { metadata, ...rest } = ext;
      const { [INHERITED_PROFILE_META_KEY]: _, ...restMeta } = metadata ?? {};
      ownMap[id] = { ...rest, metadata: Object.keys(restMeta).length > 0 ? restMeta : undefined } as T;
      originallyOwn.delete(id);
    }
    // 父级不再提供, 也不是 originallyOwn → 丢弃
  }

  // 5. 组装结果
  const optedOutEntries = [
    ...Object.keys(optedOutMap).map((id) =>
      markExtensionAsOptedOut(id, inheritedFromPrev[id]) as unknown as T
    ),
    ...newOptedOut.map((id) =>
      markExtensionAsOptedOut(id, inheritedFromPrev[id]) as unknown as T
    ),
  ];

  const result: T[] = [
    ...Object.values(ownMap),
    ...optedOutEntries,
    ...Object.values(inheritedMap),
  ];

  // 6. 构建 extId → parentName 映射（用于跨设备恢复备份）
  const parentNameMap: Record<string, string> = {};
  for (const { profileName, extensions } of parentProfiles) {
    for (const ext of extensions) {
      const id = ext?.identifier?.id;
      if (id && inheritedMap[id] && !parentNameMap[id]) {
        parentNameMap[id] = profileName;
      }
    }
  }

  return {
    merged: result,
    originallyOwnExtensions: [...originallyOwn].filter(
      (id) => inheritedMap[id] || ownMap[id]
    ), // 清理悬空引用
    parentNameMap,
  };
}

export function removeInsertionBoundarySetting(after: string): string {
  const boundaryIndex = after.indexOf(
    `"${INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY}"`,
  );
  if (boundaryIndex === -1) {
    return after;
  }

  const lineStart = after.lastIndexOf("\n", boundaryIndex);
  const start = lineStart === -1 ? 0 : lineStart + 1;
  const lineEnd = after.indexOf("\n", boundaryIndex);
  const end = lineEnd === -1 ? after.length : lineEnd + 1;
  return after.slice(0, start) + after.slice(end);
}

/**
 * Removes the last trailing comma from a JSONC (JSON with Comments) string.
 * It correctly handles single-line, multi-line, and comments within strings.
 * A trailing comma is defined as a comma that is the last meaningful character,
 * or a comma that is the second-to-last meaningful character followed only by a
 * closing brace '}' or bracket ']'.
 *
 * @param text The JSONC content as a string.
 * @returns A new string with the trailing comma removed, or the original string if no trailing comma was found.
 */
export function removeTrailingComma(text: string): string {
  let lastMeaningfulIndex = -1;
  let secondToLastMeaningfulIndex = -1;

  let inMultiLineComment = false;
  let inString = false;
  let stringChar = ""; // Can be ' or "

  // This loop is similar to getLastMeaningfulCharacterIndex, but tracks the last TWO meaningful characters.
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prevChar = text[i - 1];
    const nextChar = text[i + 1];

    // State 1: Inside a multi-line comment
    if (inMultiLineComment) {
      if (char === "*" && nextChar === "/") {
        inMultiLineComment = false;
        i++; // Consume the '/'
      }
      continue;
    }

    // State 2: Inside a string
    if (inString) {
      if (char === stringChar && prevChar !== "\\") {
        inString = false;
      }
      secondToLastMeaningfulIndex = lastMeaningfulIndex;
      lastMeaningfulIndex = i;
      continue;
    }

    // State 3: Default state (not in a comment or string)
    if (char === "/" && nextChar === "/") {
      const newlineIndex = text.indexOf("\n", i);
      if (newlineIndex === -1) {
        break; // End of file is a comment
      }
      i = newlineIndex;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inMultiLineComment = true;
      i++; // Consume the '*'
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      secondToLastMeaningfulIndex = lastMeaningfulIndex;
      lastMeaningfulIndex = i;
      continue;
    }

    if (!/\s/.test(char)) {
      secondToLastMeaningfulIndex = lastMeaningfulIndex;
      lastMeaningfulIndex = i;
    }
  }

  // After parsing, check if we found a trailing comma.
  if (lastMeaningfulIndex === -1) {
    return text; // No meaningful characters found.
  }

  const lastMeaningfulChar = text[lastMeaningfulIndex];

  // Case 1: The very last meaningful character is a comma.
  // e.g., { "a": 1, }
  if (lastMeaningfulChar === ",") {
    return (
      text.slice(0, lastMeaningfulIndex) + text.slice(lastMeaningfulIndex + 1)
    );
  }

  // Case 2: The last character is a brace/bracket, and the one before it is a comma.
  // e.g. { "a": 1, }
  if (
    (lastMeaningfulChar === "}" || lastMeaningfulChar === "]") &&
    secondToLastMeaningfulIndex !== -1
  ) {
    const secondToLastMeaningfulChar = text[secondToLastMeaningfulIndex];
    if (secondToLastMeaningfulChar === ",") {
      return (
        text.slice(0, secondToLastMeaningfulIndex) +
        text.slice(secondToLastMeaningfulIndex + 1)
      );
    }
  }

  // If neither of the above conditions are met, there's no trailing comma to remove.
  return text;
}

/**
 * Returns the `raw` file in two parts:
 * 1. The content before the closing brace (excluding the closing brace).
 * 2. The content after and including the closing brace.
 *
 * @param raw Raw `settings.json` file.
 * @returns Returns `raw` in two parts: before, and after the closing brace.
 */
export function splitRawSettingsByClosingBrace(
  raw: string,
): [beforeClose: string, afterClose: string] {
  let closingIndex = raw.lastIndexOf("}");
  if (closingIndex === -1) {
    return ["{\n", "}\n"];
  }

  const beforeClose = raw.slice(0, closingIndex);
  const afterClose = raw.slice(closingIndex);
  return [beforeClose, afterClose];
}

/**
 * Attempts to detect the tab string used in a JSON/JSONC file.
 * Returns either "\t" for tabs or a string of spaces (usually 2 or 4).
 * Defaults to 4 spaces if detection fails.
 */
export function findTabValue(raw: string): string {
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    // Skip empty lines and lines without leading whitespace:
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^( +|\t+)/);
    if (!match) {
      continue;
    }

    const indent = match[1];
    if (indent[0] === "\t") {
      return "\t"; // Tabs detected
    }

    // Spaces: measure run length
    return " ".repeat(indent.length);
  }

  // Fallback tab size:
  return "    ";
}

/**
 * Builds the inherited settings block with start, warning, entries, and end.
 *
 * @param flattened Flattened settings to insert into the settings block.
 * @param tab Tab sequence to use.
 * @returns Returns the raw inherited settings block.
 */
export function buildInheritedSettingsBlock(
  flattened: Record<string, any>,
  tab: string,
): string {
  const entries = Object.entries(flattened)
    .map(([key, value]) => `${tab}"${key}": ${JSON.stringify(value)}`)
    .join(",\n");
  const insertionBoundaryEntry =
    `${tab}"${INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY}": ${JSON.stringify(INHERITED_SETTINGS_INSERTION_BOUNDARY_VALUE)}`;

  return (
    tab +
    INHERITED_SETTINGS_START_MARKER +
    "\n" +
    tab +
    WARNING_COMMENT +
    "\n" +
    tab +
    WARNING_EXPLAIN +
    "\n" +
    entries +
    (entries ? ",\n" : "") +
    tab +
    INHERITED_SETTINGS_END_MARKER +
    "\n" +
    insertionBoundaryEntry +
    "\n"
  );
}

/**
 * Inserts block before closing brace, handling commas and trailing comments.
 *
 * Does not remove or modify user comments.
 *
 * @returns Returns a string starting with the `beforeClose` block, followed by
 * the `block`. The returned string is formatted JSONC without the final closing
 * bracket.
 */
export function insertBeforeClose(beforeClose: string, block: string): string {
  const meaningfulCharIndex = getLastMeaningfulCharacterIndex(beforeClose);
  if (meaningfulCharIndex === -1) {
    console.warn(
      "No meaningful text found when attempting to insert `block` after `beforeClose`.",
    );
    return beforeClose.replace(/\s*$/, "\n") + block;
  }
  const meaningfulChar = beforeClose[meaningfulCharIndex];

  const needsComma =
    /\S/.test(beforeClose) && meaningfulChar !== "{" && meaningfulChar !== ",";

  if (!needsComma) {
    return beforeClose.replace(/\s*$/, "\n") + block;
  }

  const before = beforeClose.slice(0, meaningfulCharIndex + 1);
  const after = beforeClose.slice(meaningfulCharIndex + 1);

  return before + "," + after.replace(/\s*$/, "\n") + block;
}

/**
 * Finds the index of the last meaningful character in a JSONC (JSON with Comments) string.
 * A "meaningful" character is one that is not part of a single-line or multi-line comment,
 * and is not whitespace. Characters within strings are considered meaningful.
 *
 * @param text The JSONC content as a string.
 * @returns The zero-based index of the last meaningful character, or -1 if none is found.
 */
export function getLastMeaningfulCharacterIndex(text: string): number {
  let lastMeaningfulIndex = -1;
  let inMultiLineComment = false;
  let inString = false;
  let stringChar = ""; // Can be ' or "

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prevChar = text[i - 1];
    const nextChar = text[i + 1];

    // State 1: Inside a multi-line comment
    if (inMultiLineComment) {
      if (char === "*" && nextChar === "/") {
        inMultiLineComment = false;
        i++; // Consume the '/' as well
      }
      continue;
    }

    // State 2: Inside a string
    if (inString) {
      if (char === stringChar && prevChar !== "\\") {
        inString = false;
      }
      lastMeaningfulIndex = i;
      continue;
    }

    // State 3: Default state (not in a comment or string)
    if (char === "/" && nextChar === "/") {
      const newlineIndex = text.indexOf("\n", i);
      if (newlineIndex === -1) {
        break;
      }
      i = newlineIndex;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inMultiLineComment = true;
      i++; // Consume the '*' as well
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      lastMeaningfulIndex = i;
      continue;
    }

    if (!/\s/.test(char)) {
      lastMeaningfulIndex = i;
    }
  }

  return lastMeaningfulIndex;
}
