/**
 * =============================================================================
 * inherit-profile-plus — Profile 继承核心逻辑
 * =============================================================================
 *
 * 用途（Purpose）:
 *   实现 VS Code Profile 之间的设置（settings.json）和扩展（extensions.json）
 *   继承逻辑。子 Profile 可以声明一个或多个父 Profile，自动继承其配置。
 *
 * 工作机制（How it works）:
 *   1. 通过读取 VS Code 全局存储 storage.json 获取 Profile 列表和当前 Profile
 *   2. 获取当前 Profile 的 `inheritProfile.parents` 配置，确定父 Profile
 *   3. 设置继承：
 *      a. 读取父 Profile 和子 Profile 的 settings.json
 *      b. 用 subtractSettings() 剔除子中已有的 key（子覆盖父）
 *      c. 将缺失的父设置写入 inherited 标记块（带起始/结束标记）
 *   4. 扩展继承（7步全量对账）：
 *      a. 读取 settings.json 元数据（originallyOwn, optedOut）
 *      b. 转换旧标记格式（inheritedFromProfile → inheritProfile.inherited）
 *      c. 注入 optedOut 标记
 *      d. 一致性校验（settings.json 列表 ↔ extensions.json 标记）
 *      e. 收集父级扩展
 *      f. 通过 mergeInheritedExtensions 全量对账
 *      g. 统计真实新增/移除
 *   5. 反向索引 + 级联触发：
 *      - 建立 parent→children 映射
 *      - 当父 Profile 变更时，仅同步其后代
 *      - 缓存带 mtime 校验，自动失效
 *
 * 依赖关系（Dependencies）:
 *   - import { ... } from "./profileSettings" — JSONC 工具函数
 *   - import { SelfWriteTracker } from "./selfWriteTracker" — 自写跟踪
 *   - vscode 模块 — 配置、消息通知
 *   - fs/promises + path — 文件读写
 *   - jsonc-parser — 解析带注释的 JSON
 *
 * 对外提供的 API（Exports）:
 *   - readJSON(filePath)                                    [async] 读取 JSONC 文件
 *   - getGlobalStoragePath(context)                         获取 storage.json 路径
 *   - getCurrentProfileName(context)                        [async] 获取当前 Profile 名称
 *   - getProfileMap(context)                                [async] Profile 名称→目录映射
 *   - getCurrentProfileDetails(context)                     [async] 当前 Profile 详细信息
 *   - readRawSettingsFile(settingsPath)                     [async] 读取原始 settings.json
 *   - updateCurrentProfileInheritance(context, trigger?)    [async] **主要入口**：完整继承同步
 *   - removeCurrentProfileInheritedSettings(context)        [async] 清除当前 Profile 的继承内容
 *   - writeManagedFile(filePath, content)                   [async] 写入文件并记录自写
 *   - isManagedFileSelfWrite(filePath, content)             判断是否为自身的写入
 *   - invalidateInheritanceGraph()                          使反向索引缓存失效
 *
 * 内部函数（Internal）:
 *   - getUserDirectory(context)                              获取用户目录
 *   - getGlobalStoragePath(context)                          获取 storage.json 路径
 *   - readGlobalStorage(context)                             [async] 读取全局存储
 *   - getCustomProfiles(context)                             [async] 获取自定义 Profile 列表
 *   - findByKeyValuePair(input, key, value)                  在嵌套对象中递归搜索
 *   - getProfileSettings(context, profiles)                  [async] 收集指定 Profile 的拍平设置
 *   - getCurrentProfileSettings(context)                     [async] 当前 Profile 自身设置
 *   - getInheritedSettings(context)                          [async] 计算应继承的设置（父−子）
 *   - removeInheritedSettingsFromFile(settingsPath)          [async] 从文件移除 inherited 标记块
 *   - writeInheritedSettings(settingsPath, flattened)        [async] 写入 inherited 设置块
 *   - applyInheritedSettings(context)                        [async] 执行继承（设置+扩展+备份）
 *   - collectInheritedExtensions(context, ...)               [async] 7步全量对账扩展继承
 *   - buildInheritanceGraph(profiles)                        构建反向索引
 *   - isGraphCacheValid(profiles)                            检查反向索引缓存有效性
 *   - getInheritanceGraph(profiles)                          获取或构建缓存的反向索引
 *   - getDescendants(root, graph)                            BFS 获取所有后代
 *
 * 配置项（Config keys under "inheritProfile"）:
 *   - parents: string[] — 父 Profile 名称列表
 *   - runOnStartup: boolean — 启动时自动同步
 *   - runOnProfileChange: boolean — 切换 Profile 时自动同步
 *   - runOnCurrentProfileSave: boolean — 当前 Profile 保存时同步
 *   - runOnParentProfileSave: boolean — 父级保存时同步
 *   - inheritExtensions: boolean — 是否继承扩展
 *   - showMessages: boolean — 是否显示通知消息
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { statSync, readFileSync } from "fs";
import { parse as parseJSONC } from "jsonc-parser";
import {
  buildInheritedSettingsBlock,
  findTabValue,
  flattenSettings,
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_START_MARKER,
  insertBeforeClose,
  mergeFlattenedSettings,
  mergeInheritedExtensions,
  removeInsertionBoundarySetting,
  removeTrailingComma,
  sortSettings,
  splitRawSettingsByClosingBrace,
  stripInheritedExtensions,
  stripManagedProfileSettings,
  subtractSettings,
  convertOldMarkers,
  isInheritedExtension,
  isOptedOutExtension,
  markExtensionAsInherited,
  markExtensionAsOptedOut,
  INHERITED_PROFILE_META_KEY,
} from "./profileSettings";
import { SelfWriteTracker } from "./selfWriteTracker";

/**
 * Tracks content written to profile files by this extension so that file
 * watchers reacting to those same files can tell the difference between our
 * own writes and genuine external edits.
 */
const selfWriteTracker = new SelfWriteTracker();

/**
 * Writes `content` to `filePath` and records it with {@link selfWriteTracker}
 * so that file watchers set up to react to external edits of this file (see
 * `isManagedFileSelfWrite`) can recognise and ignore the change this write is
 * about to cause.
 */
async function writeManagedFile(
  filePath: string,
  content: string,
): Promise<void> {
  selfWriteTracker.record(filePath, content);
  await fs.writeFile(filePath, content, "utf8");
}

// writeManagedFile 需要 export, 供 extension.ts 的 checkAndRestoreMarkers 调用
export { writeManagedFile };

/**
 * Reports whether the most recent write to `filePath` (via
 * {@link writeManagedFile}) wrote exactly `content`, meaning a file watcher
 * observing this change is seeing this extension's own write rather than an
 * external edit.
 * @param filePath Absolute path to the file that changed.
 * @param content The file's current content.
 */
export function isManagedFileSelfWrite(
  filePath: string,
  content: string,
): boolean {
  return selfWriteTracker.isSelfWrite(filePath, content);
}

// ---------------------------------------------------------------------------
// 反向索引 + 级联触发
// ---------------------------------------------------------------------------

// 内存缓存: parent → children[]
let inheritanceGraphCache: Record<string, string[]> | undefined;
// 缓存时的 profiles 快照（用于检测 profile 新增/删除）
let cachedProfilesSnapshot: Record<string, string> | undefined;
// 缓存时各 profile 目录的 mtime 签名, 用于检测文件变更
let cachedProfileMtimes: Record<string, number> | undefined;

/**
 * 检查缓存是否仍然有效。
 * 如 profiles 列表有变动或任一 profile 目录的 mtime 变化, 缓存失效。
 */
function isGraphCacheValid(
  profiles: Readonly<Record<string, string>>,
): boolean {
  if (!inheritanceGraphCache || !cachedProfilesSnapshot || !cachedProfileMtimes) {
    return false;
  }
  // 检查 profile 列表是否一致
  const currentKeys = Object.keys(profiles).sort().join(",");
  const cachedKeys = Object.keys(cachedProfilesSnapshot).sort().join(",");
  if (currentKeys !== cachedKeys) return false;
  // 检查每个 profile 目录的 mtime
  for (const [name, dir] of Object.entries(profiles)) {
    try {
      const stat = statSync(dir);
      if (stat.mtimeMs !== cachedProfileMtimes[name]) return false;
    } catch {
      return false; // 目录不存在或无法访问
    }
  }
  return true;
}

/**
 * 构建继承关系反向索引。
 * 扫描所有 profile 的 settings.json 中的 inheritProfile.parents 来建立。
 * 同时记录 mtime 签名以供后续缓存校验。
 */
function buildInheritanceGraph(
  profiles: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const mtimes: Record<string, number> = {};
  for (const [profileName, profileDir] of Object.entries(profiles)) {
    const settingsPath = path.join(profileDir, "settings.json");
    try {
      // 记录 mtime
      const dirStat = statSync(profileDir);
      mtimes[profileName] = dirStat.mtimeMs;

      const raw = readFileSync(settingsPath, "utf8");
      const settings = parseJSONC(raw) as Record<string, any>;
      const parents = settings?.inheritProfile?.parents ?? [];
      for (const parent of parents) {
        if (profiles[parent]) {
          if (!graph[parent]) graph[parent] = [];
          if (!graph[parent].includes(profileName)) {
            graph[parent].push(profileName);
          }
        }
      }
    } catch (err) {
      // 忽略无法读取的 settings.json (如新 profile 尚无配置)
      // 但记录 warn 以便调试
      console.warn(`buildInheritanceGraph: skipping \`${profileName}\` (${(err as Error)?.message ?? err})`);
    }
  }
  cachedProfileMtimes = mtimes;
  cachedProfilesSnapshot = { ...profiles };
  return graph;
}

/**
 * 获取或构建缓存的反向索引。
 * 如果缓存已失效（profiles 变动或 mtime 变化）, 自动重建。
 */
export function getInheritanceGraph(
  profiles: Readonly<Record<string, string>>,
): Record<string, string[]> {
  if (!inheritanceGraphCache || !isGraphCacheValid(profiles)) {
    inheritanceGraphCache = buildInheritanceGraph(profiles);
  }
  return inheritanceGraphCache;
}

/**
 * 使反向索引缓存失效（配置变更时调用）。
 * 注意: 日常使用中缓存由 `getInheritanceGraph` 的 `isGraphCacheValid`
 * 自动校验（检查 profiles 列表和 mtime）, 无需手动失效。
 * 但父级列表变更（`inheritProfile.parents` 配置变化）时仍需手动调用,
 * 因为继承关系拓扑变了, mtime 检测无法感知。
 */
function invalidateInheritanceGraph(): void {
  inheritanceGraphCache = undefined;
  cachedProfilesSnapshot = undefined;
  cachedProfileMtimes = undefined;
}

export function getDescendants(
  root: string,
  graph: Record<string, string[]>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = graph[current] ?? [];
    for (const child of children) {
      if (!visited.has(child)) {
        visited.add(child);
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
}

// 注意: invalidateInheritanceGraph 需要 export, 供 extension.ts 和 profileWatchers.ts 调用
export { invalidateInheritanceGraph };

/**
 * 为当前 Profile 写入父级列表到 settings.json。
 * 不触发同步——调用者需自行调用 reconcileAllProfiles。
 */
export async function writeParentProfiles(
  context: vscode.ExtensionContext,
  parentNames: string[],
): Promise<void> {
  const { currentProfileDirectory, currentProfileName } =
    await getCurrentProfileDetails(context);
  const settingsPath = path.join(currentProfileDirectory, "settings.json");
  const raw = await readRawSettingsFile(settingsPath);
  const { modify, applyEdits } = await import("jsonc-parser");
  const options: import("jsonc-parser").ModificationOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 4 },
  };
  const edits = modify(
    raw,
    ["inheritProfile", "parents"],
    parentNames,
    options,
  );
  const updated = applyEdits(raw, edits);
  await writeManagedFile(settingsPath, updated);
  invalidateInheritanceGraph();
  console.info(
    `Parents for \`${currentProfileName}\` set to: [${parentNames.join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------

/**
 * Reads JSONC (JSON with comments).
 * @param filePath Path to the JSON/JSONC file.
 * @returns Parsed object or {} on error.
 */
export async function readJSON(filePath: string): Promise<any> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJSONC(raw); // handles // and /* */ comments
  } catch (error) {
    console.error(`Failed to read JSONC at ${filePath}:`, error);
    return {};
  }
}

/**
 * @returns The user directory.
 */
function getUserDirectory(context: vscode.ExtensionContext): string {
  return path.resolve(context.globalStorageUri.fsPath, "../../");
}

/**
 * Gets the path to the global storage JSON file.
 * @param context Extension context.
 * @returns Returns the path to the global storage JSON file.
 */
export function getGlobalStoragePath(context: vscode.ExtensionContext): string {
  return path.resolve(context.globalStorageUri.fsPath, "../storage.json");
}

/**
 * Reads the global storage JSON file.
 *
 * This contains a lot of useful information about profiles.
 * @param context Extension context.
 * @returns Returns the contents of the global storage JSON file.
 */
async function readGlobalStorage(
  context: vscode.ExtensionContext,
): Promise<any> {
  const storagePath: string = getGlobalStoragePath(context);
  return await readJSON(storagePath);
}

/**
 * Extracts the custom profiles section from the global storage JSON file.
 *
 * This is useful for finding out the names and paths of the user created
 * profiles.
 * @param context Extension context.
 * @returns Returns the contents of the `userDataProfiles` filed from the global
 * storage JSON file.
 */
async function getCustomProfiles(
  context: vscode.ExtensionContext,
): Promise<any[]> {
  const storage = await readGlobalStorage(context);
  return storage.userDataProfiles ?? [];
}

/**
 * Finds a record by a key value pair within the record.
 * @param obj Object to search.
 * @param key Key to search.
 * @param value Expected value of the key.
 * @returns Returns the record with the given ID.
 */
function findByKeyValuePair(
  input: unknown,
  key: string,
  value: unknown,
): any | undefined {
  const seen = new Set<object>();

  function dfs(node: unknown): any | undefined {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    if (seen.has(node as object)) {
      return undefined;
    }
    seen.add(node as object);

    if (!Array.isArray(node)) {
      if (
        Object.prototype.hasOwnProperty.call(node, key) &&
        (node as any)[key] === value
      ) {
        return node;
      }
      for (const v of Object.values(node as Record<string, unknown>)) {
        const found = dfs(v);
        if (found) {
          return found;
        }
      }
    } else {
      for (const item of node as unknown[]) {
        const found = dfs(item);
        if (found) {
          return found;
        }
      }
    }

    return undefined;
  }

  return dfs(input);
}

/**
 * Gets the current profile name.
 * @param context Extension context.
 * @returns Returns the name of the current profile.
 */
export async function getCurrentProfileName(
  context: vscode.ExtensionContext,
): Promise<string> {
  const storage = await readGlobalStorage(context);
  const profilesSubMenu = findByKeyValuePair(
    storage,
    "id",
    "submenuitem.Profiles",
  );
  if (profilesSubMenu) {
    const submenuItems = profilesSubMenu.submenu.items;
    for (const submenuItem of submenuItems) {
      if (submenuItem.checked) {
        const fullProfileId: string = submenuItem.id;
        const profileId = fullProfileId.substring(
          fullProfileId.lastIndexOf(".") + 1,
        );
        const profileData = findByKeyValuePair(storage, "location", profileId);
        if (profileData) {
          return profileData.name;
        }
      }
    }
  }

  const workspaceUri: vscode.Uri | undefined =
    vscode.workspace.workspaceFile ||
    vscode.workspace.workspaceFolders?.at(0)?.uri;
  if (workspaceUri) {
    const workspaceKey = workspaceUri.toString();
    const workspaceAssociations = storage.profileAssociations?.workspaces;
    if (
      workspaceAssociations &&
      Object.prototype.hasOwnProperty.call(workspaceAssociations, workspaceKey)
    ) {
      const profileId = workspaceAssociations[workspaceKey];
      const profile = findByKeyValuePair(
        storage.userDataProfiles,
        "location",
        profileId,
      );
      return profile?.name || "Default";
    }
  }

  // Fallback for empty windows (no workspace/folder open):
  // In VS Code 1.127+, the profile menu structure is no longer in storage.json.
  // Use the current window's backup folder ID to look up the profile association.
  const lastActiveWindow = storage.windowsState?.lastActiveWindow;
  if (lastActiveWindow?.backupPath) {
    const backupFolderId = path.basename(lastActiveWindow.backupPath);
    const emptyWindows = storage.profileAssociations?.emptyWindows;
    if (
      emptyWindows &&
      Object.prototype.hasOwnProperty.call(emptyWindows, backupFolderId)
    ) {
      const profileId = emptyWindows[backupFolderId];
      const profile = findByKeyValuePair(
        storage.userDataProfiles,
        "location",
        profileId,
      );
      if (profile?.name) {
        return profile.name;
      }
    }
  }

  return "Default";
}

/**
 * Finds each of the profiles in the user directory and returns a mapping from
 * the profile name to the profile directory.
 * @param context Extension context.
 * @returns A mapping from profile name to the directory for the profile.
 */
export async function getProfileMap(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const userDirectory = getUserDirectory(context);

  // Add the default profile:
  // NOTE: The default profile always exists in the user directory.
  map["Default"] = userDirectory;

  // Add the custom profiles:
  let customProfiles: any[] = await getCustomProfiles(context);
  for (const profile of customProfiles) {
    if (profile.name && profile.location) {
      map[profile.name] = path.join(
        userDirectory,
        "profiles",
        profile.location,
      );
    }
  }

  return map;
}

/**
 * Gets the current profile name, directory, and full profile map.
 * @param context Extension context.
 * @returns Returns details about the current profile.
 */
export async function getCurrentProfileDetails(
  context: vscode.ExtensionContext,
): Promise<{
  currentProfileName: string;
  currentProfileDirectory: string;
  profiles: Record<string, string>;
}> {
  const currentProfileName = await getCurrentProfileName(context);
  const profiles = await getProfileMap(context);
  const currentProfileDirectory = profiles[currentProfileName];
  if (!currentProfileDirectory) {
    throw new Error(
      `Unable to find current profile directory for \`${currentProfileName}\` profile.`,
    );
  }

  return {
    currentProfileName,
    currentProfileDirectory,
    profiles,
  };
}

/**
 * Collects the settings for each of the profiles.
 *
 * This function will start with the first profile in the list. This function
 * will override properties that are redefined in profiles that appear towards
 * the end of the list.
 * @param context Extension context.
 * @param profiles List of profiles to collect settings for.
 * @returns Flattened settings from the provided profiles.
 */
async function getProfileSettings(
  context: vscode.ExtensionContext,
  profiles: string[],
): Promise<Record<string, string>> {
  const profileMap: Record<string, string> = await getProfileMap(context);
  var settings: Record<string, string> = {};
  console.debug(
    `Collecting settings from ${profiles.length} different profiles.`,
  );
  for (const profileName of profiles) {
    const profilePath = profileMap[profileName];
    if (!profilePath) {
      console.warn(
        `Failed to collect settings for profile ${profileName}: Profile does not exist.`,
      );
      continue;
    }
    const settingsPath = path.join(profilePath, "settings.json");
    // TODO: We could also collect extensions here

    const profileSettings = stripManagedProfileSettings(
      flattenSettings(await readJSON(settingsPath)),
    );
    console.debug(
      `Found ${Object.keys(profileSettings).length} settings from \`${settingsPath}\`.`,
    );
    settings = mergeFlattenedSettings(settings, profileSettings);
    console.debug(
      `Merged ${settingsPath} into collected settings. Current total settings ${Object.keys(settings).length}.`,
    );
  }
  return stripManagedProfileSettings(settings);
}

/**
 * Gets the settings for the current profile.
 * @param context Extension context.
 * @returns Returns the flattened settings for the current profile.
 */
async function getCurrentProfileSettings(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const currentProfileName = await getCurrentProfileName(context);
  return flattenSettings(
    await getProfileSettings(context, [currentProfileName]),
  );
}

/**
 * Gets the settings that are missing from the current profile.
 * @param context Extension context.
 * @returns Returns the flattened settings that are missing from the current profile.
 */
async function getInheritedSettings(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const currentProfileSettings = await getCurrentProfileSettings(context);
  console.info(
    `Found ${Object.keys(currentProfileSettings).length} settings in current profile.`,
  );

  const config = vscode.workspace.getConfiguration("inheritProfile");
  const parentProfiles = config.get<string[]>("parents", []);
  const parentProfileSettings = await getProfileSettings(
    context,
    parentProfiles,
  );
  console.info(
    `Found ${Object.keys(parentProfileSettings).length} settings in parent profiles.`,
  );

  const inheritedSettings = subtractSettings(
    parentProfileSettings,
    currentProfileSettings,
  );
  console.info(
    `Found ${Object.keys(inheritedSettings).length} inherited in from parent profiles.`,
  );

  const sortedInheritedSettings = sortSettings(inheritedSettings);
  return sortedInheritedSettings;
}

/**
 * Removes the inherited settings block (including the markers) from a settings
 * file.
 *
 * If no markers are found, the file is left unchanged.
 */
async function removeInheritedSettingsFromFile(
  settingsPath: string,
): Promise<void> {
  console.info(`Removing inherited settings from \`${settingsPath}\`.`);

  // Find the start and end markers:
  let raw = "";
  try {
    raw = await readRawSettingsFile(settingsPath);
  } catch (error) {
    console.error(
      `Failed to read settings file at \`${settingsPath}\`:`,
      error,
    );
    return;
  }

  const startIndex = raw.indexOf(INHERITED_SETTINGS_START_MARKER);
  const endIndex = raw.indexOf(INHERITED_SETTINGS_END_MARKER);

  // Ensure the markers exist:
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    if (startIndex !== endIndex) {
      console.warn(
        "Either the start or end marker is missing in the current profile.",
      );
    }
    return; // markers not found, leave file alone
  }

  // Clean response:
  const before = raw.slice(0, startIndex);
  const after = removeInsertionBoundarySetting(
    raw.slice(endIndex + INHERITED_SETTINGS_END_MARKER.length),
  );
  let cleaned = before.trimEnd() + after.trimEnd();

  // Ensure JSONC ends properly:
  cleaned = removeTrailingComma(cleaned);
  if (!cleaned.endsWith("}")) {
    cleaned += "\n}";
  }

  // Write cleaned file:
  await writeManagedFile(settingsPath, cleaned + "\n");
}

/**
 * Writes a set of inherited settings to a settings path.
 *
 * IMPORTANT: This function assumes that there are no inherited settings in the
 * file. Any inherited settings should be removed before calling this function.
 */
async function writeInheritedSettings(
  settingsPath: string,
  flattened: Record<string, any>,
): Promise<void> {
  // Early exit if there is nothing to add:
  if (Object.keys(flattened).length === 0) {
    return;
  }

  // Read the raw file, split it by the closing brace, and get the tab size
  // for formatting:
  const raw = await readRawSettingsFile(settingsPath);
  const [beforeClose, afterClose] = await splitRawSettingsByClosingBrace(raw);
  const tab = findTabValue(raw);

  // Build the inherited settings block:
  const block = buildInheritedSettingsBlock(flattened, tab);

  // Insert the inherited settings block between the before and after closing
  // brace blocks:
  const beforeClosePlusBlock = insertBeforeClose(beforeClose, block);
  const finalSettings = beforeClosePlusBlock + afterClose;

  // Write the final settings to the settings path:
  await writeManagedFile(settingsPath, finalSettings);
}

/**
 * Reads and returns a raw `settings.json` file.
 */
export async function readRawSettingsFile(
  settingsPath: string,
): Promise<string> {
  try {
    return await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "{\n}\n";
    }
    throw error;
  }
}

/**
 * Applies the inherited settings to the current profile.
 * @param context Extension context.
 */
async function applyInheritedSettings(
  context: vscode.ExtensionContext,
): Promise<void> {
  const { currentProfileName, currentProfileDirectory, profiles } =
    await getCurrentProfileDetails(context);
  const currentProfilePath = path.join(
    currentProfileDirectory,
    "settings.json",
  );

  // Remove the inherited settings from the current profile:
  await removeInheritedSettingsFromFile(currentProfilePath);

  // Get the settings that the current profile should inherit:
  const inheritedSettings = await getInheritedSettings(context);
  const totalInheritedSettings = Object.keys(inheritedSettings).length;
  console.info(
    `Found ${totalInheritedSettings} inherited settings for \`${currentProfileName}\` profile.`,
  );
  if (totalInheritedSettings > 0) {
    console.info(
      `Merging ${totalInheritedSettings} settings into \`${currentProfilePath}\`.`,
    );
    await writeInheritedSettings(currentProfilePath, inheritedSettings);
  }

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (!config.get<boolean>("inheritExtensions", true)) {
    console.info("Extension inheritance is disabled, skipping extensions.");
    return;
  }

  const currentExtensionsPath = path.join(
    currentProfileDirectory,
    "extensions.json",
  );
  const parsedCurrentExtensions = await readJSON(currentExtensionsPath);
  const currentExtensions = Array.isArray(parsedCurrentExtensions)
    ? parsedCurrentExtensions
    : [];
  // Collect and write inherited extensions
  const extResult = await collectInheritedExtensions(
    context,
    currentExtensions,
    currentProfileName,
    profiles,
  );
  const finalExtensions = extResult.extensions;
  if (JSON.stringify(finalExtensions) !== JSON.stringify(currentExtensions)) {
    console.info(
      `Writing ${finalExtensions.length} extensions to \`${currentExtensionsPath}\`.`,
    );
    await writeManagedFile(
      currentExtensionsPath,
      JSON.stringify(finalExtensions, null, 4) + "\n",
    );
  }

  // 回写 _originallyOwnExtensions 和 optedOutExtensions 到 settings.json
  const { originallyOwn, optedOut } = extResult;
  if (originallyOwn.length > 0 || optedOut.length > 0) {
    const rawSettings = await readRawSettingsFile(currentProfilePath);

    const edits: import("jsonc-parser").Edit[] = [];
    const options: import("jsonc-parser").ModificationOptions = {
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    };

    const { modify, applyEdits } = await import("jsonc-parser");

    edits.push(
      ...modify(rawSettings, ["inheritProfile._originallyOwnExtensions"], originallyOwn, options)
    );
    edits.push(
      ...modify(rawSettings, ["inheritProfile.optedOutExtensions"], optedOut, options)
    );

    const updatedSettings = applyEdits(rawSettings, edits);
    await writeManagedFile(currentProfilePath, updatedSettings);
  }

  // 备份当前 profile 的 extension 标记到 globalState，用于跨设备恢复
  const existingBackup = context.globalState.get<Record<string, Record<string, string>>>(
    "inheritProfile.extensionMarkers"
  ) ?? {};
  const existingMarkers = existingBackup[currentProfileName] ?? {};
  const extensionMarkersBackup = { ...existingMarkers };
  for (const ext of finalExtensions) {
    const id = ext?.identifier?.id;
    if (id && isInheritedExtension(ext) && !extensionMarkersBackup[id]) {
      extensionMarkersBackup[id] = ""; // 理论不会走到这里，兜底
    }
  }
  void context.globalState.update(
    "inheritProfile.extensionMarkers",
    {
      ...existingBackup,
      [currentProfileName]: extensionMarkersBackup,
    }
  );
}

/**
 * Collect extensions from parent profiles, merge with current profile extensions,
 * and mark inherited extensions in their metadata.
 *
 * This is the full 7-step reconciliation process:
 *   1. Read settings.json metadata (originallyOwn, optedOut)
 *   2. Convert old markers (inheritedFromProfile → inheritProfile.inherited)
 *   3. Inject optedOutList markers from settings.json
 *   3.5 Consistency check: settings.json list ↔ extensions.json markers
 *   4. Collect parent profiles' extensions
 *   5. Full reconciliation via mergeInheritedExtensions
 *   5.5 Post-process: catch opt-outs for extensions that didn't exist yet
 *   6. Backup parentNameMap to globalState
 *   7. Statistics & return
 *
 * @param context Extension context (for globalState access).
 * @param currentExtensions The parsed extensions array from the current profile.
 * @param currentProfileName Name of the current profile.
 * @param profiles A map of profile names to their directory paths.
 * @param originallyOwn Optional pre-read originallyOwn list.
 * @param optedOutList Optional pre-read optedOut list.
 * @returns The merged result plus metadata for back-writing.
 */
async function collectInheritedExtensions(
  context: vscode.ExtensionContext,
  currentExtensions: any[],
  currentProfileName: string,
  profiles: Record<string, string>,
  originallyOwn?: string[],
  optedOutList?: string[],
  parentProfileNamesOverride?: string[],
): Promise<{ extensions: any[]; originallyOwn: string[]; optedOut: string[] }> {
  // 1. 如调用者未传入, 从 settings.json 读取元数据
  const currentProfileDir = profiles[currentProfileName];
  if (!currentProfileDir) {
    console.error(
      `Cannot collect inherited extensions: profile directory for \`${currentProfileName}\` not found.`
    );
    return { extensions: currentExtensions, originallyOwn: [], optedOut: [] };
  }

  if (!originallyOwn || !optedOutList) {
    const settingsPath = path.join(currentProfileDir, "settings.json");
    const settings = await readJSON(settingsPath);
    originallyOwn = settings?.inheritProfile?._originallyOwnExtensions ?? [];
    optedOutList = settings?.inheritProfile?.optedOutExtensions ?? [];
  }

  // 2. 转换旧标记并持久化（仅首次需要）
  const migrationDoneKey = "inheritProfile._markersConverted";
  let markersAlreadyConverted = false;
  if (context.globalState.get(migrationDoneKey)) {
    markersAlreadyConverted = true;
  }

  // 始终通过 .map() 创建拷贝, 防止 step 3/3.5 的原位突变影响 caller 的数组
  let converted: any[];
  if (markersAlreadyConverted) {
    // 浅拷贝: 每个条目的 metadata 是共享引用, 但 step 3 替换整个 metadata 对象
    // (ext.metadata = {...}) 而非浅修改 (ext.metadata.foo = bar),
    // 所以浅拷贝足够安全
    converted = currentExtensions.map((e: any) => ({ ...e }));
  } else {
    converted = currentExtensions.map(convertOldMarkers);
  }

  if (!markersAlreadyConverted) {
    const hasOldMarkers = currentExtensions.some(
      (e: any) => e?.metadata?.inheritedFromProfile
    );
    if (hasOldMarkers) {
      const extPath = path.join(profiles[currentProfileName], "extensions.json");
      await writeManagedFile(
        extPath,
        JSON.stringify(converted, null, 4) + "\n",
      );
    }
    void context.globalState.update(migrationDoneKey, true);
  }

  // 3. 将 optedOutList 中的跳过注入为 optedOut 标记
  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (id && optedOutList!.includes(id) && !isOptedOutExtension(ext)) {
      ext.metadata = {
        ...(ext.metadata ?? {}),
        inheritProfile: {
          ...(ext.metadata?.inheritProfile ?? {}),
          optedOut: true,
        },
      };
    }
  }

  // 3.5 一致性校验: settings.json 的 optedOutExtensions 列表 ↔ extensions.json 的标记
  const idsWithOrphanedOptOut = new Set<string>();
  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (id && isOptedOutExtension(ext) && !optedOutList!.includes(id)) {
      idsWithOrphanedOptOut.add(id);
    }
  }
  if (idsWithOrphanedOptOut.size > 0) {
    console.warn(
      `Found ${idsWithOrphanedOptOut.size} extension(s) with orphaned optedOut marker ` +
      `(not in optedOutExtensions list): ${[...idsWithOrphanedOptOut].join(", ")}. ` +
      `Removing markers to sync with settings.json.`
    );
    for (const ext of converted) {
      const id = ext?.identifier?.id;
      if (id && idsWithOrphanedOptOut.has(id)) {
        const { inheritProfile, ...restMeta } = ext.metadata ?? {};
        const { optedOut: _, ...cleanProfile } = inheritProfile ?? {};
        ext.metadata = Object.keys(cleanProfile).length > 0
          ? ({ ...restMeta, inheritProfile: cleanProfile } as any)
          : Object.keys(restMeta).length > 0
            ? (restMeta as any)
            : undefined;
      }
    }
  }

  // 4. 获取父级列表 (优先使用调用者传入的, 否则从 vscode 配置读取)
  let parentProfileNames: string[];
  if (parentProfileNamesOverride) {
    parentProfileNames = parentProfileNamesOverride;
  } else {
    const config = vscode.workspace.getConfiguration("inheritProfile");
    parentProfileNames = config.get<string[]>("parents", []);
  }

  const parentProfiles: { profileName: string; extensions: any[] }[] = [];
  for (const profileName of parentProfileNames) {
    const profileDirectory = profiles[profileName];
    if (!profileDirectory) continue;
    const rawProfileExtensions = await readJSON(
      path.join(profileDirectory, "extensions.json")
    );
    // 过滤掉禁用的扩展 (disabled: true), 使父级禁用能传播到子级
    const extensions = (Array.isArray(rawProfileExtensions) ? rawProfileExtensions : [])
      .filter((e: any) => e?.disabled !== true);
    parentProfiles.push({
      profileName,
      extensions,
    });
  }

  // 5. 全量对账
  const result = mergeInheritedExtensions(converted, parentProfiles, originallyOwn);

  // 5.5 后处理: 从 result.merged 中移除 optedOutList 中但被 mergeInheritedExtensions
  //     误加为 inherited 的条目
  const finalMerged = result.merged.map((ext) => {
    const id = ext?.identifier?.id;
    if (id && optedOutList!.includes(id) && isInheritedExtension(ext)) {
      return markExtensionAsOptedOut(id, ext) as typeof ext;
    }
    return ext;
  });

  // 6. 将 parentNameMap 存入 globalState（用于 extensionMarkers 备份）
  const finalParentNameMap = { ...result.parentNameMap };
  for (const ext of finalMerged) {
    const id = ext?.identifier?.id;
    if (id && isOptedOutExtension(ext) && finalParentNameMap[id]) {
      delete finalParentNameMap[id];
    }
  }

  const existingBackup = context.globalState.get<Record<string, Record<string, string>>>(
    "inheritProfile.extensionMarkers"
  ) ?? {};
  const mergedBackup = {
    ...(existingBackup[currentProfileName] ?? {}),
    ...finalParentNameMap,
  };
  if (Object.keys(finalParentNameMap).length > 0) {
    await context.globalState.update("inheritProfile.extensionMarkers", {
      ...existingBackup,
      [currentProfileName]: mergedBackup,
    });
  }

  // 7. 统计真实新增/移除
  const prevInheritedIds = new Set(
    converted
      .filter((e: any) => isInheritedExtension(e))
      .map((e: any) => e.identifier?.id)
  );
  const newInheritedIds = new Set(
    finalMerged
      .filter((e: any) => isInheritedExtension(e))
      .map((e: any) => e.identifier?.id)
  );
  const addedCount = [...newInheritedIds].filter((id) => !prevInheritedIds.has(id)).length;
  const removedCount = [...prevInheritedIds].filter((id) => !newInheritedIds.has(id)).length;

  if (addedCount > 0 || removedCount > 0) {
    console.info(
      `Extensions reconciled for \`${currentProfileName}\`: ${addedCount} inherited, ${removedCount} uninherited.`
    );
  }

  return {
    extensions: finalMerged,
    originallyOwn: result.originallyOwnExtensions,
    optedOut: optedOutList ?? [],
  };
}

/**
 * Updates the inherited settings for the current profile.
 *
 * When `triggerProfileName` is provided, only performs reconciliation if the
 * current profile is a descendant of the trigger profile (cascading trigger).
 * When omitted, always reconciles the current profile (full sync).
 *
 * @param context Extension context.
 * @param triggerProfileName Optional. If set, only reconcile if current
 *   profile is a descendant of this profile (used for cascading triggers).
 */
export async function updateCurrentProfileInheritance(
  context: vscode.ExtensionContext,
  triggerProfileName?: string,
): Promise<void> {
  if (triggerProfileName) {
    // 级联触发: 仅对账触发 profile 的后代
    const { currentProfileName, profiles } = await getCurrentProfileDetails(context);
    const graph = getInheritanceGraph(profiles);
    const descendants = getDescendants(triggerProfileName, graph);

    if (!descendants.includes(currentProfileName)) {
      console.info(
        `Skipping reconciliation for ${currentProfileName}: ` +
        `not a descendant of trigger ${triggerProfileName}.`
      );
      return;
    }
  }

  await applyInheritedSettings(context);

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("showMessages", true)) {
    vscode.window.showInformationMessage("Inherited profile settings applied!");
  }
}

// ---------------------------------------------------------------------------
// 全量重建 + 单 Profile 同步
// ---------------------------------------------------------------------------

/**
 * 同步指定 Profile 的继承（设置 + 扩展）。
 * 直接从该 Profile 的 settings.json 读取 parents，不依赖 vscode 当前配置。
 */
async function syncProfileByName(
  context: vscode.ExtensionContext,
  profileName: string,
  profileDir: string,
  profiles: Record<string, string>,
): Promise<void> {
  const settingsPath = path.join(profileDir, "settings.json");
  const rawSettings = (await readJSON(settingsPath)) ?? {};
  const parentNames: string[] = rawSettings?.inheritProfile?.parents ?? [];

  // 1. 设置继承
  await removeInheritedSettingsFromFile(settingsPath);

  const parentProfileSettings = await getProfileSettings(context, parentNames);
  const ownSettings = stripManagedProfileSettings(flattenSettings(rawSettings));
  const inheritedSettings = sortSettings(
    subtractSettings(parentProfileSettings, ownSettings),
  );
  if (Object.keys(inheritedSettings).length > 0) {
    await writeInheritedSettings(settingsPath, inheritedSettings);
  }

  // 2. 扩展继承
  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("inheritExtensions", true)) {
    const extPath = path.join(profileDir, "extensions.json");
    const parsedExts = await readJSON(extPath);
    const currentExtensions = Array.isArray(parsedExts) ? parsedExts : [];

    const extResult = await collectInheritedExtensions(
      context,
      currentExtensions,
      profileName,
      profiles,
      rawSettings?.inheritProfile?._originallyOwnExtensions,
      rawSettings?.inheritProfile?.optedOutExtensions,
      parentNames,
    );

    const finalExtensions = extResult.extensions;
    if (
      JSON.stringify(finalExtensions) !== JSON.stringify(currentExtensions)
    ) {
      await writeManagedFile(
        extPath,
        JSON.stringify(finalExtensions, null, 4) + "\n",
      );
    }

    // 回写元数据
    const { originallyOwn, optedOut } = extResult;
    if (originallyOwn.length > 0 || optedOut.length > 0) {
      const rawSettingsContent = await readRawSettingsFile(settingsPath);
      const { modify, applyEdits } = await import("jsonc-parser");
      const options = {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
      };
      const edits: import("jsonc-parser").Edit[] = [];
      edits.push(
        ...modify(
          rawSettingsContent,
          ["inheritProfile", "_originallyOwnExtensions"],
          originallyOwn,
          options,
        ),
      );
      edits.push(
        ...modify(
          rawSettingsContent,
          ["inheritProfile", "optedOutExtensions"],
          optedOut,
          options,
        ),
      );
      const updated = applyEdits(rawSettingsContent, edits);
      await writeManagedFile(settingsPath, updated);
    }
  }
}

/**
 * 全量重建：从根 Profile 开始逐级向下同步所有 Profile。
 * 确保每一级都基于最新的父级状态。
 */
export async function reconcileAllProfiles(
  context: vscode.ExtensionContext,
): Promise<void> {
  const profiles = await getProfileMap(context);
  invalidateInheritanceGraph();
  const graph = getInheritanceGraph(profiles);

  // 收集所有出现在 children 中的 profile
  const allChildren = new Set<string>();
  for (const children of Object.values(graph)) {
    for (const c of children) {
      allChildren.add(c);
    }
  }

  // 根节点 = 不是任何人的孩子的 profile
  const roots = Object.keys(profiles).filter((p) => !allChildren.has(p));

  // BFS 拓扑排序: 保证父级在子级之前被同步
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    order.push(current);
    const children = graph[current] ?? [];
    for (const child of children) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  console.info(
    `Reconciliation order: ${order.join(" \u2192 ")}`,
  );

  for (const profileName of order) {
    const profileDir = profiles[profileName];
    if (!profileDir) continue;
    console.info(`Reconciling profile: ${profileName}`);
    await syncProfileByName(context, profileName, profileDir, profiles);
  }
}

/**
 * Removes the inherited settings from the current profile.
 * @param context Extension context.
 */
export async function removeCurrentProfileInheritedSettings(
  context: vscode.ExtensionContext,
): Promise<void> {
  const { currentProfileName, currentProfileDirectory } =
    await getCurrentProfileDetails(context);
  const currentProfilePath = path.join(
    currentProfileDirectory,
    "settings.json",
  );
  await removeInheritedSettingsFromFile(currentProfilePath);

  // Also remove inherited extensions from the current profile's extensions.json
  try {
    const currentExtensionsPath = path.join(
      currentProfileDirectory,
      "extensions.json",
    );
    const parsedCurrentExtensions = await readJSON(currentExtensionsPath);
    const currentExtensions = Array.isArray(parsedCurrentExtensions)
      ? parsedCurrentExtensions
      : [];
    // 先转换旧标记, 统一格式后再 strip, 避免遗漏 inheritedFromProfile 旧格式
    const converted = currentExtensions.map(convertOldMarkers);
    const filteredExtensions = stripInheritedExtensions(converted);
    // Only write if there was a change to avoid unnecessary fs writes
    if (filteredExtensions.length !== converted.length) {
      console.info(
        `Removing ${converted.length - filteredExtensions.length} inherited extensions from \`${currentExtensionsPath}\`.`,
      );
      await writeManagedFile(
        currentExtensionsPath,
        JSON.stringify(filteredExtensions, null, 4) + "\n",
      );
    }
  } catch (err) {
    console.warn(
      `Failed to remove inherited extensions for profile \`${currentProfileName}\`:`,
      err,
    );
  }

  // 清理 settings.json 中的继承元数据键 (重置为空数组而非删除, 避免 jsonc-parser
  // 处理 undefined value 的行为不确定)
  try {
    const settingsPath = path.join(currentProfileDirectory, "settings.json");
    const raw = await readRawSettingsFile(settingsPath);
    const { modify, applyEdits } = await import("jsonc-parser");
    const options: import("jsonc-parser").ModificationOptions = {
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    };
    const edits: import("jsonc-parser").Edit[] = [];
    for (const key of ["_originallyOwnExtensions", "optedOutExtensions"] as const) {
      edits.push(...modify(raw, ["inheritProfile", key], [], options));
    }
    const updated = applyEdits(raw, edits);
    if (updated !== raw) {
      await writeManagedFile(settingsPath, updated);
    }
  } catch (err) {
    console.warn(
      `Failed to clean inheritance metadata from settings.json for \`${currentProfileName}\`:`,
      err,
    );
  }

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("showMessages", true)) {
    vscode.window.showInformationMessage(
      "Inherited settings removed from current profile!",
    );
  }
}

// ---------------------------------------------------------------------------
// Inheritance Tree 展示
// ---------------------------------------------------------------------------

/**
 * 在 OutputChannel 中展示所有 Profile 的继承树形图。
 * 当前 Profile 前带 "▶ " 标记。
 */
export async function showInheritanceTree(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const { currentProfileName, profiles } =
      await getCurrentProfileDetails(context);
    const graph = getInheritanceGraph(profiles);

    // 收集所有出现在 children 中的 profile
    const allChildren = new Set<string>();
    for (const children of Object.values(graph)) {
      for (const c of children) {
        allChildren.add(c);
      }
    }

    // 根节点 = 所有 profile 中不是任何人的孩子的
    const roots = Object.keys(profiles).filter(
      (p) => !allChildren.has(p),
    );

    const lines: string[] = [];
    lines.push(
      `Profile Inheritance Tree  (current: ${currentProfileName})`,
    );
    lines.push("─".repeat(50));

    function render(node: string, depth: number) {
      const indent = "  ".repeat(depth);
      const marker = node === currentProfileName ? "\u25b6 " : "  ";
      lines.push(`${indent}${marker}${node}`);
      const children = graph[node] ?? [];
      for (const child of children) {
        render(child, depth + 1);
      }
    }

    for (const root of roots) {
      render(root, 0);
    }

    const channel = vscode.window.createOutputChannel("InheritanceTree");
    channel.clear();
    channel.appendLine(lines.join("\n"));
    channel.show(true);
  } catch (err) {
    console.error("showInheritanceTree failed:", err);
    vscode.window.showErrorMessage(
      `Failed to show inheritance tree: ${(err as Error)?.message ?? err}`,
    );
  }
}
