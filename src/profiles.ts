import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { parse } from "jsonc-parser";
import {
  buildInheritedSettingsBlock,
  findTabValue,
  flattenSettings,
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_START_MARKER,
  insertBeforeClose,
  mergeFlattenedSettings,
  removeInsertionBoundarySetting,
  removeTrailingComma,
  sortSettings,
  splitRawSettingsByClosingBrace,
  stripManagedProfileSettings,
  subtractSettings,
} from "./profileSettings";

/**
 * Reads JSONC (JSON with comments).
 * @param filePath Path to the JSON/JSONC file.
 * @returns Parsed object or {} on error.
 */
export async function readJSON(filePath: string): Promise<any> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parse(raw); // handles // and /* */ comments
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
function getGlobalStoragePath(context: vscode.ExtensionContext): string {
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
async function getCurrentProfileName(
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
    if (emptyWindows && Object.prototype.hasOwnProperty.call(emptyWindows, backupFolderId)) {
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
async function getProfileMap(
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
async function getCurrentProfileDetails(
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
  await fs.writeFile(settingsPath, cleaned + "\n", "utf8");
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
  await fs.writeFile(settingsPath, finalSettings, "utf8");
}

/**
 * Reads and returns a raw `settings.json` file.
 */
async function readRawSettingsFile(settingsPath: string): Promise<string> {
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

  const currentExtensionsPath = path.join(
    currentProfileDirectory,
    "extensions.json",
  );
  const parsedCurrentExtensions = await readJSON(currentExtensionsPath);
  const currentExtensions = Array.isArray(parsedCurrentExtensions)
    ? parsedCurrentExtensions
    : [];
  // Collect and write inherited extensions
  const finalExtensions = await collectInheritedExtensions(
    currentExtensions,
    profiles,
  );
  if (JSON.stringify(finalExtensions) !== JSON.stringify(currentExtensions)) {
    console.info(
      `Writing ${finalExtensions.length} extensions to \`${currentExtensionsPath}\`.`,
    );
    await fs.writeFile(
      currentExtensionsPath,
      JSON.stringify(finalExtensions, null, 4) + "\n",
      "utf8",
    );
  }
}

/**
 * Collect extensions from parent profiles, merge with current profile extensions,
 * and mark inherited extensions in their metadata.
 *
 * @param currentExtensions The parsed extensions array from the current profile.
 * @param profiles A map of profile names to their directory paths.
 * @returns The final extensions array to write back to the current profile.
 */
async function collectInheritedExtensions(
  currentExtensions: any[],
  profiles: Record<string, string>,
): Promise<any[]> {
  // Remove inherited extensions from the current profile, and convert to a map of id -> extension
  // Inherited extensions have the field `inheritedFromProfile` in their `metadata` object.
  const filteredExtensions = currentExtensions.filter((ext: any) => {
    return !ext?.metadata?.inheritedFromProfile;
  });
  const extensionMap: Record<string, any> = {};
  for (const ext of filteredExtensions) {
    if (ext?.identifier?.id) {
      extensionMap[ext.identifier.id] = ext;
    }
  }

  // Get the list of parent profiles:
  const config = vscode.workspace.getConfiguration("inheritProfile");
  const parentProfiles = config.get<string[]>("parents", []);
  console.info(
    `Collecting extensions from ${parentProfiles.length} parent profiles.`,
  );

  // Collect extensions from each of the parent profiles:
  for (const profileName of parentProfiles) {
    const profileDirectory = profiles[profileName];
    if (!profileDirectory) {
      console.warn(
        `Failed to collect extensions for profile ${profileName}: Profile does not exist.`,
      );
      continue;
    }
    const extensionsPath = path.join(profileDirectory, "extensions.json");
    const rawProfileExtensions = await readJSON(extensionsPath);
    const profileExtensions = Array.isArray(rawProfileExtensions)
      ? rawProfileExtensions
      : [];
    console.info(
      `Found ${profileExtensions.length} extensions in \`${profileName}\`.`,
    );

    for (const ext of profileExtensions) {
      // Add extension if it does not already exist:
      const id = ext?.identifier?.id;
      if (id && !(id in extensionMap)) {
        // Mark the extension as inherited:
        if (!ext.metadata) {
          ext.metadata = {};
        }
        ext.metadata.inheritedFromProfile = profileName;

        extensionMap[id] = ext;
        console.info(
          `Inheriting extension \`${id}\` from profile \`${profileName}\`.`,
        );
      }
    }
  }

  return Object.values(extensionMap);
}

/**
 * Updates the inherited settings for the current profile.
 * @param context Extension context.
 */
export async function updateCurrentProfileInheritance(
  context: vscode.ExtensionContext,
): Promise<void> {
  await applyInheritedSettings(context);

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("showMessages", true)) {
    vscode.window.showInformationMessage("Inherited profile settings applied!");
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
    const filteredExtensions = currentExtensions.filter((ext: any) => {
      return !ext?.metadata?.inheritedFromProfile;
    });
    // Only write if there was a change to avoid unnecessary fs writes
    if (filteredExtensions.length !== currentExtensions.length) {
      console.info(
        `Removing ${currentExtensions.length - filteredExtensions.length} inherited extensions from \`${currentExtensionsPath}\`.`,
      );
      await fs.writeFile(
        currentExtensionsPath,
        JSON.stringify(filteredExtensions, null, 4) + "\n",
        "utf8",
      );
    }
  } catch (err) {
    console.warn(
      `Failed to remove inherited extensions for profile \`${currentProfileName}\`:`,
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

/**
 * Updates the inherited settings when the profile changes.
 * @param context Extension context.
 */
export async function updateInheritedSettingsOnProfileChange(
  context: vscode.ExtensionContext,
) {
  const globalStoragePath = getGlobalStoragePath(context);
  let currentProfile = await getCurrentProfileName(context);

  const watcher = vscode.workspace.createFileSystemWatcher(globalStoragePath);
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
