# 待实现功能

> 上级（父 Profile）的配置要能集成到下级（子 Profile），包括扩展和设置。
> 当下级与上级配置有冲突时，以下级为准（子覆盖父）。

---

## 现有代码分析

### 当前已实现的部分

现有代码在 `src/profiles.ts` 和 `src/profileSettings.ts` 中已有继承基础：

| 机制 | 实现 |
|------|------|
| 父 Profile 声明 | `inheritProfile.parents` 配置项（如 `["Base"]`） |
| 设置继承 | `getInheritedSettings()` + `subtractSettings(parent, child)` → 子已有的设置不会被父覆盖 ✅ |
| 扩展继承 | `collectInheritedExtensions()` → 将父扩展标记 `metadata.inheritedFromProfile` 后合并到子 |
| 触发时机 | 启动时（`runOnStartup`）+ 切换 Profile 时（`runOnProfileChange`） |

**冲突策略（子覆盖父）在现有代码中已正确实现：**
- 设置：`subtractSettings()` 会跳过子 Profile 已有的 key
- 扩展：`collectInheritedExtensions()` 以子 Profile 已有的扩展 ID 为准，跳过重复项

### 存在的问题

1. **两套同步机制不统一**
   - Dev 使用 `inheritProfile.parents` 机制（带 `inheritedFromProfile` 标记）
   - Writing 是**直接复制** Base 的 `extensions.json`（无标记），导致修改 Base 后不同步

2. **只有"拉"没有"推"**
   - 仅在**当前** Profile 切换/启动时触发同步
   - 修改父 Profile 后，子 Profile 不会自动感知更新（除非切换到子 Profile）

3. **父删除扩展时，子会残留**
   - 如果子 Profile 的扩展是直接复制的（无 `inheritedFromProfile` 标记），父删除后子不会自动清理
   - 带标记的扩展会被过滤后重新从父收集，所以能正确同步删除 ✅

4. **没有 Profile 关系注册表**
   - 目前不知道哪些子 Profile 继承了哪些父 Profile
   - 需要从所有 Profile 的 settings.json 中读取 `inheritProfile.parents` 来推算

---

## 实现方案

### Phase 1：统一继承机制（优先级最高）

**目标：** 所有子 Profile 统一使用 `inheritProfile.parents` + `inheritedFromProfile` 标记机制

**改动点：**

```
Writing Profile
  ├── settings.json: 保留 inheritProfile.parents: ["Base"]
  └── extensions.json: 从"直接复制 Base" → "标记继承"
      即：第一次同步时，给所有来自 Base 的扩展打上 inheritedFromProfile 标记
```

具体实现：
- 在 `updateCurrentProfileInheritance()` 中增加判断：如果子 Profile 的扩展数几乎等于父 Profile（且无 inheritedFromProfile 标记），说明是"复制模式"，自动转换为"继承标记模式"
- 或者提供一条迁移命令，手动转换

### Phase 2：扩展合并增强（完整继承语义）

**当前** `collectInheritedExtensions()` 的逻辑：

```
1. 过滤掉子中标记了 inheritedFromProfile 的扩展
2. 从父收集扩展，不在子中的就标记 inheritedFromProfile 后加入
```

**行为分析**（已符合需求）：

| 场景 | 结果 |
|------|------|
| 父有、子无 | ✅ 继承到子（标记 inheritedFromProfile） |
| 父有、子也有 | ✅ 以子为准（跳过不覆盖） |
| 父无、子有（自有） | ✅ 保留子扩展 |
| 父无、子有（曾继承） | ✅ 被过滤掉，再从父收集不到，自然删除 |

**结论：** Phase 2 已有正确实现，只需保证所有子 Profile 都使用此机制即可。

### Phase 3：级联同步（父→子推送）

**目标：** 修改父 Profile 后，所有子 Profile 同步更新。

**设计原则：** 保持与现有机制一致——不引入文件监听，仅在切换 Profile 和加载插件时触发。

**方案：** 在 `updateInheritedSettingsOnProfileChange()` 中扩展：

```
当前行为：
  切到子 Profile → 子从父拉取继承（单向"拉"）

增强后行为：
  切到父 Profile → 父同步完后，自动找到所有子 Profile，依次推送更新（"拉"+"推"）
  切到子 Profile → 保持不变，子从父拉取继承
```

**伪代码：**

```typescript
async function updateCurrentProfileInheritance(context) {
  // 1. 先同步当前 Profile 自身的继承
  await applyInheritedSettings(context);
  
  // 2. 再查找继承了当前 Profile 的子 Profile，级联推送
  await cascadeSyncToChildren(context, currentProfileName);
}

async function cascadeSyncToChildren(context, parentProfileName) {
  const allProfiles = await getProfileMap(context);
  
  for (const [profileName, profileDir] of Object.entries(allProfiles)) {
    if (profileName === parentProfileName) continue; // 跳过自己
    const settingsPath = path.join(profileDir, "settings.json");
    const settings = await readJSON(settingsPath);
    const parents = settings?.inheritProfile?.parents ?? [];
    
    if (parents.includes(parentProfileName)) {
      // 触发子 Profile 的继承同步
      await applyInheritedSettingsForProfile(context, profileName, profileDir);
    }
  }
}
```

**触发时机（沿用现有机制）：**

| 时机 | 说明 |
|------|------|
| VS Code 启动 | `runOnStartup` 配置控制 |
| 切换 Profile | `runOnProfileChange` 搭配 `storage.json` 文件变化检测（已有实现） |
| 手动命令 | "Apply Inheritance to Current Profile"（已有命令） |

> ✅ 无需额外文件监听，全复用已有基础设施。

### Phase 4：设置合并迁移——从 "subtract" 到 "显式合并块"

**当前实现**：用 `subtractSettings()` 剔除子已有的设置，只写缺失的部分到 inherited 块。

**这是正确的✅**，但有一个局限：

```
父 settings.json:
  { "editor.fontSize": 14, "editor.tabSize": 4 }

子 settings.json（当前）:
  { "editor.fontSize": 16 }

继承结果：
  子 inherited 块 → { "editor.tabSize": 4 }
  子最终可见     → { "editor.fontSize": 16, "editor.tabSize": 4 }  ← ✅ 正确
```

但如果父修改了 `editor.tabSize: 4 → 6`，当前机制能检测到变化吗？

**验证：** `getInheritedSettings()` → `subtractSettings(parentSettings, currentChildSettings)` → 只要子没有显式定义 `editor.tabSize`，就会从父拿到新值。**✅ 能同步更新。**

**结论：** Phase 4 当前已正确实现，无需改动。

### Phase 5：Profile 关系可视化

**目标：** 在状态栏或树视图中显示当前的继承链路。

可选的增强功能：
- 在 `profiles.ts` 中新增函数 `getInheritanceTree()`，返回 Profile 的继承关系树
- 在 VS Code 状态栏显示当前 Profile 的名称和父 Profile
- 提供一个树视图，展示所有 Profile 的继承关系

---

## 实现路线图

| 优先级 | 阶段 | 工作量 | 说明 |
|--------|------|--------|------|
| 🔴 P0 | Phase 1: 统一继承机制 | 小 | Writing 从复制模式迁移到标记模式 |
| 🟡 P1 | Phase 3: 级联同步 | 中 | 父 Profile 变更时触发子更新 |
| 🟢 P2 | Phase 5: 关系可视化 | 小 | 可选增强功能 |

## 技术关键点

1. **避免同步循环**：A 继承 B，B 继承 A → 需要检测循环依赖
2. **文件写入节流**：批量修改时避免频繁写盘
3. **用户通知**：后台同步完成后通知用户变更情况
4. **出错不回退**：某个子 Profile 同步失败不应影响其他子 Profile

