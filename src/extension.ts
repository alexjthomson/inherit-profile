/**
 * =============================================================================
 * inherit-profile-plus — 扩展入口点
 * =============================================================================
 *
 * 用途（Purpose）:
 *   VS Code 扩展的入口文件。负责注册命令、启动时自动触发继承同步、
 *   监听 Profile 切换事件并同步、跨设备标记恢复。
 *
 * 工作机制（How it works）:
 *   1. activate() 在扩展加载时被 VS Code 调用
 *   2. 注册五个命令：
 *      - inherit-profile.applyInheritanceToCurrentProfile — 应用继承
 *      - inherit-profile.removeInheritedSettingsFromCurrentProfile — 移除继承
 *      - inherit-profile.setParentProfiles — 设置父级
 *      - inherit-profile.showInheritanceTree — 展示继承树
 *      - inherit-profile.forceReconcile — 全量重建
 *   3. 注册 setKeysForSync 用于跨设备同步
 *   4. 尝试从 globalState 恢复扩展标记（跨设备同步后标记可能丢失）
 *   5. 根据配置启动各类监听器
 *
 * 依赖关系（Dependencies）:
 *   - import { ... } from "./profiles" — 核心继承逻辑
 *   - import { ... } from "./profileWatchers" — 文件监听
 *
 * 对外提供的命令（Exports / Commands）:
 *   - inherit-profile.applyInheritanceToCurrentProfile
 *   - inherit-profile.removeInheritedSettingsFromCurrentProfile
 *   - inherit-profile.setParentProfiles
 *   - inherit-profile.showInheritanceTree
 *   - inherit-profile.forceReconcile
 *
 * 函数列表（Functions）:
 *   - activate(context)              [export][async] 扩展激活入口：注册命令、恢复标记、启动监听
 *   - deactivate()                   [export] 扩展停用入口（空实现）
 *   - checkAndRestoreMarkers(context) [async] 启动时检查 extension 标记是否丢失，
 *                                              尝试从 globalState 恢复
 */

import * as vscode from "vscode";
import * as path from "path";
import { updateCurrentProfileInheritance, removeCurrentProfileInheritedSettings, invalidateInheritanceGraph, isManagedFileSelfWrite, writeManagedFile, readJSON, getCurrentProfileDetails, showInheritanceTree, reconcileAllProfiles, getInheritanceGraph, getDescendants, writeParentProfiles, readParentProfiles } from "./profiles";
import { updateInheritedSettingsOnProfileChange, registerCurrentProfileSaveWatcher, registerParentProfileSaveWatcher } from "./profileWatchers";

export async function activate(context: vscode.ExtensionContext) {
  // 1. 注册命令 (同现有)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "inherit-profile.applyInheritanceToCurrentProfile",
      () => updateCurrentProfileInheritance(context)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "inherit-profile.removeInheritedSettingsFromCurrentProfile",
      () => removeCurrentProfileInheritedSettings(context)
    )
  );

  // 2. 设置父级命令
  context.subscriptions.push(
    vscode.commands.registerCommand("inherit-profile.setParentProfiles", async () => {
      try {
        const { currentProfileName, profiles } =
          await getCurrentProfileDetails(context);
        const graph = getInheritanceGraph(profiles);
        const descendants = getDescendants(currentProfileName, graph);
        const exclude = new Set([currentProfileName, ...descendants]);

        // 直接从文件读取当前 parents (不走 VS Code 设置 API，避免缓存不一致)
        const currentParents = new Set(await readParentProfiles(context));

        const items = Object.keys(profiles)
          .filter((p) => !exclude.has(p))
          .map((p) => ({
            label: p,
            picked: currentParents.has(p),
          }));

        const selected = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: "Select parent profiles (current and descendants excluded)",
          title: `Set Parent Profiles for ${currentProfileName}`,
        });

        if (!selected) return;
        const parentNames = selected.map((s) => s.label);
        await writeParentProfiles(context, parentNames);
        await reconcileAllProfiles(context);
        vscode.window.showInformationMessage(
          `Parents updated for ${currentProfileName}. Full reconciliation done.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to set parent profiles: ${(err as Error)?.message ?? err}`,
        );
      }
    }),
  );

  // 4. 展示继承树命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "inherit-profile.showInheritanceTree",
      () => showInheritanceTree(context),
    )
  );

  // 5. 强制全量对账命令 (从根 Profile 开始逐级重建全部)
  context.subscriptions.push(
    vscode.commands.registerCommand("inherit-profile.forceReconcile", async () => {
      await reconcileAllProfiles(context);
      if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("showMessages", true)) {
        vscode.window.showInformationMessage("Full profile reconciliation complete!");
      }
    })
  );

  // 6. 注册 setKeysForSync (固定 key, 跨设备同步)
  context.globalState.setKeysForSync([
    "inheritProfile.extensionMarkers",
    "inheritProfile.parentSnapshots",
  ]);

  // 7. 尝试从 globalState 恢复扩展标记（跨设备同步后标记可能丢失）。
  //    仅恢复标记, 不触发全量对账——由步骤 9 统一完成。
  await checkAndRestoreMarkers(context);

  // 8. 版本检测: inherit-profile 自身版本变化时触发全量重建
  const currentVersion = context.extension.packageJSON.version as string;
  const lastVersion = context.globalState.get<string>("inheritProfile.lastVersion");
  if (currentVersion && lastVersion !== currentVersion) {
    console.info(
      `Version changed from ${lastVersion ?? "(none)"} to ${currentVersion}. Triggering full reconciliation.`,
    );
    await reconcileAllProfiles(context);
    void context.globalState.update("inheritProfile.lastVersion", currentVersion);
  }

  // 9. 启动时运行 (同现有)
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnStartup", true)) {
    updateCurrentProfileInheritance(context);
  }

  // 10. Profile/配置变更时
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnProfileChange", true)) {
    updateInheritedSettingsOnProfileChange(context);
  }

  // 11. 当前 profile 保存时
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnCurrentProfileSave", true)) {
    registerCurrentProfileSaveWatcher(context);
  }

  // 12. 父级 profile 保存时
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnParentProfileSave", true)) {
    registerParentProfileSaveWatcher(context);
  }
}

/**
 * 在启动时检查 extension 标记是否丢失，尝试从 globalState 恢复。
 * extensionMarkers 结构: Record<profileName, Record<extId, parentName>>
 */
async function checkAndRestoreMarkers(context: vscode.ExtensionContext): Promise<void> {
  let currentProfileDirectory: string;
  let currentProfileName: string;
  try {
    const details = await getCurrentProfileDetails(context);
    currentProfileName = details.currentProfileName;
    currentProfileDirectory = details.currentProfileDirectory;
  } catch {
    // 首次启动时 storage.json 可能尚未就绪, 跳过恢复
    return;
  }

  const extPath = path.join(currentProfileDirectory, "extensions.json");
  const extsRaw = await readJSON(extPath);
  const exts = Array.isArray(extsRaw) ? extsRaw : [];

  const hasMarkers = exts.some(
    (e: any) => e?.metadata?.inheritProfile?.inherited
  );

  if (!hasMarkers) {
    const backup = context.globalState.get<
      Record<string, Record<string, string>>
    >("inheritProfile.extensionMarkers");
    const markers = backup?.[currentProfileName];
    if (markers) {
      console.info("Restoring extension markers from globalState backup...");
      const updated = exts.map((ext: any) => {
        const id = ext?.identifier?.id;
        if (id && markers[id]) {
          return {
            ...ext,
            metadata: {
              ...(ext.metadata ?? {}),
              inheritProfile: { inherited: true },
            },
          };
        }
        return ext;
      });
      // 使用 writeManagedFile 而非直接 fs.writeFile, 确保 selfWriteTracker 记录
      // 防止文件 watcher 将此恢复误判为用户编辑而再次触发对账
      await writeManagedFile(extPath, JSON.stringify(updated, null, 4) + "\n");
      console.info("Extension markers restored from globalState.");
    } else {
      // 无备份也无标记 → 由 activate 中 runOnStartup 的同步流程处理
      console.info(
        "No globalState backup found. Full reconciliation will be performed " +
        "by the startup sync (runOnStartup)."
      );
    }
  }
}

export function deactivate() { }
