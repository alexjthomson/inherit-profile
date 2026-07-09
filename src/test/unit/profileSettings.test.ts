import * as assert from "assert";

import {
  buildInheritedSettingsBlock,
  ExtensionEntry,
  findTabValue,
  flattenSettings,
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY,
  INHERITED_SETTINGS_START_MARKER,
  insertBeforeClose,
  mergeFlattenedSettings,
  mergeInheritedExtensions,
  NON_FLATTENABLE_SETTINGS,
  removeTrailingComma,
  sortSettings,
  splitRawSettingsByClosingBrace,
  stripInheritedExtensions,
  stripManagedProfileSettings,
  subtractSettings,
} from "../../profileSettings";

suite("profileSettings helpers", () => {
  test("flattenSettings flattens nested objects and preserves arrays", () => {
    assert.deepStrictEqual(
      flattenSettings({
        editor: {
          fontSize: 14,
          rulers: [80, 100],
        },
        "files.autoSave": "off",
      }),
      {
        "editor.fontSize": 14,
        "editor.rulers": [80, 100],
        "files.autoSave": "off",
      },
    );
  });

  test("flattenSettings does not split keys inside files.exclude (issue #5)", () => {
    assert.deepStrictEqual(
      flattenSettings({
        "files.exclude": {
          "README.md": true,
        },
      }),
      {
        "files.exclude": {
          "README.md": true,
        },
      },
    );
  });

  test("flattenSettings does not split keys inside files.exclude when given nested notation", () => {
    assert.deepStrictEqual(
      flattenSettings({
        files: {
          exclude: {
            "README.md": true,
          },
          autoSave: "off",
        },
      }),
      {
        "files.exclude": {
          "README.md": true,
        },
        "files.autoSave": "off",
      },
    );
  });

  test("flattenSettings preserves every known non-flattenable setting as a single leaf entry", () => {
    for (const key of NON_FLATTENABLE_SETTINGS) {
      const value = { "some.dotted.data.key": true };
      assert.deepStrictEqual(
        flattenSettings({ [key]: value }),
        { [key]: value },
        `Expected "${key}" to be preserved as a single leaf entry.`,
      );
    }
  });

  test("flattenSettings keeps theme-scoped color customizations intact", () => {
    assert.deepStrictEqual(
      flattenSettings({
        "workbench.colorCustomizations": {
          "editor.background": "#000000",
          "[Default Dark+]": {
            "statusBar.background": "#111111",
          },
        },
      }),
      {
        "workbench.colorCustomizations": {
          "editor.background": "#000000",
          "[Default Dark+]": {
            "statusBar.background": "#111111",
          },
        },
      },
    );
  });

  test("flattenSettings still flattens ordinary nested settings that are not opaque data maps", () => {
    assert.deepStrictEqual(
      flattenSettings({
        editor: {
          fontSize: 14,
          rulers: [80, 100],
        },
        terminal: {
          integrated: {
            fontSize: 12,
          },
        },
        "files.autoSave": "off",
      }),
      {
        "editor.fontSize": 14,
        "editor.rulers": [80, 100],
        "terminal.integrated.fontSize": 12,
        "files.autoSave": "off",
      },
    );
  });

  test("mergeFlattenedSettings prefers later profile values", () => {
    assert.deepStrictEqual(
      mergeFlattenedSettings(
        {
          "editor.fontSize": 14,
          "files.autoSave": "off",
        },
        {
          "editor.fontSize": 16,
        },
      ),
      {
        "editor.fontSize": 16,
        "files.autoSave": "off",
      },
    );
  });

  test("subtractSettings removes keys that already exist in the current profile", () => {
    assert.deepStrictEqual(
      subtractSettings(
        {
          "editor.fontSize": 16,
          "files.autoSave": "off",
          "terminal.integrated.fontSize": 12,
        },
        {
          "editor.fontSize": 18,
        },
      ),
      {
        "files.autoSave": "off",
        "terminal.integrated.fontSize": 12,
      },
    );
  });

  test("sortSettings orders inherited keys alphabetically", () => {
    assert.deepStrictEqual(
      Object.keys(
        sortSettings({
          "terminal.integrated.fontSize": 12,
          "editor.fontSize": 16,
          "files.autoSave": "off",
        }),
      ),
      [
        "editor.fontSize",
        "files.autoSave",
        "terminal.integrated.fontSize",
      ],
    );
  });

  test("stripManagedProfileSettings removes the insertion boundary key", () => {
    assert.deepStrictEqual(
      stripManagedProfileSettings({
        "editor.fontSize": 16,
        [INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY]: false,
      }),
      {
        "editor.fontSize": 16,
      },
    );
  });

  test("removeTrailingComma ignores comments when trimming the final entry", () => {
    assert.strictEqual(
      removeTrailingComma(`{
    "files.autoSave": "off",
    // trailing comment
}
`),
      `{
    "files.autoSave": "off"
    // trailing comment
}
`,
    );
  });

  test("findTabValue detects tabs and falls back to four spaces", () => {
    assert.strictEqual(
      findTabValue(`{
\t"files.autoSave": "off"
}
`),
      "\t",
    );
    assert.strictEqual(findTabValue("{\n}\n"), "    ");
  });

  test("buildInheritedSettingsBlock includes markers, values, and the boundary entry", () => {
    const block = buildInheritedSettingsBlock(
      {
        "editor.fontSize": 16,
      },
      "    ",
    );

    assert.ok(block.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(block.includes(INHERITED_SETTINGS_END_MARKER));
    assert.ok(block.includes('"editor.fontSize": 16'));
    assert.ok(
      block.includes(`"${INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY}": false`),
    );
  });

  test("insertBeforeClose adds a comma after the last meaningful value before comments", () => {
    assert.strictEqual(
      insertBeforeClose(
        `{
    "editor.fontSize": 14
    // keep this comment
`,
        `    "files.autoSave": "off"
`,
      ),
      `{
    "editor.fontSize": 14,
    // keep this comment
    "files.autoSave": "off"
`,
    );
  });

  test("splitRawSettingsByClosingBrace falls back to an empty object shape", () => {
    assert.deepStrictEqual(splitRawSettingsByClosingBrace(""), ["{\n", "}\n"]);
  });

  test("stripInheritedExtensions removes only extensions tagged as inherited", () => {
    assert.deepStrictEqual(
      stripInheritedExtensions([
        { identifier: { id: "esbenp.prettier-vscode" } },
        {
          identifier: { id: "ms-python.python" },
          metadata: { inheritedFromProfile: "Default" },
        },
      ]),
      [{ identifier: { id: "esbenp.prettier-vscode" } }],
    );
  });

  test("mergeInheritedExtensions inherits extensions missing from the current profile", () => {
    const result = mergeInheritedExtensions<ExtensionEntry>(
      [{ identifier: { id: "esbenp.prettier-vscode" } }],
      [
        {
          profileName: "Default",
          extensions: [
            { identifier: { id: "ms-python.python" } },
            { identifier: { id: "esbenp.prettier-vscode" } },
          ],
        },
      ],
    );

    assert.deepStrictEqual(
      result.map((extension) => extension.identifier?.id).sort(),
      ["esbenp.prettier-vscode", "ms-python.python"],
    );

    const inherited = result.find(
      (extension) => extension.identifier?.id === "ms-python.python",
    );
    assert.strictEqual(inherited?.metadata?.inheritedFromProfile, "Default");

    // The extension already declared by the current profile must not be
    // tagged as inherited, even though a parent profile also declares it.
    const existing = result.find(
      (extension) => extension.identifier?.id === "esbenp.prettier-vscode",
    );
    assert.strictEqual(existing?.metadata?.inheritedFromProfile, undefined);
  });

  test("mergeInheritedExtensions prioritises the first parent profile to declare an extension", () => {
    const result = mergeInheritedExtensions<ExtensionEntry>([], [
      {
        profileName: "Default",
        extensions: [{ identifier: { id: "dbaeumer.vscode-eslint" } }],
      },
      {
        profileName: "Work",
        extensions: [{ identifier: { id: "dbaeumer.vscode-eslint" } }],
      },
    ]);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].metadata?.inheritedFromProfile, "Default");
  });

  test("mergeInheritedExtensions returns the current extensions unchanged when there are no parent profiles", () => {
    const currentExtensions = [{ identifier: { id: "esbenp.prettier-vscode" } }];
    assert.deepStrictEqual(
      mergeInheritedExtensions(currentExtensions, []),
      currentExtensions,
    );
  });
});
