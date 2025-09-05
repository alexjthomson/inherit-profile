import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { parse } from "jsonc-parser";

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
async function readGlobalStorage(context: vscode.ExtensionContext): Promise<any> {
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
async function getCustomProfiles(context: vscode.ExtensionContext): Promise<any[]> {
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
  value: unknown
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
        if (Object.prototype.hasOwnProperty.call(node, key) && (node as any)[key] === value) {
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
async function getCurrentProfileName(context: vscode.ExtensionContext): Promise<string> {
    const storage = await readGlobalStorage(context);
    const profilesSubMenu = findByKeyValuePair(storage, "id", "submenuitem.Profiles");
    if (profilesSubMenu) {
        const submenuItems = profilesSubMenu.submenu.items;
        for (const submenuItem of submenuItems) {
            if (submenuItem.checked) {
                const fullProfileId: string = submenuItem.id;
                const profileId = fullProfileId.substring(fullProfileId.lastIndexOf(".") + 1);
                const profileData = findByKeyValuePair(storage, "location", profileId);
                if (profileData) {
                    return profileData.name;
                }
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
async function getProfileMap(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    const userDirectory = getUserDirectory(context);

    // Add the default profile:
    // NOTE: The default profile always exists in the user directory.
    map["Default"] = userDirectory;

    // Add the custom profiles:
    let customProfiles: any[] = await getCustomProfiles(context);
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
 * @param context Extension context.
 * @param profiles List of profiles to collect settings for.
 * @returns Flattened settings from the provided profiles.
 */
async function getProfileSettings(context: vscode.ExtensionContext, profiles: string[]): Promise<Record<string, string>> {
    const profileMap: Record<string, string> = await getProfileMap(context);
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
 * @param context Extension context.
 * @returns Returns the flattened settings for the current profile.
 */
async function getCurrentProfileSettings(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const currentProfileName = await getCurrentProfileName(context);
    return flattenSettings(await getProfileSettings(context, [currentProfileName]));
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
 * Sorts a given set of `settings` alphabetically (A to Z).
 * @param settings Settings to sort alphabetically.
 * @returns Returns the `settings`, but sorted alphabetically (A to Z).
 */
function sortSettings(
    settings: Record<string, string>
): Record<string, string> {
    return Object.keys(settings)
        .sort((a, b) => a.localeCompare(b))
        .reduce<Record<string, string>>((acc, key) => {
            acc[key] = settings[key];
            return acc;
        }, {});
}

/**
 * Gets the settings that are missing from the current profile.
 * @param context Extension context.
 * @returns Returns the flattened settings that are missing from the current profile.
 */
async function getInheritedSettings(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const currentProfileSettings = await getCurrentProfileSettings(context);
    console.info(`Found ${Object.keys(currentProfileSettings).length} settings in current profile.`);

    const config = vscode.workspace.getConfiguration("inheritProfile");
    const parentProfiles = config.get<string[]>("parents", []);
    const parentProfileSettings = await getProfileSettings(context, parentProfiles);
    console.info(`Found ${Object.keys(parentProfileSettings).length} settings in parent profiles.`);

    const inheritedSettings = subtractSettings(parentProfileSettings, currentProfileSettings);
    console.info(`Found ${Object.keys(inheritedSettings).length} inherited in from parent profiles.`);

    const sortedInheritedSettings = sortSettings(inheritedSettings);
    return sortedInheritedSettings;
}

const INHERITED_SETTINGS_START_MARKER = "// --- INHERITED SETTINGS MARKER START --- //";
const INHERITED_SETTINGS_END_MARKER = "// --- INHERITED SETTINGS MARKER END --- //";

const WARNING_COMMENT = "// WARNING: Do not remove the inherited settings start and end markers.";
const WARNING_EXPLAIN = "//          The markers are used to identify inserted inherited settings.";

/**
 * Removes the inherited settings block (including the markers) from a settings
 * file.
 * 
 * If no markers are found, the file is left unchanged.
 */
async function removeInheritedSettingsFromFile(settingsPath: string): Promise<void> {
    console.info(`Removing inherited settings from \`${settingsPath}\`.`);

    // Find the start and end markers:
    let raw = await readRawSettingsFile(settingsPath);
    const startIndex = raw.indexOf(INHERITED_SETTINGS_START_MARKER);
    const endIndex = raw.indexOf(INHERITED_SETTINGS_END_MARKER);

    // Ensure the markers exist:
    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        if (startIndex !== endIndex) {
            console.warn("Either the start or end marker is missing in the current profile.");
        }
        return; // markers not found, leave file alone
    }

    // Clean response:
    const before = raw.slice(0, startIndex);
    const after = raw.slice(endIndex + INHERITED_SETTINGS_END_MARKER.length);
    let cleaned = (before.trimEnd() + after.trimEnd());

    // Ensure JSONC ends properly:
    cleaned = removeTrailingComma(cleaned);
    if (!cleaned.endsWith("}")) {
        cleaned += "\n}";
    }

    // Write cleaned file:
    await fs.writeFile(settingsPath, cleaned + "\n", "utf8");
}

/**
 * Removes the last trailing comma from a JSONC (JSON with Comments) string.
 * It correctly handles single-line, multi-line, and comments within strings.
 * A trailing comma is defined as a comma that is the last meaningful character,
 * or a comma that is the second-to-last meaningful character followed only by a
 * closing brace '}' or bracket ']'.
 *
 * @param text The JSONC content as a string.
 * @returns A new string with the trailing comma removed, or the original string if no trailing comma was found.
 */
function removeTrailingComma(text: string): string {
  let lastMeaningfulIndex = -1;
  let secondToLastMeaningfulIndex = -1;

  let inMultiLineComment = false;
  let inString = false;
  let stringChar = ''; // Can be ' or "

  // This loop is similar to getLastMeaningfulCharacterIndex, but tracks the last TWO meaningful characters.
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prevChar = text[i - 1];
    const nextChar = text[i + 1];

    // State 1: Inside a multi-line comment
    if (inMultiLineComment) {
      if (char === '*' && nextChar === '/') {
        inMultiLineComment = false;
        i++; // Consume the '/'
      }
      continue;
    }

    // State 2: Inside a string
    if (inString) {
      if (char === stringChar && prevChar !== '\\') {
        inString = false;
      }
      secondToLastMeaningfulIndex = lastMeaningfulIndex;
      lastMeaningfulIndex = i;
      continue;
    }

    // State 3: Default state (not in a comment or string)
    if (char === '/' && nextChar === '/') {
      const newlineIndex = text.indexOf('\n', i);
      if (newlineIndex === -1) {
        break; // End of file is a comment
      }
      i = newlineIndex;
      continue;
    }

    if (char === '/' && nextChar === '*') {
      inMultiLineComment = true;
      i++; // Consume the '*'
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      secondToLastMeaningfulIndex = lastMeaningfulIndex;
      lastMeaningfulIndex = i;
      continue;
    }

    if (!/\s/.test(char)) {
      secondToLastMeaningfulIndex = lastMeaningfulIndex;
      lastMeaningfulIndex = i;
    }
  }

  // After parsing, check if we found a trailing comma.
  if (lastMeaningfulIndex === -1) {
    return text; // No meaningful characters found.
  }

  const lastMeaningfulChar = text[lastMeaningfulIndex];

  // Case 1: The very last meaningful character is a comma.
  // e.g., { "a": 1, }
  if (lastMeaningfulChar === ',') {
    return text.slice(0, lastMeaningfulIndex) + text.slice(lastMeaningfulIndex + 1);
  }

  // Case 2: The last character is a brace/bracket, and the one before it is a comma.
  // e.g. { "a": 1, }
  if ((lastMeaningfulChar === '}' || lastMeaningfulChar === ']') && secondToLastMeaningfulIndex !== -1) {
    const secondToLastMeaningfulChar = text[secondToLastMeaningfulIndex];
    if (secondToLastMeaningfulChar === ',') {
      return text.slice(0, secondToLastMeaningfulIndex) + text.slice(secondToLastMeaningfulIndex + 1);
    }
  }

  // If neither of the above conditions are met, there's no trailing comma to remove.
  return text;
}

/**
 * Writes a set of inherited settings to a settings path.
 * 
 * IMPORTANT: This function assumes that there are no inherited settings in the
 * file. Any inherited settings should be removed before calling this function.
 */
async function writeInheritedSettings(
    settingsPath: string,
    flattened: Record<string, any>
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
    // Read the raw file:
    // NOTE: This will throw an exception if the file cannot be read.
    return await fs.readFile(settingsPath, "utf8");
}

/**
 * Returns the `raw file in two parts:
 * 1. The content before the closing brace (excluding the closing brace).
 * 2. The content after and including the closing brace.
 * 
 * @param raw Raw `settings.json` file.
 * @returns Returns `raw` in two parts: before, and after the closing brace.
 */
function splitRawSettingsByClosingBrace(raw: string): [beforeClose: string, afterClose: string] {
    // Split the file by the closing brace:
    let closingIndex = raw.lastIndexOf("}");
    if (closingIndex === -1) {
        return ["{\n", "}\n"];
    }

    const beforeClose = raw.slice(0, closingIndex);
    const afterClose = raw.slice(closingIndex);
    return [beforeClose, afterClose];
}

/**
 * Attempts to detect the tab string used in a JSON/JSONC file.
 * Returns either "\t" for tabs or a string of spaces (usually 2 or 4).
 * Defaults to 4 spaces if detection fails.
 */
function findTabValue(raw: string): string {
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
        // Skip empty lines and lines without leading whitespace:
        if (!line.trim()) {
            continue;
        }

        const match = line.match(/^( +|\t+)/);
        if (!match) {
            continue;
        }

        const indent = match[1];
        if (indent[0] === "\t") {
            return "\t"; // Tabs detected
        }

        // Spaces: measure run length
        return " ".repeat(indent.length);
    }

    // Fallback tab size:
    return "    ";
}

/**
 * Builds the inherited settings block with start, warning, entries, and end.
 * 
 * @param flattened Flattened settings to insert into the settings block.
 * @param tab Tab sequence to use.
 * @returns Returns the raw inherited settings block.
 */
function buildInheritedSettingsBlock(
    flattened: Record<string, string>,
    tab: string,
): string {
    const entries = Object.entries(flattened)
        .map(([key, value]) => `${tab}"${key}": ${JSON.stringify(value)}`)
        .join(",\n");

    return (
        tab + INHERITED_SETTINGS_START_MARKER + "\n" +
        tab + WARNING_COMMENT + "\n" +
        tab + WARNING_EXPLAIN + "\n" +
        entries + (entries ? "\n" : "") +
        tab + INHERITED_SETTINGS_END_MARKER + "\n"
    );
}

/**
 * Inserts block before closing brace, handling commas and trailing comments.
 * 
 * Does not remove or modify user comments.
 * 
 * @returns Returns a string starting with the `beforeClose` block, followed by
 * the `block`. The returned string is formatted JSONC without the final closing
 * bracket.
 */
function insertBeforeClose(
    beforeClose: string,
    block: string,
): string {
    // Check last non-comment character:
    const meaningfulCharIndex = getLastMeaningfulCharacterIndex(beforeClose);
    if (meaningfulCharIndex === -1) {
        console.warn("No meaningful text found when attempting to insert `block` after `beforeClose`.");
        return beforeClose.replace(/\s*$/, "\n") + block;
    }
    const meaningfulChar = beforeClose[meaningfulCharIndex];

    // Calculate if we should insert a comma after the last meaningful character
    // index:
    const needsComma =
        /\S/.test(beforeClose) &&
        meaningfulChar !== "{" &&
        meaningfulChar !== ",";

    // Exit early if we do not need to insert a comma:
    if (!needsComma) {
        return beforeClose.replace(/\s*$/, "\n") + block;
    }

    // Insert a comma after the last meaningful character:
    const before = beforeClose.slice(0, meaningfulCharIndex + 1);
    const after = beforeClose.slice(meaningfulCharIndex + 1);

    return before + "," + after.replace(/\s*$/, "\n") + block;
}

/**
 * Iterates through each line in a string, yielding [line, startIndex].
 * 
 * Handles both LF and CRLF endings.
 */
function* iterateLines(text: string): Generator<[string, number]> {
    let start = 0;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
            // Handle CRLF (\r\n)
            const line = text.slice(start, text[i - 1] === "\r" ? i - 1 : i);
            yield [line, start];
            start = i + 1;
        }
    }

    // Final line (if text doesn’t end with a newline)
    if (start <= text.length) {
        yield [text.slice(start), start];
    }
}

/**
 * Finds the index of the last meaningful character in a JSONC (JSON with Comments) string.
 * A "meaningful" character is one that is not part of a single-line or multi-line comment,
 * and is not whitespace. Characters within strings are considered meaningful.
 *
 * @param text The JSONC content as a string.
 * @returns The zero-based index of the last meaningful character, or -1 if none is found.
 */
function getLastMeaningfulCharacterIndex(text: string): number {
  let lastMeaningfulIndex = -1;
  let inMultiLineComment = false;
  let inString = false;
  let stringChar = ''; // Can be ' or "

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prevChar = text[i - 1];
    const nextChar = text[i + 1];

    // State 1: Inside a multi-line comment
    if (inMultiLineComment) {
      if (char === '*' && nextChar === '/') {
        inMultiLineComment = false;
        i++; // Consume the '/' as well
      }
      continue;
    }

    // State 2: Inside a string
    if (inString) {
      // Check for the closing quote, ensuring it's not escaped
      if (char === stringChar && prevChar !== '\\') {
        inString = false;
      }
      // All characters inside a string are considered meaningful for this function's purpose.
      lastMeaningfulIndex = i;
      continue;
    }

    // State 3: Default state (not in a comment or string)
    // Check for the start of a single-line comment
    if (char === '/' && nextChar === '/') {
      // Find the next newline character
      const newlineIndex = text.indexOf('\n', i);
      if (newlineIndex === -1) {
        // No more newlines, so the rest of the file is a comment.
        // We can stop processing.
        break;
      }
      // Jump execution to the newline character. The loop's i++ will move to the next line.
      i = newlineIndex;
      continue;
    }

    // Check for the start of a multi-line comment
    if (char === '/' && nextChar === '*') {
      inMultiLineComment = true;
      i++; // Consume the '*' as well
      continue;
    }

    // Check for the start of a string (handles both double and single quotes)
    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      lastMeaningfulIndex = i;
      continue;
    }

    // If we've reached this point, we are in a "normal" code context.
    // A character is meaningful if it's not whitespace.
    if (!/\s/.test(char)) {
      lastMeaningfulIndex = i;
    }
  }

  return lastMeaningfulIndex;
}

/**
 * Applies the inherited settings to the current profile.
 * @param context Extension context.
 */
async function applyInheritedSettings(context: vscode.ExtensionContext): Promise<void> {
    // Get the path to the current profile settings:
    const currentProfileName = await getCurrentProfileName(context);
    const profiles = await getProfileMap(context);
    const currentProfileDirectory = profiles[currentProfileName];
    if (!currentProfileDirectory) {
        console.error(`Unable to find current profile directory for \`${currentProfileName}\` profile.`);
    }
    const currentProfilePath = path.join(currentProfileDirectory, "settings.json");

    // Remove the inherited settings from the current profile:
    removeInheritedSettingsFromFile(currentProfilePath);

    // Get the settings that the current profile should inherit:
    const inheritedSettings = await getInheritedSettings(context);
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
 * @param context Extension context.
 */
export async function updateCurrentProfileInheritance(context: vscode.ExtensionContext): Promise<void> {
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
export async function removeCurrentProfileInheritedSettings(context: vscode.ExtensionContext): Promise<void> {
    const currentProfileName = await getCurrentProfileName(context);
    const profiles = await getProfileMap(context);
    const currentProfileDirectory = profiles[currentProfileName];
    if (!currentProfileDirectory) {
        console.error(`Unable to find current profile directory for \`${currentProfileName}\` profile.`);
    }
    const currentProfilePath = path.join(currentProfileDirectory, "settings.json");
    await removeInheritedSettingsFromFile(currentProfilePath);

    const config = vscode.workspace.getConfiguration("inheritProfile");
    if (config.get<boolean>("showMessages", true)) {
        vscode.window.showInformationMessage("Inherited settings remove from current profile!");
    }
}

/**
 * Updates the inherited settings when the profile changes.
 * @param context Extension context.
 */
export async function updateInheritedSettingsOnProfileChange(context: vscode.ExtensionContext) {
    const globalStoragePath = getGlobalStoragePath(context);
    let currentProfile = await getCurrentProfileName(context);

    const watcher = vscode.workspace.createFileSystemWatcher(globalStoragePath);
    const onChange = async () => {
        const newProfileName = await getCurrentProfileName(context);
        if (newProfileName !== currentProfile) {
            currentProfile = newProfileName;
            console.info("Current profile has changed, updating inherited settings...");
            await updateCurrentProfileInheritance(context);
        }
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);

    context.subscriptions.push(watcher);
}