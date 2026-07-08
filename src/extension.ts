/**
 * =============================================================================
 * inherit-profile-plus — Extension Entry Point
 * =============================================================================
 *
 * 用途（Purpose）:
 *   VS Code 扩展的入口文件。负责注册命令、启动时自动触发继承同步、
 *   监听 Profile 切换事件并同步。
 *
 * 工作机制（How it works）:
 *   1. `activate()` 在扩展加载时被 VS Code 调用
 *   2. 注册两个命令（见下方 Exports）
 *   3. 若 `inheritProfile.runOnStartup` 为 true，启动时立即同步一次
 *   4. 若 `inheritProfile.runOnProfileChange` 为 true，监听 storage.json
 *      文件变化，检测 Profile 切换后自动同步
 *
 * 依赖关系（Dependencies）:
 *   - import { updateCurrentProfileInheritance } from "./profiles"
 *     → 核心函数：执行设置 + 扩展的继承同步
 *   - import { removeCurrentProfileInheritedSettings } from "./profiles"
 *     → 清除当前 Profile 的所有继承内容
 *   - import { updateInheritedSettingsOnProfileChange } from "./profiles"
 *     → 启动 storage.json 文件监听
 *
 * 对外提供的命令（Exports / Commands）:
 *   - `inherit-profile.applyInheritanceToCurrentProfile` (命令)
 *     手动触发当前 Profile 的继承同步
 *   - `inherit-profile.removeInheritedSettingsFromCurrentProfile` (命令)
 *     手动清除当前 Profile 中的所有继承内容
 *
 * 函数列表（Functions）:
 *   - activate(context)              [export] 扩展激活入口
 *   - deactivate()                   [export] 扩展停用入口
 */

import * as vscode from "vscode";
import { updateCurrentProfileInheritance, removeCurrentProfileInheritedSettings } from "./profiles";
import { updateInheritedSettingsOnProfileChange, registerCurrentProfileSaveWatcher, registerParentProfileSaveWatcher } from "./profileWatchers";

export async function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand("inherit-profile.applyInheritanceToCurrentProfile", async () => {
            await updateCurrentProfileInheritance(context);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("inherit-profile.removeInheritedSettingsFromCurrentProfile", async () => {
            await removeCurrentProfileInheritedSettings(context);
        })
    );

    // Apply on startup:
    const config = vscode.workspace.getConfiguration("inheritProfile");
    if (config.get<boolean>("runOnStartup", true)) {
        await updateCurrentProfileInheritance(context);
    }

    // Apply on profile change:
    if (config.get<boolean>("runOnProfileChange", true)) {
        await updateInheritedSettingsOnProfileChange(context);
    }

    // Apply when the current profile's settings are saved:
    if (config.get<boolean>("runOnCurrentProfileSave", true)) {
        await registerCurrentProfileSaveWatcher(context);
    }

    // Apply when one of the parent profiles' settings are saved:
    if (config.get<boolean>("runOnParentProfileSave", true)) {
        await registerParentProfileSaveWatcher(context);
    }
}

export function deactivate() { }
