import * as assert from "assert";
import * as path from "path";
import {
  mergeInheritedExtensions,
  stripInheritedExtensions,
  isInheritedExtension,
  isOptedOutExtension,
  markExtensionAsInherited,
  markExtensionAsOptedOut,
  convertOldMarkers,
  resolveParentExtensionsPaths,
  ExtensionEntry,
  INHERITED_PROFILE_META_KEY,
} from "../../profileSettings";

suite("mergeInheritedExtensions full reconciliation", () => {
  // ── 辅助函数测试 ──

  test("isInheritedExtension returns true when inheritProfile.inherited is set", () => {
    assert.strictEqual(
      isInheritedExtension({ identifier: { id: "a.b" }, metadata: { inheritProfile: { inherited: true } } }),
      true,
    );
    assert.strictEqual(
      isInheritedExtension({ identifier: { id: "a.b" } }),
      false,
    );
  });

  test("isOptedOutExtension returns true when inheritProfile.optedOut is set", () => {
    assert.strictEqual(
      isOptedOutExtension({ identifier: { id: "a.b" }, metadata: { inheritProfile: { optedOut: true } } }),
      true,
    );
    assert.strictEqual(
      isOptedOutExtension({ identifier: { id: "a.b" } }),
      false,
    );
  });

  test("markExtensionAsInherited adds inheritProfile.inherited metadata", () => {
    const ext: ExtensionEntry = { identifier: { id: "a.b" } };
    const result = markExtensionAsInherited(ext);
    assert.strictEqual(result.metadata?.inheritProfile?.inherited, true);
    // Preserves existing metadata
    const extWithMeta: ExtensionEntry = { identifier: { id: "a.b" }, metadata: { pinned: true } };
    const result2 = markExtensionAsInherited(extWithMeta);
    assert.strictEqual(result2.metadata?.pinned, true);
    assert.strictEqual(result2.metadata?.inheritProfile?.inherited, true);
  });

  test("markExtensionAsOptedOut creates a minimal entry with only identifier.id", () => {
    const result = markExtensionAsOptedOut("a.b");
    assert.deepStrictEqual(result, {
      identifier: { id: "a.b" },
      metadata: { inheritProfile: { optedOut: true } },
    });
  });

  test("convertOldMarkers converts inheritedFromProfile to inheritProfile.inherited", () => {
    const oldExt: any = { identifier: { id: "a.b" }, metadata: { inheritedFromProfile: "Base", pinned: true } };
    const result = convertOldMarkers(oldExt);
    assert.strictEqual(result.metadata?.inheritProfile?.inherited, true);
    assert.strictEqual(result.metadata?.inheritedFromProfile, undefined);
    assert.strictEqual(result.metadata?.pinned, true);
  });

  test("convertOldMarkers leaves new format unchanged", () => {
    const newExt: any = { identifier: { id: "a.b" }, metadata: { inheritProfile: { inherited: true } } };
    const result = convertOldMarkers(newExt);
    assert.deepStrictEqual(result, newExt);
  });

  test("resolveParentExtensionsPaths returns correct paths", () => {
    const profiles = { "Base": "/user/profiles/base", "Dev": "/user/profiles/dev" };
    const result = resolveParentExtensionsPaths(["Base", "Dev", "Missing"], profiles);
    assert.deepStrictEqual(result, [
      path.join("/user/profiles/base", "extensions.json"),
      path.join("/user/profiles/dev", "extensions.json"),
    ]);
  });

  // ── 核心对账算法测试 ──

  test("empty extensions with no parents returns empty", () => {
    const r = mergeInheritedExtensions([], [], []);
    assert.strictEqual(r.merged.length, 0);
    assert.strictEqual(r.originallyOwnExtensions.length, 0);
    assert.deepStrictEqual(r.parentNameMap, {});
  });

  test("own extensions survive when no parents", () => {
    const own: any = [{ identifier: { id: "a" } }];
    const r = mergeInheritedExtensions(own, [], []);
    assert.strictEqual(r.merged.length, 1);
    assert.strictEqual(r.merged[0].identifier?.id, "a");
    assert.strictEqual(r.merged[0].metadata?.inheritProfile, undefined);
  });

  test("inherited extensions are removed when no parents", () => {
    // 'b' was inherited; since no parent provides it and it's not in originallyOwn → discarded
    const input: any = [
      { identifier: { id: "a" } },
      { identifier: { id: "b" }, metadata: { inheritProfile: { inherited: true } } },
    ];
    const r = mergeInheritedExtensions(input, [], ["a"]);
    assert.strictEqual(r.merged.length, 1, "b should be discarded");
    assert.strictEqual(r.merged[0].identifier?.id, "a");
  });

  test("parent provides new extensions as inherited", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "x" } }, { identifier: { id: "y" } }] };
    const r = mergeInheritedExtensions<any>([], [parent], []);
    assert.strictEqual(r.merged.length, 2);
    for (const ext of r.merged) {
      assert.strictEqual(ext.metadata?.inheritProfile?.inherited, true, `${ext.identifier?.id} should be inherited`);
    }
  });

  test("own extension becomes inherited when parent also has it (own→inherited)", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "x" } }] };
    const r = mergeInheritedExtensions(
      [{ identifier: { id: "x" } }] as any,
      [parent],
      [],
    );
    const x = r.merged.find(e => e.identifier?.id === "x")!;
    assert.strictEqual(x.metadata?.inheritProfile?.inherited, true, "x should be inherited after takeover");
    assert.strictEqual(r.originallyOwnExtensions.includes("x"), true, "x should be recorded in originallyOwn");
    assert.strictEqual(r.parentNameMap["x"], "Base", "x parentName should be Base");
  });

  test("optedOut extensions are preserved and never become inherited", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "a" } }] };
    const current: any = [{ identifier: { id: "a" }, metadata: { inheritProfile: { optedOut: true } } }];
    const r = mergeInheritedExtensions(current, [parent], []);
    const a = r.merged.find(e => e.identifier?.id === "a")!;
    assert.strictEqual(a.metadata?.inheritProfile?.optedOut, true, "a should stay optedOut");
    assert.strictEqual(a.metadata?.inheritProfile?.inherited, undefined, "a should NOT become inherited");
    assert.strictEqual(r.parentNameMap["a"], undefined, "a should NOT be in parentNameMap");
  });

  test("revert to own when parent no longer provides an originallyOwn extension", () => {
    const r = mergeInheritedExtensions(
      [{ identifier: { id: "a" }, metadata: { inheritProfile: { inherited: true } } }],
      [],
      ["a"],
    );
    const a = r.merged.find(e => e.identifier?.id === "a")!;
    assert.strictEqual(a.metadata?.inheritProfile, undefined, "a should have no inheritProfile after revert");
    assert.strictEqual(r.originallyOwnExtensions.includes("a"), false, "a should be removed from originallyOwn");
  });

  test("first parent wins when multiple parents declare the same extension", () => {
    const parents: any = [
      { profileName: "Default", extensions: [{ identifier: { id: "eslint" } }] },
      { profileName: "Work", extensions: [{ identifier: { id: "eslint" } }] },
    ];
    const r = mergeInheritedExtensions([], parents, []);
    assert.strictEqual(r.merged.length, 1);
    assert.strictEqual(r.parentNameMap["eslint"], "Default");
  });

  test("empty parentProfiles array returns unchanged with empty originallyOwn", () => {
    const current = [{ identifier: { id: "a" } }];
    const r = mergeInheritedExtensions(current, [], []);
    assert.deepStrictEqual(r.merged, current);
  });

  test("stripInheritedExtensions keeps optedOut entries", () => {
    const result = stripInheritedExtensions([
      { identifier: { id: "own" } } as any,
      { identifier: { id: "inh" }, metadata: { inheritProfile: { inherited: true } } } as any,
      { identifier: { id: "opt" }, metadata: { inheritProfile: { optedOut: true } } } as any,
    ]);
    assert.strictEqual(result.length, 2);
    assert.ok(result.some(e => e.identifier?.id === "own"));
    assert.ok(result.some(e => e.identifier?.id === "opt"));
    assert.ok(!result.some(e => e.identifier?.id === "inh"));
  });

  test("parentNameMap only includes entries from inherited extensions", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "a" } }] };
    const current: any = [{ identifier: { id: "a" }, metadata: { inheritProfile: { optedOut: true } } }];
    const r = mergeInheritedExtensions(current, [parent], []);
    // 'a' is optedOut, should not appear in parentNameMap
    assert.strictEqual(r.parentNameMap["a"], undefined);
  });
});
