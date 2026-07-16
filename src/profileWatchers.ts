/**
 * =============================================================================
 * inherit-profile-plus — 文件系统监听器
 * =============================================================================
 *
 * 用途（Purpose）:
 *   负责监听 Profile 相关文件的变更事件并触发继承同步。包括：
 *   - Profile 切换监听（storage.json 变更）
 *   - 当前 Profile 的 settings.json 保存监听
 *   - 父级 Profile 的 settings.json / extensions.json 保存监听
 *
 * 工作机制（How it works）:
 *   1. 使用 vscode.FileSystemWatcher 监听文件变更
 *   2. 通过 RelativePattern 确保能监听工作区外的文件
 *   3. 区分自身写入 vs 外部编辑（通过 isManagedFileSelfWrite）
 *   4. 变更事件经过防抖处理（debounce），避免高频触发
 *   5. 父级变更支持级联触发：仅同步变更 Profile 的后代
 *
 * 依赖关系（Dependencies）:
 *   - import { ... } from "./debounce" — 防抖触发器
 *   - import { ... } from "./profileSettings" — 路径解析
 *   - import { ... } from "./profiles" — 核心继承逻辑
 *
 * 函数列表（Functions）:
 *   - createFileWatcher(filePath)                           [internal] 创建单文件监听器
 *   - updateInheritedSettingsOnProfileChange(context)       [export][async] 监听 Profile 切换
 *   - registerCurrentProfileSaveWatcher(context)            [export][async] 监听当前 Profile 保存
 *   - registerParentProfileSaveWatcher(context)             [export][async] 监听父级 Profile 保存
 */

import * as vscode from "vscode";
import * as path from "path";
import { createDebouncedTrigger } from "./debounce";
import type { DebouncedTrigger } from "./debounce";
import { resolveParentSettingsPaths, resolveParentExtensionsPaths } from "./profileSettings";
import {
  getCurrentProfileDetails,
  getCurrentProfileName,
  getGlobalStoragePath,
  getProfileMap,
  isManagedFileSelfWrite,
  readRawSettingsFile,
  updateCurrentProfileInheritance,
  invalidateInheritanceGraph,
} from "./profiles";

/**
 * Creates a {@link vscode.FileSystemWatcher} that watches a single file at an
 * absolute path.
 *
 * `vscode.workspace.createFileSystemWatcher` does not reliably report
 * changes for a plain absolute path string when that path lies outside of
 * every open workspace folder — which is always true for profile files,
 * since they live under VS Code's global storage/user directory rather than
 * a workspace. Using an explicit {@link vscode.RelativePattern} with the
 * file's parent directory as its base avoids this problem.
 * @param filePath Absolute path to the file to watch.
 */
function createFileWatcher(filePath: string): vscode.FileSystemWatcher {
  const pattern = new vscode.RelativePattern(
    path.dirname(filePath),
    path.basename(filePath),
  );
  return vscode.workspace.createFileSystemWatcher(pattern);
}

/**
 * Updates the inherited settings when the profile changes.
 * @param context Extension context.
 */
export async function updateInheritedSettingsOnProfileChange(
  context: vscode.ExtensionContext,
) {
  const globalStoragePath = getGlobalStoragePath(context);
  let currentProfile = await getCurrentProfileName(context);

  const watcher = createFileWatcher(globalStoragePath);
  const onChange = async () => {
    const newProfileName = await getCurrentProfileName(context);
    if (newProfileName !== currentProfile) {
      currentProfile = newProfileName;
      console.info(
        "Current profile has changed, updating inherited settings...",
      );
      await updateCurrentProfileInheritance(context);
    }
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);

  context.subscriptions.push(watcher);
}

/**
 * Watches the current profile's `settings.json` file and re-applies profile
 * inheritance whenever it changes for a reason other than this extension's
 * own writes (e.g. the user editing and saving the file).
 *
 * The active profile (and therefore its `settings.json` path) can change at
 * any time, so this function also watches the global storage file used to
 * track the active profile, and re-subscribes to the new profile's
 * `settings.json` whenever it changes.
 * @param context Extension context.
 */
export async function registerCurrentProfileSaveWatcher(
  context: vscode.ExtensionContext,
): Promise<void> {
  const scheduleReapply = createDebouncedTrigger(() =>
    updateCurrentProfileInheritance(context),
  );

  let settingsWatcher: vscode.FileSystemWatcher | undefined;

  const resubscribe = async () => {
    settingsWatcher?.dispose();
    settingsWatcher = undefined;

    let currentProfileDirectory: string;
    try {
      ({ currentProfileDirectory } = await getCurrentProfileDetails(context));
    } catch (error) {
      console.error(
        "Failed to resolve the current profile directory for the save watcher:",
        error,
      );
      return;
    }

    const settingsPath = path.join(currentProfileDirectory, "settings.json");
    const watcher = createFileWatcher(settingsPath);
    const onChange = async () => {
      const latestContent = await readRawSettingsFile(settingsPath);
      if (isManagedFileSelfWrite(settingsPath, latestContent)) {
        return; // Our own write; nothing changed from the user's perspective.
      }
      scheduleReapply();
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    settingsWatcher = watcher;
  };

  await resubscribe();

  // The active profile (and therefore the path watched above) can change at
  // any time, so watch the global storage file used to track it and
  // re-subscribe to the new profile's settings.json whenever it changes.
  const globalStoragePath = getGlobalStoragePath(context);
  const profileWatcher = createFileWatcher(globalStoragePath);
  profileWatcher.onDidChange(resubscribe);
  profileWatcher.onDidCreate(resubscribe);
  profileWatcher.onDidDelete(resubscribe);

  context.subscriptions.push(profileWatcher, {
    dispose: () => settingsWatcher?.dispose(),
  });
}

/**
 * Watches each parent profile's `settings.json` and `extensions.json` files
 * (as configured via `inheritProfile.parents`) and re-applies inheritance to
 * the current profile whenever any of them changes.
 *
 * Changes are debounced (500 ms) and the triggering profile name is resolved
 * from the changed file path so that the cascading trigger can skip
 * reconciliation for profiles that are not descendants of the changed
 * profile.
 *
 * Parent profiles are never written to by this extension, so unlike
 * {@link registerCurrentProfileSaveWatcher} there is no self-write to guard
 * against here.
 *
 * The set of watched files is re-resolved whenever the
 * `inheritProfile.parents` configuration changes, or the active profile
 * changes (since the set of known profiles/directories may also have
 * changed).
 * @param context Extension context.
 */
export async function registerParentProfileSaveWatcher(
  context: vscode.ExtensionContext,
): Promise<void> {
  // pendingTriggerProfile / scheduleReapply 提升到函数级 (不在 resubscribe 内),
  // 同时供 config change handler (函数体底部) 和 resubscribe 内部共用。
  // resubscribe 中只做 reassign, 不重复声明。
  // 初始延迟与 resubscribe 中的重创版本一致 (500ms), 避免时序混乱。
  let pendingTriggerProfile: string | undefined;
  let scheduleReapply: DebouncedTrigger = createDebouncedTrigger(
    () => updateCurrentProfileInheritance(context), 500,
  );

  let parentWatchers: vscode.FileSystemWatcher[] = [];

  const resubscribe = async () => {
    for (const watcher of parentWatchers) {
      watcher.dispose();
    }
    parentWatchers = [];

    const config = vscode.workspace.getConfiguration("inheritProfile");
    const parentProfileNames = config.get<string[]>("parents", []);
    if (parentProfileNames.length === 0) {
      return;
    }

    let profiles: Record<string, string>;
    try {
      profiles = await getProfileMap(context);
    } catch (error) {
      console.error(
        "Failed to resolve parent profile directories for the save watcher:",
        error,
      );
      return;
    }

    // --- 新增: extensions.json 路径解析 ---
    const parentExtensionsPaths = resolveParentExtensionsPaths(
      parentProfileNames,
      profiles,
    );

    // 统一监听 settings.json + extensions.json, 带 debounce
    // 复用函数级的 scheduleReapply, 仅 dispose 旧的、重创一个新的
    // 以便 reset debounce timer 并绑定新的 pendingTriggerProfile 闭包
    // ⚠️ 注意: 只做 reassign (无 let 或 const), 不重复声明, 避免遮蔽
    scheduleReapply.dispose();
    scheduleReapply = createDebouncedTrigger(async () => {
      const triggerName = pendingTriggerProfile;
      pendingTriggerProfile = undefined;
      await updateCurrentProfileInheritance(context, triggerName);
    }, 500);

    const parentSettingsPaths = resolveParentSettingsPaths(
      parentProfileNames,
      profiles,
    );
    const allParentPaths = [...parentSettingsPaths, ...parentExtensionsPaths];

    for (const parentPath of allParentPaths) {
      // 从路径反查 profile 名
      const profileName = parentProfileNames.find((name) => {
        const dir = profiles[name];
        return dir && parentPath.startsWith(dir);
      }) ?? parentProfileNames[0];

      // 如果反查失败（profile 不存在）, 跳过该 watcher
      if (!profileName || !profiles[profileName]) {
        console.warn(`Skipping watcher for unresolved path: ${parentPath}`);
        continue;
      }

      const watcher = createFileWatcher(parentPath);
      const onChange = () => {
        pendingTriggerProfile = profileName;
        scheduleReapply();
      };
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      parentWatchers.push(watcher);
    }
  };

  await resubscribe();

  // 修改现有的 onDidChangeConfiguration 监听: (在函数体底部, 在 resubscribe 之外)
  // 当 inheritProfile.parents 配置变更时, 不仅要重建 watcher,
  // 还要使反向索引缓存失效并触发对账。
  //
  // ⚠️ 注意重复触发防护: 编辑 settings.json → 同时触发
  //    1) registerCurrentProfileSaveWatcher 的文件 watcher (settings.json 变化)
  //    2) onDidChangeConfiguration (配置值变化)
  //    两者都会走到 updateCurrentProfileInheritance。
  //    用函数级 reconciling flag + 500ms cooldown 去重:
  //    只在 resubscribe() 通过 pendingTriggerProfile + scheduleReapply
  //    统一触发对账, 不直接调用 updateCurrentProfileInheritance。
  let reconcilingForConfigChange = false;
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("inheritProfile.parents")) {
      invalidateInheritanceGraph();

      if (reconcilingForConfigChange) return;
      reconcilingForConfigChange = true;
      setTimeout(() => { reconcilingForConfigChange = false; }, 500);

      void resubscribe().then(async () => {
        // 配置变更后显式触发对账（同步完成, 不等待下一个文件事件）。
        //
        // ⚠️ 注意: 不传 triggerProfileName (pendingTriggerProfile = undefined)。
        // 因为配置变更改的是"谁是父级"而非"某个父级的内容变了"，
        // 使用级联会错误跳过当前 profile:
        //   getDescendants(currentProfileName) 只返回后代（不含自身）
        //   descendants.includes(currentProfileName) → false → 跳过多
        // 因此对此场景做全量对账 equivalent to 不传 triggerProfileName。
        pendingTriggerProfile = undefined;
        scheduleReapply();
      });
    }
  });

  // The active profile (and therefore which directory each parent profile
  // name resolves to) can change at any time, and the set of known profiles
  // can also change, so watch the global storage file used to track both of
  // those and re-subscribe whenever it changes.
  const globalStoragePath = getGlobalStoragePath(context);
  const profileWatcher = createFileWatcher(globalStoragePath);
  profileWatcher.onDidChange(resubscribe);
  profileWatcher.onDidCreate(resubscribe);
  profileWatcher.onDidDelete(resubscribe);

  context.subscriptions.push(configWatcher, profileWatcher, {
    dispose: () => {
      for (const watcher of parentWatchers) {
        watcher.dispose();
      }
    },
  });
}
