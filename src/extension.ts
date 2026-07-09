import * as vscode from "vscode";
import { updateCurrentProfileInheritance, removeCurrentProfileInheritedSettings, updateInheritedSettingsOnProfileChange, registerCurrentProfileSaveWatcher } from "./profiles";

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
}

export function deactivate() { }
