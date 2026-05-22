import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parse } from "jsonc-parser";

import {
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY,
  INHERITED_SETTINGS_START_MARKER,
} from "../../profileSettings";
import {
  removeCurrentProfileInheritedSettings,
  updateCurrentProfileInheritance,
} from "../../profiles";

type ProfileDescriptor = {
  name: string;
  location: string;
};

suite("Extension integration", () => {
  let sandboxRoot = "";

  setup(async () => {
    sandboxRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "inherit-profile-tests-"),
    );
    await updateConfig("parents", undefined);
    await updateConfig("showMessages", false);
  });

  teardown(async () => {
    await updateConfig("parents", undefined);
    await updateConfig("showMessages", undefined);
    if (sandboxRoot) {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("applies inherited settings and extensions for the current profile", async () => {
    const currentProfile: ProfileDescriptor = {
      name: "Child",
      location: "child-profile",
    };
    const parentProfile: ProfileDescriptor = {
      name: "Parent",
      location: "parent-profile",
    };

    await writeStorage(sandboxRoot, currentProfile, [parentProfile]);
    await writeProfileSettings(
      sandboxRoot,
      undefined,
      `{
    "editor": {
        "fontSize": 14,
        "tabSize": 2
    },
    "files": {
        "autoSave": "off"
    }
}
`,
    );
    await writeProfileExtensions(sandboxRoot, undefined, [
      createExtension("ms-python.python"),
    ]);
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "editor": {
        "fontSize": 16
    },
    "terminal": {
        "integrated": {
            "fontSize": 12
        }
    }
}
`,
    );
    await writeProfileExtensions(sandboxRoot, parentProfile, [
      createExtension("esbenp.prettier-vscode"),
      createExtension("dbaeumer.vscode-eslint"),
    ]);
    await writeProfileSettings(
      sandboxRoot,
      currentProfile,
      `{
    "editor": {
        "tabSize": 4
    },
    ${INHERITED_SETTINGS_START_MARKER}
    "legacy.setting": true,
    ${INHERITED_SETTINGS_END_MARKER}
    "${INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY}": false
}
`,
    );
    await writeProfileExtensions(sandboxRoot, currentProfile, [
      createExtension("esbenp.prettier-vscode"),
      createExtension("legacy.inherited", {
        inheritedFromProfile: "Legacy",
      }),
    ]);

    await updateConfig("parents", ["Default", "Parent"]);
    await updateCurrentProfileInheritance(createContext(sandboxRoot));

    const updatedSettingsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "settings.json",
    );
    const updatedSettingsRaw = await fs.readFile(updatedSettingsPath, "utf8");
    const updatedSettings = parse(updatedSettingsRaw) as Record<string, any>;

    assert.deepStrictEqual(updatedSettings.editor, { tabSize: 4 });
    assert.strictEqual(updatedSettings["editor.fontSize"], 16);
    assert.strictEqual(updatedSettings["files.autoSave"], "off");
    assert.strictEqual(updatedSettings["terminal.integrated.fontSize"], 12);
    assert.strictEqual(
      updatedSettings[INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY],
      false,
    );
    assert.ok(updatedSettingsRaw.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(updatedSettingsRaw.includes(INHERITED_SETTINGS_END_MARKER));
    assert.ok(!updatedSettingsRaw.includes('"legacy.setting": true'));

    const editorFontSizeIndex = updatedSettingsRaw.indexOf('"editor.fontSize"');
    const filesAutoSaveIndex = updatedSettingsRaw.indexOf('"files.autoSave"');
    const terminalFontSizeIndex = updatedSettingsRaw.indexOf(
      '"terminal.integrated.fontSize"',
    );
    assert.ok(
      editorFontSizeIndex < filesAutoSaveIndex &&
        filesAutoSaveIndex < terminalFontSizeIndex,
    );

    const updatedExtensionsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "extensions.json",
    );
    const updatedExtensions = JSON.parse(
      await fs.readFile(updatedExtensionsPath, "utf8"),
    ) as Array<{ identifier: { id: string }; metadata?: Record<string, any> }>;

    assert.deepStrictEqual(
      updatedExtensions.map((extension) => extension.identifier.id),
      [
        "esbenp.prettier-vscode",
        "ms-python.python",
        "dbaeumer.vscode-eslint",
      ],
    );
    assert.strictEqual(
      updatedExtensions[0].metadata?.inheritedFromProfile,
      undefined,
    );
    assert.strictEqual(
      updatedExtensions[1].metadata?.inheritedFromProfile,
      "Default",
    );
    assert.strictEqual(
      updatedExtensions[2].metadata?.inheritedFromProfile,
      "Parent",
    );
  });

  test("removes managed settings and inherited extensions from the current profile", async () => {
    const currentProfile: ProfileDescriptor = {
      name: "Child",
      location: "child-profile",
    };

    await writeStorage(sandboxRoot, currentProfile);
    await writeProfileSettings(
      sandboxRoot,
      currentProfile,
      `{
    "workbench.colorTheme": "Solarized Dark",
    ${INHERITED_SETTINGS_START_MARKER}
    "files.autoSave": "off",
    ${INHERITED_SETTINGS_END_MARKER}
    "${INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY}": false
}
`,
    );
    await writeProfileExtensions(sandboxRoot, currentProfile, [
      createExtension("esbenp.prettier-vscode"),
      createExtension("ms-python.python", {
        inheritedFromProfile: "Default",
      }),
    ]);

    await removeCurrentProfileInheritedSettings(createContext(sandboxRoot));

    const updatedSettingsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "settings.json",
    );
    const updatedSettingsRaw = await fs.readFile(updatedSettingsPath, "utf8");
    const updatedSettings = parse(updatedSettingsRaw) as Record<string, any>;

    assert.deepStrictEqual(updatedSettings, {
      "workbench.colorTheme": "Solarized Dark",
    });
    assert.ok(!updatedSettingsRaw.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(!updatedSettingsRaw.includes(INHERITED_SETTINGS_END_MARKER));
    assert.ok(
      !updatedSettingsRaw.includes(INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY),
    );

    const updatedExtensionsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "extensions.json",
    );
    const updatedExtensions = JSON.parse(
      await fs.readFile(updatedExtensionsPath, "utf8"),
    ) as Array<{ identifier: { id: string } }>;

    assert.deepStrictEqual(
      updatedExtensions.map((extension) => extension.identifier.id),
      ["esbenp.prettier-vscode"],
    );
  });
});

function createContext(rootDir: string): vscode.ExtensionContext {
  return {
    globalStorageUri: vscode.Uri.file(
      path.join(rootDir, "User", "globalStorage", "alexthomson.inherit-profile"),
    ),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function getUserDirectory(rootDir: string): string {
  return path.join(rootDir, "User");
}

function getProfileDirectory(
  rootDir: string,
  profile?: ProfileDescriptor,
): string {
  if (!profile) {
    return getUserDirectory(rootDir);
  }

  return path.join(getUserDirectory(rootDir), "profiles", profile.location);
}

async function writeStorage(
  rootDir: string,
  currentProfile: ProfileDescriptor,
  extraProfiles: ProfileDescriptor[] = [],
): Promise<void> {
  const globalStorageDir = path.join(
    getUserDirectory(rootDir),
    "globalStorage",
    "alexthomson.inherit-profile",
  );
  await fs.mkdir(globalStorageDir, { recursive: true });

  const storage = {
    profileMenu: {
      id: "submenuitem.Profiles",
      submenu: {
        items: [
          {
            id: `workbench.profiles.actions.switchProfile.${currentProfile.location}`,
            checked: true,
          },
        ],
      },
    },
    userDataProfiles: [currentProfile, ...extraProfiles],
  };

  await fs.writeFile(
    path.join(getUserDirectory(rootDir), "globalStorage", "storage.json"),
    JSON.stringify(storage, null, 4),
    "utf8",
  );
}

async function writeProfileSettings(
  rootDir: string,
  profile: ProfileDescriptor | undefined,
  rawSettings: string,
): Promise<void> {
  const profileDirectory = getProfileDirectory(rootDir, profile);
  await fs.mkdir(profileDirectory, { recursive: true });
  await fs.writeFile(
    path.join(profileDirectory, "settings.json"),
    rawSettings,
    "utf8",
  );
}

async function writeProfileExtensions(
  rootDir: string,
  profile: ProfileDescriptor | undefined,
  extensions: unknown[],
): Promise<void> {
  const profileDirectory = getProfileDirectory(rootDir, profile);
  await fs.mkdir(profileDirectory, { recursive: true });
  await fs.writeFile(
    path.join(profileDirectory, "extensions.json"),
    JSON.stringify(extensions, null, 4) + "\n",
    "utf8",
  );
}

async function updateConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("inheritProfile")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function createExtension(
  id: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const extension: Record<string, unknown> = {
    identifier: { id },
  };

  if (metadata) {
    extension.metadata = metadata;
  }

  return extension;
}
