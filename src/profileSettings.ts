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
 *      - flattenSettings() — 将嵌套 settings 拍平（如 {editor:{fontSize:14}} → {"editor.fontSize":14}）
 *      - mergeFlattenedSettings() — 合并两个拍平后的设置对象（后者覆盖前者）
 *      - subtractSettings() — 返回 base 中不在 toRemove 里的项
 *      - sortSettings() — 按 key 字母序排序
 *
 *   2. 标记常量：
 *      - INHERITED_SETTINGS_START_MARKER / END_MARKER
 *        → 标记 inherited 块在 settings.json 中的起止位置
 *      - INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY
 *        → 用于定位插入位置的内部门牌设置
 *
 *   3. 字符串/文件操作：
 *      - buildInheritedSettingsBlock() — 构建 inherited 设置块（含标记）
 *      - splitRawSettingsByClosingBrace() — 按最后一个 } 切开 JSON
 *      - insertBeforeClose() — 在关闭括号前插入内容
 *      - removeTrailingComma() — 移除 JSON 末尾多余逗号（支持注释和字符串）
 *      - removeInsertionBoundarySetting() — 移除内部门牌设置行
 *      - stripManagedProfileSettings() — 从对象中移除内部标记 key
 *      - findTabValue() — 检测 JSONC 文件的缩进风格（空格/制表符）
 *
 * 依赖关系（Dependencies）:
 *   无外部依赖，纯 TypeScript 实现
 *
 * 被谁使用（Used by）:
 *   src/profiles.ts — 所有继承逻辑都依赖此模块
 *
 * 导出列表（Exports）:
 *   --- 常量 ---
 *   - INHERITED_SETTINGS_START_MARKER                 inherited 块起始标记
 *   - INHERITED_SETTINGS_END_MARKER                   inherited 块结束标记
 *   - INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY       内部门牌设置 key
 *   - INHERITED_SETTINGS_INSERTION_BOUNDARY_VALUE     内部门牌设置 value
 *   - WARNING_COMMENT                                 继承块警告注释
 *   - WARNING_EXPLAIN                                 继承块说明注释
 *
 *   --- 设置对象操作 ---
 *   - flattenSettings(settings, parentKey?, result?)  嵌套设置拍平
 *   - mergeFlattenedSettings(target, source)           合并两个拍平设置（source 优先）
 *   - subtractSettings(base, toRemove)                返回 base 中不在 toRemove 里的项
 *   - sortSettings(settings)                          按 key 字母序排序
 *   - stripManagedProfileSettings(settings)           移除内部标记 key
 *
 *   --- JSONC 字符串操作 ---
 *   - removeInsertionBoundarySetting(after)           从字符串中移除内部门牌行
 *   - removeTrailingComma(text)                       移除末尾多余的逗号
 *   - splitRawSettingsByClosingBrace(raw)             按最后一个 } 切分为两部分
 *   - findTabValue(raw)                               检测缩进风格（空格/制表符）
 *   - buildInheritedSettingsBlock(flattened, tab)     构建完整的 inherited 设置块
 *   - insertBeforeClose(beforeClose, block)           在关闭括号前插入内容
 */

export const INHERITED_SETTINGS_START_MARKER =
  "// --- INHERITED SETTINGS MARKER START --- //";
export const INHERITED_SETTINGS_END_MARKER =
  "// --- INHERITED SETTINGS MARKER END --- //";
export const INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY =
  "inheritProfile._insertionBoundary";
export const INHERITED_SETTINGS_INSERTION_BOUNDARY_VALUE = false;

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
 * Removes any extensions that were previously marked as inherited from
 * another profile (i.e. extensions with a `metadata.inheritedFromProfile`
 * field).
 * @param extensions Extensions to filter.
 * @returns Returns `extensions` without any previously-inherited entries.
 */
export function stripInheritedExtensions<T extends ExtensionEntry>(
  extensions: readonly T[],
): T[] {
  return extensions.filter((extension) => !extension?.metadata?.inheritedFromProfile);
}

/**
 * Merges extensions collected from a list of parent profiles into the
 * current profile's extensions, tagging newly inherited extensions with
 * `metadata.inheritedFromProfile` so they can be identified and removed
 * later.
 *
 * Extensions that already exist in `currentExtensions` (matched by
 * `identifier.id`) always take priority over an inherited extension with the
 * same id. When more than one parent profile declares the same extension,
 * the first profile in `parentProfiles` to declare it wins.
 *
 * @param currentExtensions Extensions already declared by the current
 * profile. Any previously-inherited entries should already be stripped out
 * (see {@link stripInheritedExtensions}).
 * @param parentProfiles Ordered list of parent profile names paired with the
 * extensions declared by that profile.
 * @returns Returns the merged list of extensions to write back to the
 * current profile.
 */
export function mergeInheritedExtensions<T extends ExtensionEntry>(
  currentExtensions: readonly T[],
  parentProfiles: readonly { profileName: string; extensions: readonly T[] }[],
): T[] {
  const extensionMap: Record<string, T> = {};
  for (const extension of currentExtensions) {
    const id = extension?.identifier?.id;
    if (id) {
      extensionMap[id] = extension;
    }
  }

  for (const { profileName, extensions } of parentProfiles) {
    for (const extension of extensions) {
      const id = extension?.identifier?.id;
      if (id && !(id in extensionMap)) {
        extensionMap[id] = {
          ...extension,
          metadata: {
            ...(extension.metadata ?? {}),
            inheritedFromProfile: profileName,
          },
        };
      }
    }
  }

  return Object.values(extensionMap);
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
