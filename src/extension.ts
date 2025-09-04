import * as vscode from "vscode";
import { updateCurrentProfileInheritance } from "./profiles";

/**
 * Applies the inherited settings to the current profile.
 */
async function applyInheritedSettings() {
    await updateCurrentProfileInheritance();
    vscode.window.showInformationMessage("Inherited profile settings applied!");
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand("inherit-profile.applyInheritance", async () => {
            await applyInheritedSettings();
        })
    );

    // Optionally run on startup:
    // applyInheritedSettings();
}

export function deactivate() { }
