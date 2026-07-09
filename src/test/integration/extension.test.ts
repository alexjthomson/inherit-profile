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
  registerCurrentProfileSaveWatcher,
  registerParentProfileSaveWatcher,
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
    await updateConfig("inheritExtensions", undefined);
  });

  teardown(async () => {
    await updateConfig("parents", undefined);
    await updateConfig("showMessages", undefined);
    await updateConfig("inheritExtensions", undefined);
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

  test("falls back to the emptyWindows profile association when no profile menu or workspace matches", async () => {
    const currentProfile: ProfileDescriptor = {
      name: "Custom",
      location: "custom-profile",
    };
    const parentProfile: ProfileDescriptor = {
      name: "Parent",
      location: "parent-profile",
    };
    const backupFolderId = "1234567890abcdef1234567890abcdef";

    await writeStorageWithEmptyWindowAssociation(
      sandboxRoot,
      currentProfile,
      [parentProfile],
      backupFolderId,
    );
    await writeProfileSettings(
      sandboxRoot,
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );

    await updateConfig("parents", ["Parent"]);
    await updateCurrentProfileInheritance(createContext(sandboxRoot));

    // The inherited "files.autoSave" setting is only merged into the Custom
    // profile if `getCurrentProfileName()` resolved "Custom" via the
    // emptyWindows fallback rather than defaulting to "Default".
    const updatedSettingsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "settings.json",
    );
    const updatedSettingsRaw = await fs.readFile(updatedSettingsPath, "utf8");
    const updatedSettings = parse(updatedSettingsRaw) as Record<string, any>;
    assert.strictEqual(updatedSettings["editor.tabSize"], 2);
    assert.strictEqual(updatedSettings["files.autoSave"], "off");

    // The Default profile's settings file should remain untouched.
    const defaultSettingsPath = path.join(
      getProfileDirectory(sandboxRoot),
      "settings.json",
    );
    await assert.rejects(fs.access(defaultSettingsPath));
  });

  test("falls back to the Default profile when the empty window has no recorded profile association", async () => {
    const currentProfile: ProfileDescriptor = {
      name: "Custom",
      location: "custom-profile",
    };
    const parentProfile: ProfileDescriptor = {
      name: "Parent",
      location: "parent-profile",
    };

    // The backup folder ID of the last active window does not match any key
    // in `profileAssociations.emptyWindows`, so the fallback should not match.
    await writeStorageWithEmptyWindowAssociation(
      sandboxRoot,
      currentProfile,
      [parentProfile],
      "1234567890abcdef1234567890abcdef",
      "some-other-backup-folder-id",
    );
    await writeProfileSettings(
      sandboxRoot,
      undefined,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );

    await updateConfig("parents", ["Parent"]);
    await updateCurrentProfileInheritance(createContext(sandboxRoot));

    // The Default profile's settings.json (not the Custom profile's) should
    // receive the inherited setting, since no emptyWindows association matched.
    const defaultSettingsPath = path.join(
      getProfileDirectory(sandboxRoot),
      "settings.json",
    );
    const defaultSettingsRaw = await fs.readFile(defaultSettingsPath, "utf8");
    const defaultSettings = parse(defaultSettingsRaw) as Record<string, any>;
    assert.strictEqual(defaultSettings["editor.tabSize"], 2);
    assert.strictEqual(defaultSettings["files.autoSave"], "off");

    const customSettingsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "settings.json",
    );
    await assert.rejects(fs.access(customSettingsPath));
  });

  test("inherits object-valued settings such as files.exclude without splitting their keys (issue #5)", async () => {
    const currentProfile: ProfileDescriptor = {
      name: "Custom",
      location: "custom-profile",
    };

    await writeStorage(sandboxRoot, currentProfile);
    await writeProfileSettings(
      sandboxRoot,
      undefined,
      `{
    "files.exclude": {
        "README.md": true
    },
    "workbench.colorCustomizations": {
        "editor.background": "#000000"
    }
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );

    await updateConfig("parents", ["Default"]);
    await updateCurrentProfileInheritance(createContext(sandboxRoot));

    const updatedSettingsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "settings.json",
    );
    const updatedSettingsRaw = await fs.readFile(updatedSettingsPath, "utf8");
    const updatedSettings = parse(updatedSettingsRaw) as Record<string, any>;

    // The inherited `files.exclude` setting must remain a single object-valued
    // key, matching the shape VS Code expects, rather than being split into
    // `files.exclude.README.md`.
    assert.deepStrictEqual(updatedSettings["files.exclude"], {
      "README.md": true,
    });
    assert.strictEqual(updatedSettings["files.exclude.README.md"], undefined);

    assert.deepStrictEqual(updatedSettings["workbench.colorCustomizations"], {
      "editor.background": "#000000",
    });
    assert.strictEqual(
      updatedSettings["workbench.colorCustomizations.editor.background"],
      undefined,
    );
  });

  test("does not inherit extensions when inheritExtensions is disabled", async () => {
    const currentProfile: ProfileDescriptor = {
      name: "Custom",
      location: "custom-profile",
    };
    const parentProfile: ProfileDescriptor = {
      name: "Parent",
      location: "parent-profile",
    };

    await writeStorage(sandboxRoot, currentProfile, [parentProfile]);
    await writeProfileSettings(
      sandboxRoot,
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );
    await writeProfileExtensions(sandboxRoot, currentProfile, [
      createExtension("esbenp.prettier-vscode"),
    ]);
    await writeProfileExtensions(sandboxRoot, parentProfile, [
      createExtension("ms-python.python"),
    ]);

    await updateConfig("parents", ["Parent"]);
    await updateConfig("inheritExtensions", false);
    await updateCurrentProfileInheritance(createContext(sandboxRoot));

    // Settings inheritance is unaffected by the extension inheritance toggle.
    const updatedSettingsPath = path.join(
      getProfileDirectory(sandboxRoot, currentProfile),
      "settings.json",
    );
    const updatedSettings = parse(
      await fs.readFile(updatedSettingsPath, "utf8"),
    ) as Record<string, any>;
    assert.strictEqual(updatedSettings["files.autoSave"], "off");

    // Extensions must be left completely untouched: no parent extension is
    // inherited, and the file is not rewritten.
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

  test("re-applies inheritance when the current profile's settings.json is saved externally", async function () {
    this.timeout(20000);

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
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );

    await updateConfig("parents", ["Parent"]);
    const context = createContext(sandboxRoot);

    try {
      // Apply once up front, mirroring what happens on extension startup.
      await updateCurrentProfileInheritance(context);
      await registerCurrentProfileSaveWatcher(context);

      // Watcher registration involves an async round-trip to set up the
      // underlying OS-level watch, so give it a moment to settle before
      // relying on it to observe the change below.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const settingsPath = path.join(
        getProfileDirectory(sandboxRoot, currentProfile),
        "settings.json",
      );

      // Simulate the user editing and saving the current profile's
      // settings.json directly (i.e. NOT through this extension).
      await fs.writeFile(
        settingsPath,
        `{
    "editor.tabSize": 4
}
`,
        "utf8",
      );

      // The watcher should notice the external change and re-apply
      // inheritance, re-inserting the inherited "files.autoSave" setting
      // while preserving the user's edit.
      const updatedSettings = await waitForSettings(
        settingsPath,
        (settings) =>
          settings["files.autoSave"] === "off" &&
          settings["editor.tabSize"] === 4,
        15000,
      );

      assert.strictEqual(updatedSettings["files.autoSave"], "off");
      assert.strictEqual(updatedSettings["editor.tabSize"], 4);
    } finally {
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
    }
  });

  test("does not repeatedly re-apply inheritance for its own writes", async function () {
    this.timeout(20000);

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
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );

    await updateConfig("parents", ["Parent"]);
    const context = createContext(sandboxRoot);

    try {
      await registerCurrentProfileSaveWatcher(context);

      // Watcher registration involves an async round-trip to set up the
      // underlying OS-level watch, so give it a moment to settle before
      // relying on it to observe the change below.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const settingsPath = path.join(
        getProfileDirectory(sandboxRoot, currentProfile),
        "settings.json",
      );

      // The initial call inside registerCurrentProfileSaveWatcher's
      // resubscribe step does not apply inheritance itself, so trigger it
      // once and let its own write settle before observing stability.
      await updateCurrentProfileInheritance(context);
      const settledSettings = await waitForSettings(
        settingsPath,
        (settings) => settings["files.autoSave"] === "off",
        15000,
      );
      assert.strictEqual(settledSettings["files.autoSave"], "off");

      // Give the watcher a chance to react to the write above. Since it was
      // this extension's own write, it must be recognised as a self-write
      // and must not schedule another reapplication. If it did, the file
      // would still settle on the same content, so instead we assert the
      // content remains byte-for-byte stable after waiting comfortably
      // longer than the debounce delay.
      const contentAfterOwnWrite = await fs.readFile(settingsPath, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 750));
      const contentAfterWaiting = await fs.readFile(settingsPath, "utf8");
      assert.strictEqual(contentAfterWaiting, contentAfterOwnWrite);
    } finally {
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
    }
  });

  test("re-applies inheritance when a parent profile's settings.json is saved externally", async function () {
    this.timeout(20000);

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
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );

    await updateConfig("parents", ["Parent"]);
    const context = createContext(sandboxRoot);

    try {
      // Apply once up front, mirroring what happens on extension startup.
      await updateCurrentProfileInheritance(context);
      await registerParentProfileSaveWatcher(context);

      // Watcher registration involves an async round-trip to set up the
      // underlying OS-level watch, so give it a moment to settle before
      // relying on it to observe the change below.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const currentSettingsPath = path.join(
        getProfileDirectory(sandboxRoot, currentProfile),
        "settings.json",
      );
      const parentSettingsPath = path.join(
        getProfileDirectory(sandboxRoot, parentProfile),
        "settings.json",
      );

      // Simulate the user editing and saving the parent profile's
      // settings.json directly.
      await fs.writeFile(
        parentSettingsPath,
        `{
    "files.autoSave": "off",
    "editor.fontSize": 18
}
`,
        "utf8",
      );

      // The watcher should notice the external change to the parent profile
      // and re-apply inheritance to the current profile, picking up the new
      // inherited "editor.fontSize" setting.
      const updatedSettings = await waitForSettings(
        currentSettingsPath,
        (settings) =>
          settings["files.autoSave"] === "off" &&
          settings["editor.fontSize"] === 18,
        15000,
      );

      assert.strictEqual(updatedSettings["files.autoSave"], "off");
      assert.strictEqual(updatedSettings["editor.fontSize"], 18);
      assert.strictEqual(updatedSettings["editor.tabSize"], 2);
    } finally {
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
    }
  });

  test("re-subscribes to newly added parent profiles when inheritProfile.parents changes", async function () {
    this.timeout(20000);

    const currentProfile: ProfileDescriptor = {
      name: "Child",
      location: "child-profile",
    };
    const parentProfile: ProfileDescriptor = {
      name: "ParentOne",
      location: "parent-one-profile",
    };
    const secondParentProfile: ProfileDescriptor = {
      name: "ParentTwo",
      location: "parent-two-profile",
    };

    await writeStorage(sandboxRoot, currentProfile, [
      parentProfile,
      secondParentProfile,
    ]);
    await writeProfileSettings(
      sandboxRoot,
      currentProfile,
      `{
    "editor.tabSize": 2
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      parentProfile,
      `{
    "files.autoSave": "off"
}
`,
    );
    await writeProfileSettings(
      sandboxRoot,
      secondParentProfile,
      `{
    "editor.fontSize": 20
}
`,
    );

    await updateConfig("parents", ["ParentOne"]);
    const context = createContext(sandboxRoot);

    try {
      await updateCurrentProfileInheritance(context);
      await registerParentProfileSaveWatcher(context);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Add the second parent profile to the configured list. The watcher
      // should notice this configuration change and start watching the
      // second parent profile's settings.json too.
      await updateConfig("parents", ["ParentOne", "ParentTwo"]);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const currentSettingsPath = path.join(
        getProfileDirectory(sandboxRoot, currentProfile),
        "settings.json",
      );
      const secondParentSettingsPath = path.join(
        getProfileDirectory(sandboxRoot, secondParentProfile),
        "settings.json",
      );

      // Simulate the user editing and saving the newly added parent
      // profile's settings.json directly.
      await fs.writeFile(
        secondParentSettingsPath,
        `{
    "editor.fontSize": 24
}
`,
        "utf8",
      );

      const updatedSettings = await waitForSettings(
        currentSettingsPath,
        (settings) => settings["editor.fontSize"] === 24,
        15000,
      );

      assert.strictEqual(updatedSettings["editor.fontSize"], 24);
      assert.strictEqual(updatedSettings["files.autoSave"], "off");
    } finally {
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
    }
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

/**
 * Writes a `storage.json` that mimics VS Code 1.127+, where the
 * `profileMenu` structure is no longer present and profile detection for
 * empty windows (no workspace/folder open) relies on
 * `profileAssociations.emptyWindows` keyed by the last active window's
 * backup folder ID.
 * @param backupFolderId The backup folder ID reported by `windowsState.lastActiveWindow.backupPath`.
 * @param associatedBackupFolderId The backup folder ID key used in `profileAssociations.emptyWindows`. Defaults to `backupFolderId` so the association matches; pass a different value to simulate no match.
 */
async function writeStorageWithEmptyWindowAssociation(
  rootDir: string,
  currentProfile: ProfileDescriptor,
  extraProfiles: ProfileDescriptor[],
  backupFolderId: string,
  associatedBackupFolderId: string = backupFolderId,
): Promise<void> {
  const globalStorageDir = path.join(
    getUserDirectory(rootDir),
    "globalStorage",
    "alexthomson.inherit-profile",
  );
  await fs.mkdir(globalStorageDir, { recursive: true });

  const storage = {
    windowsState: {
      lastActiveWindow: {
        backupPath: path.join(os.tmpdir(), "Backups", backupFolderId),
      },
    },
    profileAssociations: {
      emptyWindows: {
        [associatedBackupFolderId]: currentProfile.location,
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

/**
 * Polls `settingsPath` until its parsed contents satisfy `predicate`, or
 * throws if `timeoutMs` elapses first. Used to wait for a file system
 * watcher to notice a change and asynchronously re-apply inheritance.
 */
async function waitForSettings(
  settingsPath: string,
  predicate: (settings: Record<string, any>) => boolean,
  timeoutMs = 8000,
  intervalMs = 50,
): Promise<Record<string, any>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      const settings = parse(raw) as Record<string, any>;
      if (predicate(settings)) {
        return settings;
      }
    } catch {
      // File may not exist yet, or may be mid-write; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for settings at ${settingsPath} to satisfy the predicate.`,
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
