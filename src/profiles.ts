import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

/**
 * @returns The user directory.
 */
export function getUserDir(): string {
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
 * Reads JSON.
 * @param filePath Path to the JSON file.
 * @returns Read JSON.
 */
export async function readJSON(filePath: string): Promise<any> {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

/**
 * Reads the global storage JSON file.
 * 
 * This contains a lot of useful information about profiles.
 * @param userDirectory Path to the user directory.
 * @returns Returns the contents of the global storage JSON file.
 */
export async function readGlobalStorage(userDirectory: string): Promise<any> {
    const storagePath: string = path.join(userDirectory, "globalStorage/storage.json");
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
export async function getCustomProfiles(userDirectory: string): Promise<any[]> {
    const storage = await readGlobalStorage(userDirectory);
    return storage.userDataProfiles ?? [];
}

/**
 * Gets the current profile name.
 * @param userDirectory Path to the user directory.
 * @returns Returns the name of the current profile.
 */
export async function getCurrentProfileName(userDirectory: string): Promise<string> {
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
export async function getProfileMap(userDirectory: string): Promise<Record<string, string>> {
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
 * Completes a deep merge of settings from a source into a target.
 * @param target Target settings to merge into.
 * @param source Source settings to merge into the target..
 * @returns Returns the source settings merged deeply into the target settings.
 */
export function deepMergeSettings(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key])
        ) {
            if (!target[key] || typeof target[key] !== "object") {
                target[key] = {};
            }
            deepMergeSettings(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
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
export async function getProfileSettings(userDirectory: string, profiles: string[]): Promise<Record<string, string>> {
    const profileMap: Record<string, string> = await getProfileMap(userDirectory);
    const settings: Record<string, any> = {};
    for (const profileName of profiles) {
        const profilePath = profileMap[profileName];
        if (!profilePath) {
            console.warn(`Failed to collect settings for profile ${profileName}: Profile does not exist.`);
            continue;
        }
        const settingsPath = path.join(profilePath, "settings.json");
        // TODO: We could also collect extensions here

        const profileSettings = readJSON(settingsPath);
        deepMergeSettings(settings, profileSettings);
    }
    return settings;
}

/**
 * Recursively flattens settings into a single record that maps the setting key
 * to its value.
 * @param settings Settings to flatten.
 * @param parentKey Parent key from previous iteration.
 * @param result Flattened result to return.
 * @returns Returns the flattened result.
 */
export function flattenSettings(
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
 * Gets the settings for the current profile.
 * @param userDirectory Path to the user directory.
 * @returns Returns the flattened settings for the current profile.
 */
export async function getCurrentProfileSettings(userDirectory: string): Promise<Record<string, string>> {
    const currentProfileName = await getCurrentProfileName(userDirectory);
    return flattenSettings(await getProfileSettings(userDirectory, [currentProfileName]));
}

/**
 * Subtracts one set of settings from another.
 * @param base Base settings.
 * @param toRemove Settings to remove from the base.
 * @returns 
 */
export function subtractSettings(
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
export async function getInheritedSettings(userDirectory: string): Promise<Record<string, string>> {
    const currentProfileSettings = await getCurrentProfileSettings(userDirectory);

    const config = vscode.workspace.getConfiguration("inheritProfile");
    const parentProfiles = config.get<string[]>("parents", []);
    const parentProfileSettings = await getProfileSettings(userDirectory, parentProfiles);

    const inheritedSettings = subtractSettings(parentProfileSettings, currentProfileSettings);
    return inheritedSettings;
}

export const INHERITED_SETTINGS_MARKER = "// --- INHERITED SETTINGS MARKER --- //";

/**
 * Writes a set of inherited settings to a settings path.
 * @param settingsPath Path to the JSON settings.
 * @param flattened Flattened settings to write.
 */
export async function writeInheritedSettings(
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
    if (raw.includes(INHERITED_SETTINGS_MARKER)) {
        // Split at marker, keep only the part before it
        [beforeMarker] = raw.split(INHERITED_SETTINGS_MARKER, 1);
    } else {
        // Remove final } so we can append marker at the end
        beforeMarker = raw.replace(/\}\s*$/, "");
        if (!beforeMarker.trim().endsWith(",")) {
        beforeMarker = beforeMarker.trimEnd().replace(/,$/, "");
        if (!beforeMarker.trim().endsWith("{")) {
            beforeMarker += ",";
        }
        }
        beforeMarker += "\n";
    }

    // Build new block
    const newBlockLines = Object.entries(flattened).map(
        ([key, value]) => `  "${key}": ${JSON.stringify(value)}`
    );

    const newContent =
        beforeMarker +
        INHERITED_SETTINGS_MARKER +
        "\n" +
        newBlockLines.join(",\n") +
        "\n}\n";

    await fs.writeFile(settingsPath, newContent, "utf8");
}

/**
 * Applies the inherited settings to the current profile.
 * @param userDirectory Path to the user directory.
 */
export async function applyInheritedSettings(userDirectory: string): Promise<void> {
    // Get the path to the current profile settings:
    const currentProfileName = await getCurrentProfileName(userDirectory);
    const profiles = await getProfileMap(userDirectory);
    const currentProfilePath = path.join(profiles[currentProfileName], "settings.json");

    // Get the settings that the current profile should inherit:
    const inheritedSettings = await getInheritedSettings(userDirectory);
    
    // Add the inherited settings to the end of the profile:
    await writeInheritedSettings(currentProfilePath, inheritedSettings);
}

/**
 * Updates the inherited settings for the current profile.
 */
export async function updateCurrentProfileInheritance(): Promise<void> {
    const userDirectory = getUserDir();
    await applyInheritedSettings(userDirectory);
}