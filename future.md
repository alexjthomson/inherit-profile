# Inherit Profile Plus · 完整开发规划

> 分支: `feat/bidirectional-inheritance` | 从 `main` 创建

---

## 设计总纲

**每次同步即全量对账。** 没有"初始化"和"日常同步"的区分——每一次 `updateCurrentProfileInheritance()` 都做完整的扩展标记对账。

### 设计原则

| 原则 | 说明 |
|------|------|
| **禁用不继承** | 父级禁用扩展不影响子级的继承状态。禁用是每个 profile 的独立运行时偏好，不被传播 |
| **全量对账** | 每次同步都完整重算扩展标记，不依赖增量状态，杜绝遗留不一致 |
| **级联触发** | 某 profile 变更时，仅触发其后代的对账，不影响无关 profile |
| **设置 Diff** | 三路比较（快照 ↔ 新父值 ↔ 当前 inherited block），防止用户修改被静默覆盖 |
| **配置即同步** | 元数据存储在 `settings.json` 的自定义键下，自然被 Settings Sync 同步到其他设备 |

### 标记体系

```typescript
// 存储在 extensions.json 每个条目的 metadata.inheritProfile 中
interface InheritedProfileMeta {
  inherited?: boolean;   // true = 从父级继承来的
  optedOut?: boolean;    // true = 用户主动跳过此扩展的继承
}
```

**三者关系**：

| 标记 | 含义 | 来源 |
|------|------|------|
| **own** | 无 `inheritProfile` 标记 | 用户自己在此 profile 安装的 |
| **inherited** | `inheritProfile.inherited = true` | 从父级 profile 同步来的 |
| **optedOut** | `inheritProfile.optedOut = true` | 用户选择跳过某扩展的继承 |

### 附加配置

存储在 **每个 profile 的 `settings.json`** 中，随 Settings Sync 自动跨设备同步：

```jsonc
{
  // ... 用户的常规设置 ...

  // 记录原本是 own 但被父级"夺走"的扩展（用于后续退还）
  "inheritProfile._originallyOwnExtensions": ["ext.a", "ext.b"],

  // 用户主动跳过继承的扩展列表
  "inheritProfile.optedOutExtensions": ["ext.controversial"],

  // 已存在的插入边界标记（不变）
  "inheritProfile._insertionBoundary": false
}
```

> 所有 `inheritProfile.*` 键在设置继承中被过滤，不会传播到子级 profile。

### 同步算法

```
输入: childExtensions[], parentProfiles (按配置顺序), originallyOwn[]
输出: mergedExtensions[]

1. 转换旧标记 inheritedFromProfile → inheritProfile.inherited

2. 分类 childExtensions:
   - own:       无 inheritProfile 标记
   - inherited: inheritProfile.inherited == true
   - optedOut:  inheritProfile.optedOut == true

3. 丢弃所有 inherited (稍后重新计算), 保留 own 和 optedOut

4. 遍历每个父级 profile (按配置顺序, 第一个优先):
   对父级的每个扩展:
   a. 已在 optedOut 中 → 跳过
   b. 子级有 own 版本:
      - 转为 inherited, 保留原 version/location
      - 如 id 不在 originallyOwn 中 → 追加到 originallyOwn
   c. 子级没有任何版本 → 新增条目, 标记 inherited: true

5. 清理: 原本是 inherited 的扩展:
   a. 父级不再提供 → 查 originallyOwn:
      在列表中 → 退还为 own (移除 inherited 标记, 从 originallyOwn 中移除)
      不在列表中 → 从 childExtensions 中删除
   b. 父级仍有 → 保留

6. 自动 opt-out(带恢复兜底): 原本 inherited, 父级仍有, 但标记丢失
   a. 先尝试从 `extensionMarkers` 备份中恢复标记（跨设备同步后标记可能尚未恢复）
   b. 能恢复 → 保留 inherited 状态, 不加入 optedOut
   c. 不能恢复（备份中也无此记录）→ 自动加入 optedOut 列表 (写入 settings.json)

7. 返回: [...own, ...optedOutEntries, ...inherited]
```

---

## 两阶段总览

| Phase | 功能 | 核心文件 | 前置 |
|-------|------|---------|------|
| 1 | 新标记体系 + 全量对账算法 + 反向索引级联 + 父级 extensions.json 监听 | `profileSettings.ts`, `profiles.ts`, `profileWatchers.ts` | 无 |
| 2 | 设置 Diff + 覆盖检测 + `setKeysForSync` 跨设备恢复 | `profiles.ts`, `profileSettings.ts`, `extension.ts` | Phase 1 |

> Phase 2（原"禁用状态同步"）已取消——禁用不继承，卸载已被全量对账覆盖，不再需要 `sql.js`。

---

## Phase 1: 新标记体系 + 全量对账 + 反向索引级联

### 1.1 `src/profileSettings.ts`

#### 新增: 常量与类型

| 新增项 | 代码 | 插入位置 |
|--------|------|---------|
| 常量 | `export const INHERITED_PROFILE_META_KEY = "inheritProfile";` | 约第 5 行，其他 `INHERITED_*` 常量旁 |
| 接口 | `export interface InheritedProfileMeta { inherited?: boolean; optedOut?: boolean; }` | 约第 170 行，`ExtensionEntry` 下方 |

> 注意：常量命名为 `INHERITED_PROFILE_META_KEY`（而非 `INHERIT_*`），与现有的 `INHERITED_SETTINGS_*` 系列常量保持 `INHERITED_` 前缀一致。

#### 新增: 辅助函数

所有新增函数放在 `ExtensionEntry` 接口之后、`stripInheritedExtensions` 之前（约第 175 行）：

```typescript
/**
 * Reads the inheritProfile metadata from an extension entry.
 */
export function getInheritedProfileMeta(ext: ExtensionEntry): InheritedProfileMeta | undefined {
  return ext?.metadata?.[INHERITED_PROFILE_META_KEY];
}

/**
 * Returns true if the extension is marked as inherited from a parent profile.
 */
export function isInheritedExtension(ext: ExtensionEntry): boolean {
  return getInheritedProfileMeta(ext)?.inherited === true;
}

/**
 * Returns true if the user has opted out of inheriting this extension.
 */
export function isOptedOutExtension(ext: ExtensionEntry): boolean {
  return getInheritedProfileMeta(ext)?.optedOut === true;
}

/**
 * Tags an extension entry as inherited from a parent profile.
 * Preserves existing metadata; only sets inheritProfile.inherited = true.
 */
export function markExtensionAsInherited<T extends ExtensionEntry>(ext: T): T {
  return {
    ...ext,
    metadata: {
      ...(ext.metadata ?? {}),
      [INHERITED_PROFILE_META_KEY]: { inherited: true },
    },
  };
}

/**
 * Creates a minimal extension entry representing an opted-out extension.
 * Preserves the original identifier if available (VS Code prefers full
 * identifier with id + uuid for reliable recognition).
 *
 * @param extId The extension ID to opt out of.
 * @param originalExt Optional original extension entry to preserve full
 *                    identifier and other fields from.
 */
export function markExtensionAsOptedOut(
  extId: string,
  originalExt?: ExtensionEntry,
): ExtensionEntry {
  const identifier = originalExt?.identifier ?? { id: extId };
  // Preserve non-metadata fields (version, location, etc.) if available
  const { metadata, ...rest } = originalExt ?? {};
  return {
    ...rest,
    identifier,
    metadata: {
      [INHERITED_PROFILE_META_KEY]: { optedOut: true },
    },
  };
}

/**
 * Converts the old `metadata.inheritedFromProfile` marker to the new
 * `metadata.inheritProfile.inherited` format.
 * If the entry already uses the new format, it is returned unchanged.
 */
export function convertOldMarkers<T extends ExtensionEntry>(ext: T): T {
  if (ext?.metadata?.inheritedFromProfile) {
    const { inheritedFromProfile, ...restMetadata } = ext.metadata;
    const newMetadata = {
      ...restMetadata,
      [INHERITED_PROFILE_META_KEY]: { inherited: true },
    };
    // 转换后如果 metadata 为空, 设为 undefined 避免写入空对象
    if (Object.keys(newMetadata).length === 0) {
      const { metadata, ...rest } = ext;
      return { ...rest } as T;
    }
    return {
      ...ext,
      metadata: newMetadata,
    };
  }
  return ext;
}
```

#### 新增: `resolveParentExtensionsPaths`

```typescript
/**
 * Resolves the absolute path to each named parent profile's `extensions.json`
 * file, preserving order and silently skipping any name that isn't present
 * in `profiles`.
 */
export function resolveParentExtensionsPaths(
  parentProfileNames: readonly string[],
  profiles: Readonly<Record<string, string>>,
): string[] {
  const extPaths: string[] = [];
  for (const name of parentProfileNames) {
    const dir = profiles[name];
    if (dir) {
      extPaths.push(path.join(dir, "extensions.json"));
    }
  }
  return extPaths;
}
```

放在 `resolveParentSettingsPaths` (约第 165 行) 下方，`ExtensionEntry` 接口之前。

对称命名，便于未来扩展 `resolveParentStateVscdbPaths` 等。

#### 修改: `stripManagedProfileSettings`

**旧逻辑**: 仅删除 `INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY`，新增的 `_originallyOwnExtensions`、`optedOutExtensions` 等 `inheritProfile.*` 键会泄漏到子级。

**新逻辑**: 过滤所有以 `inheritProfile.` 开头的键，确保所有私有元数据不被继承传播。

```typescript
export function stripManagedProfileSettings<T>(
  settings: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith("inheritProfile."))
  );
}
```

#### 重写: `stripInheritedExtensions`

**旧逻辑** (约第 185 行): 过滤 `!extension?.metadata?.inheritedFromProfile`

**新逻辑**:
```typescript
export function stripInheritedExtensions<T extends ExtensionEntry>(
  extensions: readonly T[],
): T[] {
  return extensions.filter(
    (ext) => !isInheritedExtension(ext) // 只清理 inherited, optedOut 保留
  );
}
```

#### 重写: `mergeInheritedExtensions`

**旧逻辑** (约第 215 行): 仅新增缺失的，标记 `inheritedFromProfile`

**新逻辑** 完整实现（全量对账 + originallyOwn 退还 + 自动 opt-out）：

```typescript
export function mergeInheritedExtensions<T extends ExtensionEntry>(
  currentExtensions: readonly T[],
  parentProfiles: readonly { profileName: string; extensions: readonly T[] }[],
  originallyOwnExtensions?: readonly string[],
): { merged: T[]; originallyOwnExtensions: string[] } {
  const originallyOwn = new Set(originallyOwnExtensions ?? []);

  // 1. 先将旧标记转换为新格式
  const converted = currentExtensions.map(convertOldMarkers);

  // 2. 分类: own / inherited / optedOut
  const ownMap: Record<string, T> = {};
  const optedOutMap: Record<string, boolean> = {};
  const inheritedFromPrev: Record<string, T> = {};

  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (!id) continue;
    if (isOptedOutExtension(ext)) {
      optedOutMap[id] = true;
    } else if (isInheritedExtension(ext)) {
      inheritedFromPrev[id] = ext;
    } else {
      ownMap[id] = ext;
    }
  }

  // 3. 从父级重新计算 inherited
  const inheritedMap: Record<string, T> = {};
  const visitedFromParent = new Set<string>();
  const convertedToInherited = new Set<string>(); // own → inherited 的追踪

  for (const { extensions } of parentProfiles) {
    for (const parentExt of extensions) {
      const id = parentExt?.identifier?.id;
      if (!id || visitedFromParent.has(id)) continue;
      visitedFromParent.add(id);

      if (optedOutMap[id]) continue;

      if (ownMap[id]) {
        // own → inherited, 记入 originallyOwn
        inheritedMap[id] = markExtensionAsInherited(ownMap[id]);
        convertedToInherited.add(id);
        delete ownMap[id];
        if (!originallyOwn.has(id)) {
          originallyOwn.add(id);
        }
      } else if (!inheritedMap[id]) {
        inheritedMap[id] = markExtensionAsInherited(
          parentExt as unknown as T
        );
      }
    }
  }

  // 4. 清理: 原本 inherited 但父级不再提供
  const newOptedOut: string[] = [];
  for (const [id, ext] of Object.entries(inheritedFromPrev)) {
    if (inheritedMap[id]) continue; // 父级仍有, 保留

    if (visitedFromParent.has(id)) {
      // 父级仍有但被用户删除 → 自动 opt-out
      newOptedOut.push(id);
    } else if (originallyOwn.has(id)) {
      // 父级不再提供, 但原本是 own → 退还为 own
      const { metadata, ...rest } = ext;
      const { [INHERITED_PROFILE_META_KEY]: _, ...restMeta } = metadata ?? {};
      ownMap[id] = { ...rest, metadata: Object.keys(restMeta).length > 0 ? restMeta : undefined } as T;
      originallyOwn.delete(id);
    }
    // 父级不再提供, 也不是 originallyOwn → 丢弃
  }

  // 5. 组装结果
  //    从 inheritedFromPrev 中取原条目传递给 markExtensionAsOptedOut, 保留完整 identifier
  const optedOutEntries = [
    ...Object.keys(optedOutMap).map((id) =>
      markExtensionAsOptedOut(id, inheritedFromPrev[id]) as unknown as T
    ),
    ...newOptedOut.map((id) =>
      markExtensionAsOptedOut(id, inheritedFromPrev[id]) as unknown as T
    ),
  ];

  const result: T[] = [
    ...Object.values(ownMap),
    ...optedOutEntries,
    ...Object.values(inheritedMap),
  ];

  return {
    merged: result,
    originallyOwnExtensions: [...originallyOwn].filter(
      (id) => inheritedMap[id] || ownMap[id]
    ), // 清理悬空引用
  };
}
```

---

### 1.2 `src/profiles.ts`

#### 新增导入

在现有导入块中追加 (约第 15 行):
```typescript
import {
  // ... 现有导入 ...
  convertOldMarkers,
  isInheritedExtension,
  isOptedOutExtension,
  markExtensionAsInherited,
  markExtensionAsOptedOut,
  INHERITED_PROFILE_META_KEY,
} from "./profileSettings";

// 新增: 同步 fs 方法（用于 buildInheritanceGraph 中的 statSync / readFileSync）
import { statSync, readFileSync } from "fs";
```

#### 新增: 反向索引 + 级联触发

```typescript
// 内存缓存: parent → children[]
let inheritanceGraphCache: Record<string, string[]> | undefined;
// 缓存时的 profiles 快照（用于检测 profile 新增/删除）
let cachedProfilesSnapshot: Record<string, string> | undefined;
// 缓存时各 profile 目录的 mtime 签名, 用于检测文件变更
let cachedProfileMtimes: Record<string, number> | undefined;

/**
 * 检查缓存是否仍然有效。
 * 如 profiles 列表有变动或任一 profile 目录的 mtime 变化, 缓存失效。
 */
function isGraphCacheValid(
  profiles: Readonly<Record<string, string>>,
): boolean {
  if (!inheritanceGraphCache || !cachedProfilesSnapshot || !cachedProfileMtimes) {
    return false;
  }
  // 检查 profile 列表是否一致
  const currentKeys = Object.keys(profiles).sort().join(",");
  const cachedKeys = Object.keys(cachedProfilesSnapshot).sort().join(",");
  if (currentKeys !== cachedKeys) return false;
  // 检查每个 profile 目录的 mtime
  for (const [name, dir] of Object.entries(profiles)) {
    try {
      const stat = statSync(dir);
      if (stat.mtimeMs !== cachedProfileMtimes[name]) return false;
    } catch {
      return false; // 目录不存在或无法访问
    }
  }
  return true;
}

/**
 * 构建继承关系反向索引。
 * 扫描所有 profile 的 settings.json 中的 inheritProfile.parents 来建立。
 * 同时记录 mtime 签名以供后续缓存校验。
 */
function buildInheritanceGraph(
  profiles: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const mtimes: Record<string, number> = {};
  for (const [profileName, profileDir] of Object.entries(profiles)) {
    const settingsPath = path.join(profileDir, "settings.json");
    try {
      // 记录 mtime
      const dirStat = statSync(profileDir);
      mtimes[profileName] = dirStat.mtimeMs;

      const raw = readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(raw);
      const parents = settings?.inheritProfile?.parents ?? [];
      for (const parent of parents) {
        if (profiles[parent]) {
          if (!graph[parent]) graph[parent] = [];
          if (!graph[parent].includes(profileName)) {
            graph[parent].push(profileName);
          }
        }
      }
    } catch {
      // 忽略无法读取的 settings.json
    }
  }
  cachedProfileMtimes = mtimes;
  cachedProfilesSnapshot = { ...profiles };
  return graph;
}

/**
 * 获取或构建缓存的反向索引。
 * 如果缓存已失效（profiles 变动或 mtime 变化）, 自动重建。
 */
function getInheritanceGraph(
  profiles: Readonly<Record<string, string>>,
): Record<string, string[]> {
  if (!inheritanceGraphCache || !isGraphCacheValid(profiles)) {
    inheritanceGraphCache = buildInheritanceGraph(profiles);
  }
  return inheritanceGraphCache;
}



/**
 * BFS 获取所有后代（使用 Set 去重, O(1) 查重避免重复入队）。
 */
function getDescendants(
  root: string,
  graph: Record<string, string[]>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = graph[current] ?? [];
    for (const child of children) {
      if (!visited.has(child)) {
        visited.add(child);
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/**
 * 使反向索引缓存失效（配置变更时调用）。
 * 注意: 日常使用中缓存由 `getInheritanceGraph` 的 `isGraphCacheValid`
 * 自动校验（检查 profiles 列表和 mtime）, 无需手动失效。
 * 但父级列表变更（`inheritProfile.parents` 配置变化）时仍需手动调用,
 * 因为继承关系拓扑变了, mtime 检测无法感知。
 */
function invalidateInheritanceGraph(): void {
  inheritanceGraphCache = undefined;
  cachedProfilesSnapshot = undefined;
  cachedProfileMtimes = undefined;
}

// 注意: invalidateInheritanceGraph 需要 export, 供 extension.ts 和 profileWatchers.ts 调用
export { invalidateInheritanceGraph };
```

#### 修改: `updateCurrentProfileInheritance` (约第 630 行)

**新增参数 `triggerProfileName`**，用于级联触发时指定从哪个 profile 开始对账。

```typescript
async function updateCurrentProfileInheritance(
  context: vscode.ExtensionContext,
  triggerProfileName?: string,  // ← 新增: 从哪个 profile 触发
): Promise<void> {
  const { currentProfileName, profiles } = await getCurrentProfileDetails(context);

  if (triggerProfileName) {
    // 级联触发: 仅对账触发 profile 的后代
    const graph = getInheritanceGraph(profiles);
    const descendants = getDescendants(triggerProfileName, graph);

    // 如果当前 profile 在 descendants 中, 才执行对账
    if (!descendants.includes(currentProfileName)) {
      console.info(`Skipping reconciliation for ${currentProfileName}: not a descendant of trigger ${triggerProfileName}.`);
      return;
    }
  }

  // ... 原有对账流程 ...
}
```

> 兼容性: 现有调用 `updateCurrentProfileInheritance(context)` 不传 `triggerProfileName` 时，行为不变（全量对账当前 profile）。
>
> **注意：父级 profile 自身不包含 inherited 标记，只负责向外提供扩展列表，
> 不需要对账。** 级联触发时，只有触发 profile 的**后代**才会执行对账，
> 触发者本身（父级）不会做无意义的标记检查。

#### 重写: `collectInheritedExtensions` (约第 575 行)

加入 `originallyOwnExtensions` 和 `optedOutExtensions` 的读写：

```typescript
async function collectInheritedExtensions(
  currentExtensions: any[],
  currentProfileName: string,
  profiles: Record<string, string>,
  // 元数据由调用者统一读取后传入, 避免重复解析 settings.json
  originallyOwn?: string[],
  optedOutList?: string[],
): Promise<{ extensions: any[]; originallyOwn: string[]; optedOut: string[] }> {
  // 1. 如调用者未传入, 从 settings.json 读取元数据
  if (!originallyOwn || !optedOutList) {
    const settingsPath = path.join(profiles[currentProfileName], "settings.json");
    const settings = await readJSON(settingsPath);
    originallyOwn = settings?.inheritProfile?._originallyOwnExtensions ?? [];
    optedOutList = settings?.inheritProfile?.optedOutExtensions ?? [];
  }

  // 2. 转换旧标记并持久化
  const converted = currentExtensions.map(convertOldMarkers);
  //    如磁盘上仍有旧标记, 立即写回新格式, 确保下次启动时读到正确标记
  const hasOldMarkers = currentExtensions.some(
    (e: any) => e?.metadata?.inheritedFromProfile
  );
  if (hasOldMarkers) {
    const extPath = path.join(profiles[currentProfileName], "extensions.json");
    await writeManagedFile(
      extPath,
      JSON.stringify(converted, null, 4) + "\n",
    );
  }

  // 3. 将 optedOutList 中的跳过注入为 optedOut 标记
  //    (确保用户从 settings.json 中配置的 opt-out 被生效)
  //    注意: 用 spread 合并而非整体覆盖, 避免丢失已有的 inherited 标记
  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (id && optedOutList.includes(id) && !isOptedOutExtension(ext)) {
      ext.metadata = {
        ...(ext.metadata ?? {}),
        inheritProfile: {
          ...(ext.metadata?.inheritProfile ?? {}),
          optedOut: true,
        },
      };
    }
  }

  // 4. 获取父级列表
  const config = vscode.workspace.getConfiguration("inheritProfile");
  const parentProfileNames = config.get<string[]>("parents", []);

  const parentProfiles: { profileName: string; extensions: any[] }[] = [];
  for (const profileName of parentProfileNames) {
    const profileDirectory = profiles[profileName];
    if (!profileDirectory) continue;
    const rawProfileExtensions = await readJSON(
      path.join(profileDirectory, "extensions.json")
    );
    parentProfiles.push({
      profileName,
      extensions: Array.isArray(rawProfileExtensions) ? rawProfileExtensions : [],
    });
  }

  // 5. 全量对账
  const result = mergeInheritedExtensions(converted, parentProfiles, originallyOwn);

  // 6. 统计真实新增/移除 (仅计数 inherited 条目的净变化)
  const prevInheritedIds = new Set(
    converted
      .filter((e: any) => isInheritedExtension(e))
      .map((e: any) => e.identifier?.id)
  );
  const newInheritedIds = new Set(
    result.merged
      .filter((e: any) => isInheritedExtension(e))
      .map((e: any) => e.identifier?.id)
  );
  const addedCount = [...newInheritedIds].filter((id) => !prevInheritedIds.has(id)).length;
  const removedCount = [...prevInheritedIds].filter((id) => !newInheritedIds.has(id)).length;

  if (addedCount > 0 || removedCount > 0) {
    console.info(
      `Extensions reconciled for \`${currentProfileName}\`: ${addedCount} inherited, ${removedCount} uninherited.`
    );
  }

  return {
    extensions: result.merged,
    originallyOwn: result.originallyOwnExtensions,
    optedOut: optedOutList,
  };
}
```

#### 修改: `applyInheritedSettings` (约第 386 行)

在扩展继承写入后，回写 `_originallyOwnExtensions` 和 `optedOutExtensions` 到 settings.json。
**使用 `jsonc-parser` 的 `modify` + `applyEdits` 原地修改，保留用户原有的注释和格式。**

> 为什么用 `modify` + `applyEdits` 而非 `JSON.stringify`?
> VS Code 的 Settings Sync 同步的是原始文件内容。如果用户 settings.json 中有注释或特定缩进，
> `JSON.stringify` 会全部抹掉，导致跨设备同步时产生不必要的 diff 冲突。
> `jsonc-parser` 的 AST 级别编辑能保留一切格式和注释，生成的 diff 最小。

```typescript
// 在 finalExtensions 写入 extensions.json 之后:
if (originallyOwn.length > 0 || optedOutList.length > 0) {
  const currentSettingsPath = path.join(currentProfileDirectory, "settings.json");
  const rawSettings = await fs.promises.readFile(currentSettingsPath, "utf8");

  // 使用 jsonc-parser 的 modify + applyEdits 原地修改, 保留注释和格式
  const edits: import("jsonc-parser").Edit[] = [];
  const options: import("jsonc-parser").ModifyOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 4 },
  };

  const { modify, applyEdits } = await import("jsonc-parser");

  edits.push(
    ...modify(rawSettings, ["inheritProfile._originallyOwnExtensions"], originallyOwn, options)
  );
  edits.push(
    ...modify(rawSettings, ["inheritProfile.optedOutExtensions"], optedOutList, options)
  );

  const updatedSettings = applyEdits(rawSettings, edits);
  await writeManagedFile(currentSettingsPath, updatedSettings);
}

// 备份当前 profile 的 extension 标记到 globalState，用于跨设备恢复
// 结构: Record<profileName, Record<extId, parentName>>
const extensionMarkersBackup: Record<string, string> = {};
for (const ext of finalExtensions) {
  const id = ext?.identifier?.id;
  if (id && isInheritedExtension(ext)) {
    extensionMarkersBackup[id] = ""; // parentName 在 collectInheritedExtensions 中填充
  }
}
void context.globalState.update(
  "inheritProfile.extensionMarkers",
  {
    ...(context.globalState.get("inheritProfile.extensionMarkers") ?? {}),
    [currentProfileName]: extensionMarkersBackup,
  }
);
```

---

### 1.3 `src/profileWatchers.ts`

#### 新增导入

```typescript
import { resolveParentExtensionsPaths } from "./profileSettings";
```

放在现有 `resolveParentSettingsPaths` 导入旁（约第 5 行）。

**同时**在 `./profiles` 导入块中追加 `invalidateInheritanceGraph`:

```typescript
import {
  // ... 现有导入 ...
  invalidateInheritanceGraph,
} from "./profiles";
```

#### 修改: `registerParentProfileSaveWatcher` (约第 147 行)

**改动点**：
1. 增加 extensions.json 监听
2. 增加 debounce（500ms）
3. 触发时传入 `triggerProfileName` 实现级联
4. 配置变更时同时重建反向索引（避免 `extension.ts` 重复监听）

```typescript
// 在当前 resubscribe 内部, 收集路径后:
const parentExtensionsPaths = resolveParentExtensionsPaths(
  parentProfileNames,
  profiles,
);

// 统一监听 settings.json + extensions.json, 带 debounce
const allParentPaths = [...parentSettingsPaths, ...parentExtensionsPaths];

// createDebouncedTrigger 的签名是 () => void, 不支持传参
// 用 pendingTriggerProfile 闭包实现级联触发
let pendingTriggerProfile: string | undefined;
const scheduleReapply = createDebouncedTrigger(async () => {
  const triggerName = pendingTriggerProfile;
  pendingTriggerProfile = undefined;
  await updateCurrentProfileInheritance(context, triggerName);
}, 500);

// 修改现有的 onDidChangeConfiguration 监听:
// 当 inheritProfile.parents 配置变更时, 不仅要重建 watcher,
// 还要使反向索引缓存失效并触发对账
// 原有: resubscribe() → 改为: invalidateInheritanceGraph() + resubscribe()
const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
  if (event.affectsConfiguration("inheritProfile.parents")) {
    invalidateInheritanceGraph();
    void resubscribe();
    void updateCurrentProfileInheritance(context);
  }
});

for (const parentPath of allParentPaths) {
  // 从路径反查 profile 名
  const profileName = parentProfileNames.find((name) => {
    const dir = profiles[name];
    return dir && parentPath.startsWith(dir);
  }) ?? parentProfileNames[0];

  const watcher = createFileWatcher(parentPath);
  const onChange = () => {
    pendingTriggerProfile = profileName;
    scheduleReapply();
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  parentWatchers.push(watcher);
}
```

> 路径到 profile 名的反查已由代码中的 `parentProfileNames.find(...)` 自动完成。

---

### 1.4 `src/extension.ts`

#### 新增导入

在现有的 `./profiles` 导入中追加 `invalidateInheritanceGraph`:

```typescript
import { updateCurrentProfileInheritance, removeCurrentProfileInheritedSettings, invalidateInheritanceGraph } from "./profiles";
```

#### 重写: `activate` 函数

```typescript
export function activate(context: vscode.ExtensionContext) {
  // 1. 注册命令 (同现有)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "inherit-profile.applyInheritanceToCurrentProfile",
      () => updateCurrentProfileInheritance(context)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "inherit-profile.removeInheritedSettingsFromCurrentProfile",
      () => removeCurrentProfileInheritedSettings(context)
    )
  );

  // 2. 新增: 强制全量对账命令 (重建反向索引)
  context.subscriptions.push(
    vscode.commands.registerCommand("inherit-profile.forceReconcile", async () => {
      invalidateInheritanceGraph();
      await updateCurrentProfileInheritance(context);
      if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("showMessages", true)) {
        vscode.window.showInformationMessage("Profile inheritance reconciliation complete!");
      }
    })
  );

  // 3. 注册 setKeysForSync (固定 key, 跨设备同步)
  //    extensionMarkers: Record<profileName, Record<extId, parentName>>
  //    记录扩展来自哪个父级, 跨设备恢复时做更精确的判断
  context.globalState.setKeysForSync([
    "inheritProfile.extensionMarkers",
    "inheritProfile.parentSnapshots",
  ]);

  // 4. 启动时运行 (同现有)
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnStartup", true)) {
    updateCurrentProfileInheritance(context);
  }

  // 5. Profile/配置变更时
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnProfileChange", true)) {
    updateInheritedSettingsOnProfileChange(context);
  }

  // 6. 当前 profile 保存时
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnCurrentProfileSave", true)) {
    registerCurrentProfileSaveWatcher(context);
  }

  // 7. 父级 profile 保存时
  if (vscode.workspace.getConfiguration("inheritProfile").get<boolean>("runOnParentProfileSave", true)) {
    registerParentProfileSaveWatcher(context);
  }

  // 8. (已合并到 registerParentProfileSaveWatcher 中)
  //     配置变更监听移至 profileWatchers.ts 的 resubscribe 逻辑中,避免重复触发
}
```

> `setKeysForSync` 注册两个固定 key，以 `Record<string, ...>` 结构存储所有 profile 的数据，确保跨设备同步正常。
>
> - `extensionMarkers`: `Record<profileName, Record<extId, parentName>>`
>   记录扩展来自哪个父级，跨设备恢复时可做更精确的判断。
> - `parentSnapshots`: `Record<profileName, Snapshot>`
>   记录父级设置的展平快照，用于设置 Diff 和覆盖检测。

#### 新增: 标记恢复逻辑

```typescript
/**
 * 在启动时检查 extension 标记是否丢失，尝试从 globalState 恢复。
 * extensionMarkers 结构: Record<profileName, Record<extId, parentName>>
 */
async function checkAndRestoreMarkers(context: vscode.ExtensionContext): Promise<void> {
  const { currentProfileName, currentProfileDirectory } =
    await getCurrentProfileDetails(context);
  const extPath = path.join(currentProfileDirectory, "extensions.json");
  const raw = await readJSON(extPath);
  const exts = Array.isArray(raw) ? raw : [];

  const hasMarkers = exts.some(
    (e: any) => e?.metadata?.inheritProfile?.inherited
  );

  if (!hasMarkers) {
    const backup = context.globalState.get<
      Record<string, Record<string, string>>  // profileName → { extId → parentName }
    >("inheritProfile.extensionMarkers");
    const markers = backup?.[currentProfileName];
    if (markers) {
      console.info("Restoring extension markers from globalState backup...");
      const updated = exts.map((ext: any) => {
        const id = ext?.identifier?.id;
        if (id && markers[id]) {
          return {
            ...ext,
            metadata: {
              ...(ext.metadata ?? {}),
              inheritProfile: { inherited: true },
            },
          };
        }
        return ext;
      });
      await fs.promises.writeFile(extPath, JSON.stringify(updated, null, 4) + "\n", "utf8");
      console.info("Extension markers restored from globalState.");
    } else {
      console.info("No globalState backup found, running full reconciliation...");
      await updateCurrentProfileInheritance(context);
    }
  }
}
```

---

### 1.5 `package.json`

#### `contributes.commands` 新增:

```json
{
  "command": "inherit-profile.forceReconcile",
  "title": "Inherit Profile: Force Full Reconciliation",
  "icon": "combine"
}
```

#### `contributes.configuration.properties` 新增:

在 `showMessages` 配置后追加:

```json
"inheritProfile.inheritExtensions": {
  "type": "boolean",
  "default": true,
  "description": "Whether to inherit extensions from parent profiles."
},
"inheritProfile.runOnCurrentProfileSave": {
  "type": "boolean",
  "default": true,
  "description": "Updates the inherited settings when the current profile's settings.json is saved."
},
"inheritProfile.runOnParentProfileSave": {
  "type": "boolean",
  "default": true,
  "description": "Updates the inherited settings when a parent profile's settings.json is saved."
}
```

> 说明: 这四个配置项已在 `extension.ts` 中被引用，但之前未在 `package.json` 中声明，这里补注册。

---

### 1.6 `src/test/unit/profileSettings.test.ts`

#### 现有测试需重写

| 现有测试 (行号参考) | 改动 |
|---------------------|------|
| `stripInheritedExtensions removes only extensions tagged as inherited` (约第 292 行) | 改为过滤 `inheritProfile.inherited` 而非 `inheritedFromProfile`；断言 optedOut 不被 strip |

#### 现有测试 `mergeInheritedExtensions` 的三个测试需重写

| 现有测试 (行号参考) | 新测试名 | 新验收标准 |
|---------------------|---------|-----------|
| `inherits extensions missing from the current profile` (约第 305 行) | 同 | 父级有、子级无 → 新增 inherited；own 的不打标记；标记为 `inheritProfile.inherited` |
| `prioritises the first parent profile` (约第 337 行) | 同 | 多个父级有同扩展，第一个胜出 |
| `returns the current extensions unchanged when there are no parent profiles` (约第 353 行) | 同 | 无父级时原样返回 |

#### 新增单元测试

```typescript
// --- 辅助函数测试 ---

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
  const ext = { identifier: { id: "a.b" } };
  const result = markExtensionAsInherited(ext);
  assert.strictEqual(result.metadata?.inheritProfile?.inherited, true);
  // Preserves existing metadata
  const extWithMeta = { identifier: { id: "a.b" }, metadata: { pinned: true } };
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
  const oldExt = { identifier: { id: "a.b" }, metadata: { inheritedFromProfile: "Base", pinned: true } };
  const result = convertOldMarkers(oldExt);
  assert.strictEqual(result.metadata?.inheritProfile?.inherited, true);
  assert.strictEqual(result.metadata?.inheritedFromProfile, undefined);
  assert.strictEqual(result.metadata?.pinned, true);
});

test("convertOldMarkers leaves new format unchanged", () => {
  const newExt = { identifier: { id: "a.b" }, metadata: { inheritProfile: { inherited: true } } };
  const result = convertOldMarkers(newExt);
  assert.deepStrictEqual(result, newExt);
});
```

---
  assert.strictEqual(extA?.metadata?.inheritProfile?.inherited, undefined);
});

test("resolveParentExtensionsPaths returns correct paths", () => {
  const profiles = { "Base": "/user/profiles/base", "Dev": "/user/profiles/dev" };
  const result = resolveParentExtensionsPaths(["Base", "Dev", "Missing"], profiles);
  assert.deepStrictEqual(result, [
    "/user/profiles/base/extensions.json",
    "/user/profiles/dev/extensions.json",
  ]);
});
```

---

### 1.7 `src/test/integration/extension.test.ts`

#### 新增测试

```typescript
test("reconciliation on startup marks inherited extensions with new marker", async () => {
  const child: ProfileDescriptor = { name: "Child", location: "child" };
  const parent: ProfileDescriptor = { name: "Parent", location: "parent" };

  await writeStorage(sandboxRoot, child, [parent]);
  await writeProfileExtensions(sandboxRoot, parent, [
    createExtension("parent.ext.a"),
    createExtension("parent.ext.b"),
  ]);
  await writeProfileExtensions(sandboxRoot, child, [
    createExtension("child.own"),
    createExtension("parent.ext.a"), // 父级也有, 应转为 inherited
  ]);

  await updateConfig("parents", ["Parent"]);
  await updateCurrentProfileInheritance(createContext(sandboxRoot));

  const extPath = path.join(getProfileDirectory(sandboxRoot, child), "extensions.json");
  const exts = JSON.parse(await fs.readFile(extPath, "utf8"));
  const extA = exts.find((e: any) => e.identifier.id === "parent.ext.a");
  const extB = exts.find((e: any) => e.identifier.id === "parent.ext.b");
  const own = exts.find((e: any) => e.identifier.id === "child.own");

  assert.strictEqual(extA?.metadata?.inheritProfile?.inherited, true, "parent.ext.a should be marked inherited");
  assert.strictEqual(extB?.metadata?.inheritProfile?.inherited, true, "parent.ext.b should be marked inherited");
  assert.strictEqual(own?.metadata?.inheritProfile, undefined, "child.own should not have inheritProfile marker");
  assert.strictEqual(own?.metadata?.inheritedFromProfile, undefined, "child.own should not have old marker");
});

test("removing extension from parent removes it from child after reconciliation", async () => {
  const child: ProfileDescriptor = { name: "Child", location: "child" };
  const parent: ProfileDescriptor = { name: "Parent", location: "parent" };

  await writeStorage(sandboxRoot, child, [parent]);
  await writeProfileExtensions(sandboxRoot, parent, [
    createExtension("ext.to.remove"),
  ]);
  await writeProfileExtensions(sandboxRoot, child, []);

  await updateConfig("parents", ["Parent"]);
  const ctx = createContext(sandboxRoot);
  await updateCurrentProfileInheritance(ctx);

  let extPath = path.join(getProfileDirectory(sandboxRoot, child), "extensions.json");
  let exts = JSON.parse(await fs.readFile(extPath, "utf8"));
  assert.ok(exts.some((e: any) => e.identifier.id === "ext.to.remove"), "should have inherited ext.to.remove");

  // 父级卸载
  await writeProfileExtensions(sandboxRoot, parent, []);
  await updateCurrentProfileInheritance(ctx);

  exts = JSON.parse(await fs.readFile(extPath, "utf8"));
  assert.ok(!exts.some((e: any) => e.identifier.id === "ext.to.remove"), "ext.to.remove should be gone");
});

test("optedOut extension persists across synchronizations", async () => {
  const child: ProfileDescriptor = { name: "Child", location: "child" };
  const parent: ProfileDescriptor = { name: "Parent", location: "parent" };

  await writeStorage(sandboxRoot, child, [parent]);
  await writeProfileExtensions(sandboxRoot, parent, [
    createExtension("ext.controversial"),
  ]);

  // 子级通过 optedOut 跳过
  await writeProfileExtensions(sandboxRoot, child, [
    { identifier: { id: "ext.controversial" }, metadata: { inheritProfile: { optedOut: true } } },
  ]);

  await updateConfig("parents", ["Parent"]);
  await updateCurrentProfileInheritance(createContext(sandboxRoot));

  const extPath = path.join(getProfileDirectory(sandboxRoot, child), "extensions.json");
  const exts = JSON.parse(await fs.readFile(extPath, "utf8"));
  const ext = exts.find((e: any) => e.identifier.id === "ext.controversial");

  // 必须有 optedOut 标记, 不能变成 inherited
  assert.strictEqual(ext?.metadata?.inheritProfile?.optedOut, true);
  assert.strictEqual(ext?.metadata?.inheritProfile?.inherited, undefined);
});

test("new extension added to parent triggers re-inheritance via watcher", async function () {
  this.timeout(20000);

  const child: ProfileDescriptor = { name: "Child", location: "child" };
  const parent: ProfileDescriptor = { name: "Parent", location: "parent" };

  await writeStorage(sandboxRoot, child, [parent]);
  await writeProfileSettings(sandboxRoot, child, `{ "editor.tabSize": 2 }\n`);
  await writeProfileSettings(sandboxRoot, parent, `{ "files.autoSave": "off" }\n`);
  await writeProfileExtensions(sandboxRoot, child, []);
  await writeProfileExtensions(sandboxRoot, parent, []);

  await updateConfig("parents", ["Parent"]);
  const ctx = createContext(sandboxRoot);

  try {
    await registerParentProfileSaveWatcher(ctx);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 父级新装扩展
    const parentExtPath = path.join(getProfileDirectory(sandboxRoot, parent), "extensions.json");
    await fs.writeFile(parentExtPath, JSON.stringify([createExtension("new.ext")], null, 4) + "\n", "utf8");

    // 等待 watcher 触发
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const childExtPath = path.join(getProfileDirectory(sandboxRoot, child), "extensions.json");
    const exts = JSON.parse(await fs.readFile(childExtPath, "utf8"));
    assert.ok(exts.some((e: any) => e.identifier.id === "new.ext"), "child should inherit new.ext");
    assert.strictEqual(
      exts.find((e: any) => e.identifier.id === "new.ext")?.metadata?.inheritProfile?.inherited,
      true,
    );
  } finally {
    for (const sub of ctx.subscriptions) sub.dispose();
  }
});
```

---

## Phase 2: 设置 Diff + 覆盖检测 + 跨设备恢复

### 2.1 父级设置快照

每次同步后，将当前**父级合并后设置的展平快照**存入 `globalState`，固定 key 以便跨设备同步：

```typescript
// 在 activate 中注册 (已由 Phase 1 完成)
context.globalState.setKeysForSync([
  "inheritProfile.extensionMarkers",
  "inheritProfile.parentSnapshots",
]);
```

**数据结构**：

```typescript
// globalState key: "inheritProfile.parentSnapshots"
// 固定 key, Record<profileName, Snapshot> 结构
interface Snapshot {
  settings: Record<string, any>;  // 父级合并后的展平设置
  updatedAt: number;              // 时间戳
}
```

#### 快照更新时机

在 `applyInheritedSettings` 完成 inherited block 重建后，将当前父级设置以展平格式存入 globalState：

```typescript
// applyInheritedSettings 末尾追加:
const parentSettingsFlat = flattenSettings(parentSettings);
await context.globalState.update(
  "inheritProfile.parentSnapshots",
  {
    ...(context.globalState.get("inheritProfile.parentSnapshots") ?? {}),
    [currentProfileName]: {
      settings: parentSettingsFlat,
      updatedAt: Date.now(),
    },
  }
);
```

### 2.2 Diff 算法

#### 三路比较逻辑

```
三路输入:
  A = Snapshot (上次同步时的父级展平设置)
  B = NewParent (当前父级的展平设置)
  C = CurrentInherited (当前 settings.json inherited block 中的设置)

输出:
  newInheritedBlock = 应写回 inherited block 的设置
  userOverrides    = 应移入自有区的设置 (用户修改过)

逐键处理:

1. 父级新增 (key in B, not in A):
   → 加入 newInheritedBlock (自动获得新功能)

2. 父级修改 (key in A and B, A[key] ≠ B[key]):
   - 如 C[key] = A[key] (用户没碰 inherited block) → newInheritedBlock[key] = B[key]
   - 如 C[key] ≠ A[key] (用户修改了 inherited block) → userOverrides[key] = C[key]
     (保留用户的值, 移入自有区, 不再写回 inherited block)

3. 父级删除 (key in A, not in B):
   - 如 C[key] 存在 (用户保留了) → userOverrides[key] = C[key]
   - 如 C[key] 不存在 → 自然消失

4. 用户自加 (key in C, not in A and not in B):
   → userOverrides[key] = C[key] (提醒用户放错了位置, 但保留值)
```

#### `src/profileSettings.ts` 新增: `diffInheritedSettings`

```typescript
import { parse } from "jsonc-parser";

/**
 * 解析 inherited block 中的设置。
 */
export function parseInheritedBlock(raw: string): Record<string, any> {
  const startIdx = raw.indexOf(INHERITED_SETTINGS_START_MARKER);
  const endIdx = raw.indexOf(INHERITED_SETTINGS_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return {};

  const block = raw.slice(startIdx + INHERITED_SETTINGS_START_MARKER.length, endIdx);
  const settings: Record<string, any> = {};
  const parsed = parse("{" + block + "}");
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && !key.startsWith("//") && key !== INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY) {
        settings[key] = value;
      }
    }
  }
  return settings;
}

/**
 * 三路 Diff 比较。
 *
 * @param snapshot  上次同步时的父级展平设置 (A)
 * @param newParent 当前父级的展平设置 (B)
 * @param current   当前 settings.json inherited block 中的设置 (C)
 * @returns { inherited, overrides } 应写回 inherited block 的和应移入自有区的
 */
export function diffInheritedSettings(
  snapshot: Record<string, any>,
  newParent: Record<string, any>,
  current: Record<string, any>,
): { inherited: Record<string, any>; overrides: Record<string, any> } {
  const inherited: Record<string, any> = {};
  const overrides: Record<string, any> = {};

  const allKeys = new Set([
    ...Object.keys(snapshot),
    ...Object.keys(newParent),
    ...Object.keys(current),
  ]);

  for (const key of allKeys) {
    const inSnapshot = key in snapshot;
    const inNewParent = key in newParent;
    const inCurrent = key in current;

    if (!inSnapshot && inNewParent) {
      // 父级新增 → 加入 inherited block
      inherited[key] = newParent[key];
    } else if (inSnapshot && inNewParent) {
      const snapVal = JSON.stringify(snapshot[key]);
      const newVal = JSON.stringify(newParent[key]);
      const curVal = inCurrent ? JSON.stringify(current[key]) : undefined;

      if (snapVal !== newVal) {
        // 父级改了值
        if (curVal === snapVal || curVal === undefined) {
          // 用户没碰 → 同步更新
          inherited[key] = newParent[key];
        } else {
          // 用户改过 → 保留用户值, 移出 inherited block
          overrides[key] = current[key];
        }
      } else if (inCurrent && curVal !== snapVal) {
        // 父级没变, 但用户改了 inherited block 中的值 → 移出
        overrides[key] = current[key];
      } else if (inCurrent) {
        // 没变化, 保留
        inherited[key] = current[key];
      } else {
        // inherited block 中缺失但父级仍有 → 重新加入 (恢复场景)
        inherited[key] = newParent[key];
      }
    } else if (inSnapshot && !inNewParent) {
      // 父级删了
      if (inCurrent) {
        // 用户保留了 → 移入自有区
        overrides[key] = current[key];
      }
      // 否则自然消失
    } else if (!inSnapshot && !inNewParent && inCurrent) {
      // 用户自己加在 inherited block 中 → 移入自有区
      overrides[key] = current[key];
    }
  }

  return { inherited, overrides };
}
```

#### `src/profiles.ts` — 改造 `applyInheritedSettings` 使用 Diff

将原先的 `parseInheritedBlock` + `detectOverrides` + 全量删除重写 替换为 Diff 流程:

```typescript
async function applyInheritedSettings(context: vscode.ExtensionContext): Promise<void> {
  const { currentProfileName, currentProfileDirectory, profiles } =
    await getCurrentProfileDetails(context);
  const currentProfilePath = path.join(currentProfileDirectory, "settings.json");

  // === Phase 2: 设置 Diff ===
  const rawBefore = await readRawSettingsFile(currentProfilePath);
  const currentInherited = parseInheritedBlock(rawBefore);
  let userOverrides: Record<string, any> = {};

  // 读快照
  const snapshots = context.globalState.get<Record<string, { settings: Record<string, any> }>>(
    "inheritProfile.parentSnapshots"
  ) ?? {};
  const snapshot = snapshots[currentProfileName]?.settings ?? {};

  // 读当前父级设置
  const config = vscode.workspace.getConfiguration("inheritProfile");
  const parentProfileNames = config.get<string[]>("parents", []);
  const parentSettings = await getProfileSettings(context, parentProfileNames);
  const newParentFlat = flattenSettings(parentSettings);

  if (Object.keys(currentInherited).length > 0 || Object.keys(snapshot).length > 0) {
    const diffResult = diffInheritedSettings(
      snapshot,
      newParentFlat,
      currentInherited,
    );
    userOverrides = diffResult.overrides;

    // 先删除 inherited block
    await removeInheritedSettingsFromFile(currentProfilePath);

    // 将 overrides 写回自有区（作为普通设置，不含 inherited block 标记）
    if (Object.keys(userOverrides).length > 0) {
      const rawAfterRemove = await readRawSettingsFile(currentProfilePath);
      const [beforeClose] = splitRawSettingsByClosingBrace(rawAfterRemove);
      const tab = findTabValue(rawAfterRemove);
      const overrideEntries = Object.entries(userOverrides)
        .map(([key, value]) => `${tab}"${key}": ${JSON.stringify(value)}`)
        .join(",\n");
      const updatedRaw = insertBeforeClose(beforeClose, overrideEntries);
      await writeManagedFile(currentProfilePath, updatedRaw + "\n");
    }

    // 重建 inherited block (写回父级仍有且用户没改的)
    // 复用现有的 writeInheritedSettings, 逻辑相同不做重复封装
    if (Object.keys(diffResult.inherited).length > 0) {
      await writeInheritedSettings(currentProfilePath, diffResult.inherited);
    }

    console.info(`Settings diff: ${Object.keys(diffResult.inherited).length} inherited, ${Object.keys(userOverrides).length} overrides.`);
  } else {
    // 无 inherited block 也无 snapshot → 全量重建 (Phase 1 兼容)
    await removeInheritedSettingsFromFile(currentProfilePath);
    const inheritedSettings = await getInheritedSettings(context);
    if (Object.keys(inheritedSettings).length > 0) {
      await writeInheritedSettings(currentProfilePath, inheritedSettings);
    }
  }

  // 更新快照
  await context.globalState.update(
    "inheritProfile.parentSnapshots",
    {
      ...snapshots,
      [currentProfileName]: {
        settings: newParentFlat,
        updatedAt: Date.now(),
      },
    }
  );

  // === 扩展继承 (同 Phase 1) ===
  // ...
}
```

### 2.3 跨设备恢复

跨设备恢复依赖 `setKeysForSync` 机制，两个固定 key 已在 Phase 1 中注册。

**恢复流程**：

1. 扩展在第二台设备上安装并启动
2. `activate` 中调用 `checkAndRestoreMarkers`
3. 检测 `extensions.json` 中无 inherited 标记
4. 从 `globalState.get("inheritProfile.extensionMarkers")` 读备份
5. 能找到备份 → 恢复标记（按 `extId → parentName` 映射还原）
6. 无备份 → 执行全量对账（从父级重新计算）

> `extensionMarkers` 的结构为 `Record<profileName, Record<extId, parentName>>`，
> 记录每个 inherited 扩展来自哪个父级。跨设备恢复时不仅能还原 inherited 标记，
> 还能精确知道扩展应从哪个父级继承，避免在有多父级时恢复错位。

同时，`parentSnapshots` 也被 Settings Sync 同步。第二台设备上如果继承了相同的父级设置体系，可以直接用快照做 Diff，避免初次同步时的设置冲突。

---

## 关键代码行索引

### Phase 1 改动清单

| 文件 | 行号(约) | 操作 | 内容 |
|------|---------|------|------|
| `profileSettings.ts` | 5 | 新增 | `INHERITED_PROFILE_META_KEY` 常量 |
| `profileSettings.ts` | 170 | 新增 | `InheritedProfileMeta` 接口 |
| `profileSettings.ts` | 175-230 | 新增 | 6 个辅助函数 + `resolveParentExtensionsPaths` |
| `profileSettings.ts` | 185 (原) | **重写** | `stripInheritedExtensions` |
| `profileSettings.ts` | 215 (原) | **重写** | `mergeInheritedExtensions` (返回 merged + originallyOwn) |
| `profiles.ts` | — | 新增 | `buildInheritanceGraph`, `getDescendants`, `getInheritanceGraph`, `invalidateInheritanceGraph` |
| `profiles.ts` | 575 (原) | **重写** | `collectInheritedExtensions` (加入 originallyOwn/optedOut 读写) |
| `profiles.ts` | 630 (原) | 修改 | `updateCurrentProfileInheritance` 加 `triggerProfileName` 参数 |
| `profiles.ts` | 386 (原) | 修改 | `applyInheritedSettings` 回写 `_originallyOwnExtensions`/`optedOutExtensions` |
| `profileWatchers.ts` | 147 (原) | 修改 | `registerParentProfileSaveWatcher` 加 extensions.json 监听 + debounce |
| `extension.ts` | 3-50 | **重写** | `activate` 加 forceReconcile、setKeysForSync、反向索引重建、checkAndRestoreMarkers |
| `package.json` | — | 修改 | 加 1 命令 + 3 配置项 |

### Phase 2 改动清单

| 文件 | 操作 | 内容 |
|------|------|------|
| `profileSettings.ts` | 新增 | `parseInheritedBlock()`, `diffInheritedSettings()` |
| `profiles.ts` | 修改 | `applyInheritedSettings` 改用 Diff 流程 |
| `extension.ts` | 已加 | `setKeysForSync(["inheritProfile.parentSnapshots"])` (Phase 1 已注册) |

---

## 测试计划

### Phase 1 单元测试 (新增 ~15 个)

| 测试 | 文件 |
|------|------|
| `isInheritedExtension returns true/false` | `profileSettings.test.ts` |
| `isOptedOutExtension returns true/false` | 同上 |
| `markExtensionAsInherited adds correct metadata` | 同上 |
| `markExtensionAsInherited preserves existing metadata` | 同上 |
| `markExtensionAsOptedOut creates minimal entry` | 同上 |
| `convertOldMarkers converts inheritedFromProfile` | 同上 |
| `convertOldMarkers leaves new format unchanged` | 同上 |
| `mergeInheritedExtensions full reconciliation flow` | 同上 |
| `mergeInheritedExtensions detects opt-out (user deleted)` | 同上 |
| `mergeInheritedExtensions handles originallyOwn revert` | 同上 |
| `mergeInheritedExtensions own→inherited→revert cycle` | 同上 |
| `resolveParentExtensionsPaths` | 同上 |
| `stripInheritedExtensions keeps optedOut entries` | 同上 (重写) |
| 3 个现有 merge 测试重写 | 同上 |

### Phase 1 集成测试 (新增 ~4 个)

| 测试 | 文件 |
|------|------|
| `reconciliation on startup marks inherited extensions` | `extension.test.ts` |
| `removing extension from parent removes from child` | 同上 |
| `optedOut extension persists across synchronizations` | 同上 |
| `new extension added to parent triggers via watcher` | 同上 |

### Phase 2 单元测试 (新增 ~3 个)

| 测试 | 文件 |
|------|------|
| `parseInheritedBlock extracts markers correctly` | `profileSettings.test.ts` |
| `diffInheritedSettings detects user modifications` | 同上 |
| `diffInheritedSettings handles parent removal correctly` | 同上 |

---

## 排除范围

- 多个父级的冲突解决（第一个父级优先，同现有行为）
- 对象类型设置的深度 merge（如 `files.exclude` 的逐字段合并，由 `NON_FLATTENABLE_SETTINGS` 处理）
- 扩展版本管理（子级 version 可高于父级，不降级）
