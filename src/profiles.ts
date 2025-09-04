import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { parse } from "jsonc-parser";

/**
 * @returns The user directory.
 */
function getUserDirectory(): string {
    // TODO: There is likely a better way of doing this
    if (process.platform === "win32") {
        return path.join(process.env.APPDATA || "", "Code", "User");
    } else if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
    } else {
        return path.join(os.homedir(), ".config", "Code", "User");
    }
}

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

function getGlobalStoragePath(userDirectory: string): string {
    return path.join(userDirectory, "globalStorage/storage.json");
}

/**
 * Reads the global storage JSON file.
 * 
 * This contains a lot of useful information about profiles.
 * @param userDirectory Path to the user directory.
 * @returns Returns the contents of the global storage JSON file.
 */
async function readGlobalStorage(userDirectory: string): Promise<any> {
    const storagePath: string = getGlobalStoragePath(userDirectory);
    return await readJSON(storagePath);
}

/**
 * Extracts the custom profiles section from the global storage JSON file.
 * 
 * This is useful for finding out the names and paths of the user created
 * profiles.
 * @param userDirectory Path to the user directory.
 * @returns Returns the contents of the `userDataProfiles` filed from the global
 * storage JSON file.
 */
async function getCustomProfiles(userDirectory: string): Promise<any[]> {
    const storage = await readGlobalStorage(userDirectory);
    return storage.userDataProfiles ?? [];
}

/**
 * Gets the current profile name.
 * @param userDirectory Path to the user directory.
 * @returns Returns the name of the current profile.
 */
async function getCurrentProfileName(userDirectory: string): Promise<string> {
    const storage = await readGlobalStorage(userDirectory);
    const preferencesItems = storage.lastKnownMenubarData.menus.Preferences.items;
    for (const preferencesItem of preferencesItems) {
        const id = preferencesItem.id;
        if (id === "submenuitem.Profiles") {
            const submenuItems = preferencesItem.submenu.items;
            for (const submenuItem of submenuItems) {
                if (submenuItem.checked) {
                    return submenuItem.label;
                }
            }
        }
    }
    return "Default";
}

/**
 * Finds each of the profiles in the user directory and returns a mapping from
 * the profile name to the profile directory.
 * @param userDirectory Path to the user directory.
 * @returns A mapping from profile name to the directory for the profile.
 */
async function getProfileMap(userDirectory: string): Promise<Record<string, string>> {
    const map: Record<string, string> = {};

    // Add the default profile:
    // NOTE: The default profile always exists in the user directory.
    map["Default"] = userDirectory;

    // Add the custom profiles:
    let customProfiles: any[] = await getCustomProfiles(userDirectory);
    for (const profile of customProfiles) {
        if (profile.name && profile.location) {
            map[profile.name] = path.join(userDirectory, "profiles", profile.location);
        }
    }

    return map;
}

/**
 * Recursively flattens settings into a single record that maps the setting key
 * to its value.
 * @param settings Settings to flatten.
 * @param parentKey Parent key from previous iteration.
 * @param result Flattened result to return.
 * @returns Returns the flattened result.
 */
function flattenSettings(
    settings: Record<string, any>,
    parentKey = "",
    result: Record<string, any> = {}
): Record<string, any> {
    for (const [key, value] of Object.entries(settings)) {
        const newKey = parentKey ? `${parentKey}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) {
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
 *
 * result = { "editor.fontSize": "16", "files.autoSave": "off" }
 */
function mergeFlattenedSettings(
    target: Record<string, string>,
    source: Record<string, string>
): Record<string, string> {
    return { ...target, ...source };
}


/**
 * Collects the settings for each of the profiles.
 * 
 * This function will start with the first profile in the list. This function
 * will override properties that are redefined in profiles that appear towards
 * the end of the list.
 * @param profiles List of profiles to collect settings for.
 * @returns Flattened settings from the provided profiles.
 */
async function getProfileSettings(userDirectory: string, profiles: string[]): Promise<Record<string, string>> {
    const profileMap: Record<string, string> = await getProfileMap(userDirectory);
    var settings: Record<string, string> = {};
    console.debug(`Collecting settings from ${profiles.length} different profiles.`);
    for (const profileName of profiles) {
        const profilePath = profileMap[profileName];
        if (!profilePath) {
            console.warn(`Failed to collect settings for profile ${profileName}: Profile does not exist.`);
            continue;
        }
        const settingsPath = path.join(profilePath, "settings.json");
        // TODO: We could also collect extensions here

        const profileSettings = flattenSettings(await readJSON(settingsPath));
        console.debug(`Found ${Object.keys(profileSettings).length} settings from \`${settingsPath}\`.`);
        settings = mergeFlattenedSettings(settings, profileSettings);
        console.debug(`Merged ${settingsPath} into collected settings. Current total settings ${Object.keys(settings).length}.`);
    }
    return flattenSettings(settings);
}

/**
 * Gets the settings for the current profile.
 * @param userDirectory Path to the user directory.
 * @returns Returns the flattened settings for the current profile.
 */
async function getCurrentProfileSettings(userDirectory: string): Promise<Record<string, string>> {
    const currentProfileName = await getCurrentProfileName(userDirectory);
    return flattenSettings(await getProfileSettings(userDirectory, [currentProfileName]));
}

/**
 * Subtracts one set of settings from another.
 * @param base Base settings.
 * @param toRemove Settings to remove from the base.
 * @returns 
 */
function subtractSettings(
    base: Record<string, string>,
    toRemove: Record<string, string>
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (!(key in toRemove)) {
        result[key] = value;
        }
    }
    return result;
}

/**
 * Gets the settings that are missing from the current profile.
 * @param userDirectory Path to the user directory.
 * @returns Returns the flattened settings that are missing from the current profile.
 */
async function getInheritedSettings(userDirectory: string): Promise<Record<string, string>> {
    const currentProfileSettings = await getCurrentProfileSettings(userDirectory);
    console.info(`Found ${Object.keys(currentProfileSettings).length} settings in current profile.`);

    const config = vscode.workspace.getConfiguration("inheritProfile");
    const parentProfiles = config.get<string[]>("parents", []);
    const parentProfileSettings = await getProfileSettings(userDirectory, parentProfiles);
    console.info(`Found ${Object.keys(parentProfileSettings).length} settings in parent profiles.`);

    const inheritedSettings = subtractSettings(parentProfileSettings, currentProfileSettings);
    console.info(`Found ${Object.keys(inheritedSettings).length} inherited in from parent profiles.`);
    return inheritedSettings;
}

const INHERITED_SETTINGS_START_MARKER = "// --- INHERITED SETTINGS MARKER START --- //";
const INHERITED_SETTINGS_END_MARKER = "// --- INHERITED SETTINGS MARKER END --- //";

/**
 * Removes the inherited settings block (including the markers) from a settings file.
 * If no markers are found, the file is left unchanged.
 */
async function removeInheritedSettingsFromFile(settingsPath: string): Promise<void> {
    console.info(`Removing inherited settings from \`${settingsPath}\`.`);
    let raw = "";
    try {
        raw = await fs.readFile(settingsPath, "utf8");
    } catch {
        return; // nothing to do if file doesn't exist
    }

    const startIndex = raw.indexOf(INHERITED_SETTINGS_START_MARKER);
    const endIndex = raw.indexOf(INHERITED_SETTINGS_END_MARKER);

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        return; // markers not found, leave file alone
    }

    // Keep everything before start marker
    let cleaned = raw.slice(0, startIndex).trimEnd();

    // Ensure the JSON ends properly
    if (!cleaned.endsWith("}")) {
        cleaned = cleaned.replace(/,+\s*$/, ""); // remove trailing comma
        cleaned += "\n}";
    }

    await fs.writeFile(settingsPath, cleaned + "\n", "utf8");
}

/**
 * Writes a set of inherited settings to a settings path.
 * It will replace everything between the START and END markers.
 * If the markers don't exist, they will be added before the closing brace.
 */
async function writeInheritedSettings(
    settingsPath: string,
    flattened: Record<string, any>
): Promise<void> {
    let raw = "";
    try {
        raw = await fs.readFile(settingsPath, "utf8");
    } catch {
        raw = "{\n}\n"; // new file if missing
    }

    let beforeMarker: string;

    if (raw.includes(INHERITED_SETTINGS_START_MARKER)) {
        // Strip out the old block (everything between start and end markers)
        const startIndex = raw.indexOf(INHERITED_SETTINGS_START_MARKER);
        const endIndex = raw.indexOf(INHERITED_SETTINGS_END_MARKER);
        if (endIndex !== -1) {
        beforeMarker = raw.slice(0, startIndex);
        } else {
        // no END marker — treat as before start
        beforeMarker = raw.slice(0, startIndex);
        }
    } else {
        // Remove final } so we can append marker block at the end
        beforeMarker = raw.replace(/\}\s*$/, "");
        if (!beforeMarker.trim().endsWith(",")) {
        beforeMarker = beforeMarker.trimEnd().replace(/,$/, "");
        if (!beforeMarker.trim().endsWith("{")) {
            beforeMarker += ",";
        }
        }
        beforeMarker += "\n";
    }

    // Build new block of inherited settings
    const newBlockLines = Object.entries(flattened).map(
        ([key, value]) => `    "${key}": ${JSON.stringify(value)}`
    );

    const newContent =
        beforeMarker +
        INHERITED_SETTINGS_START_MARKER +
        "\n" +
        newBlockLines.join(",\n") +
        "\n" +
        INHERITED_SETTINGS_END_MARKER +
        "\n}\n";

    await fs.writeFile(settingsPath, newContent, "utf8");
}

/**
 * Applies the inherited settings to the current profile.
 * @param userDirectory Path to the user directory.
 */
async function applyInheritedSettings(userDirectory: string): Promise<void> {
    // Get the path to the current profile settings:
    const currentProfileName = await getCurrentProfileName(userDirectory);
    const profiles = await getProfileMap(userDirectory);
    const currentProfilePath = path.join(profiles[currentProfileName], "settings.json");

    // Remove the inherited settings from the current profile:
    removeInheritedSettingsFromFile(currentProfilePath);

    // Get the settings that the current profile should inherit:
    const inheritedSettings = await getInheritedSettings(userDirectory);
    const totalInheritedSettings = Object.keys(inheritedSettings).length;
    console.info(`Found ${totalInheritedSettings} inherited settings for \`${currentProfileName}\` profile.`);
    if (totalInheritedSettings === 0) {
        return;
    }
    
    // Add the inherited settings to the end of the profile:
    console.info(`Merging ${totalInheritedSettings} settings into \`${currentProfilePath}\`.`);
    await writeInheritedSettings(currentProfilePath, inheritedSettings);
}

/**
 * Updates the inherited settings for the current profile.
 */
export async function updateCurrentProfileInheritance(): Promise<void> {
    const userDirectory = getUserDirectory();
    await applyInheritedSettings(userDirectory);

    const config = vscode.workspace.getConfiguration("inheritProfile");
    if (config.get<boolean>("showMessages", true)) {
        vscode.window.showInformationMessage("Inherited profile settings applied!");
    }
}

export async function removeCurrentProfileInheritedSettings(): Promise<void> {
    const userDirectory = getUserDirectory();
    const currentProfileName = await getCurrentProfileName(userDirectory);
    const profiles = await getProfileMap(userDirectory);
    const currentProfilePath = path.join(profiles[currentProfileName], "settings.json");
    await removeInheritedSettingsFromFile(currentProfilePath);

    const config = vscode.workspace.getConfiguration("inheritProfile");
    if (config.get<boolean>("showMessages", true)) {
        vscode.window.showInformationMessage("Inherited settings remove from current profile!");
    }
}

/**
 * Updates the inherited settings when the profile changes.
 */
export async function updateInheritedSettingsOnProfileChange(context: vscode.ExtensionContext) {
    const userDirectory = getUserDirectory();
    const globalStoragePath = getGlobalStoragePath(userDirectory);
    let currentProfile = await getCurrentProfileName(userDirectory);

    const watcher = vscode.workspace.createFileSystemWatcher(globalStoragePath);
    const onChange = async () => {
        const newProfileName = await getCurrentProfileName(userDirectory);
        if (newProfileName !== currentProfile) {
            currentProfile = newProfileName;
            console.info("Current profile has changed, updating inherited settings...");
            await updateCurrentProfileInheritance();
        }
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);

    context.subscriptions.push(watcher);
}