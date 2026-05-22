import * as assert from "assert";

import {
  buildInheritedSettingsBlock,
  findTabValue,
  flattenSettings,
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY,
  INHERITED_SETTINGS_START_MARKER,
  insertBeforeClose,
  mergeFlattenedSettings,
  removeTrailingComma,
  sortSettings,
  splitRawSettingsByClosingBrace,
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
});
