import * as vscode from "vscode";
import { updateCurrentProfileInheritance, removeCurrentProfileInheritedSettings, updateInheritedSettingsOnProfileChange } from "./profiles";

/**
 * Applies the inherited settings to the current profile.
 */
async function applyInheritedSettings() {
    await updateCurrentProfileInheritance();
}

/**
 * Removes the inherited settings from the current profile.
 */
async function removeInheritedSettings() {
    await removeCurrentProfileInheritedSettings();
}

export async function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand("inherit-profile.applyInheritanceToCurrentProfile", async () => {
            await applyInheritedSettings();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("inherit-profile.removeInheritedSettingsFromCurrentProfile", async () => {
            await removeInheritedSettings();
        })
    );

    // Apply on startup:
    const config = vscode.workspace.getConfiguration("inheritProfile");
    if (config.get<boolean>("runOnStartup", true)) {
        await applyInheritedSettings();
    }

    // Apply on profile change:
    if (config.get<boolean>("runOnProfileChange", true)) {
        await updateInheritedSettingsOnProfileChange(context);
    }
}

export function deactivate() { }
