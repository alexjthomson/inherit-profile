import * as vscode from "vscode";
import * as path from "path";
import { createDebouncedTrigger } from "./debounce";
import { resolveParentSettingsPaths } from "./profileSettings";
import {
  getCurrentProfileDetails,
  getCurrentProfileName,
  getGlobalStoragePath,
  getProfileMap,
  isManagedFileSelfWrite,
  readRawSettingsFile,
  updateCurrentProfileInheritance,
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
 * Watches each parent profile's `settings.json` file (as configured via
 * `inheritProfile.parents`) and re-applies inheritance to the current
 * profile whenever any of them changes.
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
  const scheduleReapply = createDebouncedTrigger(() =>
    updateCurrentProfileInheritance(context),
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

    const parentSettingsPaths = resolveParentSettingsPaths(
      parentProfileNames,
      profiles,
    );
    for (const settingsPath of parentSettingsPaths) {
      const watcher = createFileWatcher(settingsPath);
      watcher.onDidChange(scheduleReapply);
      watcher.onDidCreate(scheduleReapply);
      watcher.onDidDelete(scheduleReapply);
      parentWatchers.push(watcher);
    }
  };

  await resubscribe();

  // Re-subscribe whenever the configured list of parent profiles changes.
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("inheritProfile.parents")) {
      void resubscribe();
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
