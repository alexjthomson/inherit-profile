<p align="center"><img width="25%" src="branding/icon_1024.png"/><img src="branding/name.png"/></p>
<h3 align="center">Enables profile inheritance in VisualStudio Code!</h3>
<h4 align="center"><a href="https://marketplace.visualstudio.com/items?itemName=luotianyiismywife.inherit-profile-plus" target="_blank">View in Marketplace</a></h3>

> **ℹ️ This is a community-maintained fork** with VS Code 1.127+ compatibility fixes.
> [Original repo](https://github.com/alexjthomson/inherit-profile) by alexjthomson.
>
> **Extension ID:** `luotianyiismywife.inherit-profile-plus`
>
> **Install directly in VS Code:** Search for `Inherit Profile Plus` in the Extensions panel.

<hr>

## ⚙️ Configuration

Make sure you have this extension installed on the profile you would like to
inherit settings onto.

**Important**: After updating the inheritance configuration for your profile,
you need to run the `Apply Profile Inheritance (Current Profile)` command. This
will fetch the inherited settings from your chosen profiles. By default this
will automatically execute on extension startup, whenever you switch profiles,
whenever the current profile's `settings.json` is saved, and whenever a parent
profile's `settings.json` is saved. Each of these triggers can be disabled
individually — see `runOnStartup`, `runOnProfileChange`,
`runOnCurrentProfileSave`, and `runOnParentProfileSave` below.

**Inheritance Priority**: This extension respects the settings you declare in your profile. Settings decalared in the current profile will take priority over inherited settings. Additionally, the order that you inherit from also matters; the extension will prioritise later profiles, meaning that if you inherit from `Default`, then from `My Other Profile`, the latter profile may shadow settings inherited from `Default` if the settings share the same keys.

### 📝 Examples

#### Inheriting from the Default Profile

```json
{
    "inheritProfile.parents": ["Default"]
}
```

> **Note**: If you have custom profiles, should use the name of the profiles you want to inherit from here.

#### Inheriting from Multiple Profiles

```json
{
    "inheritProfile.parents": ["Default", "My Other Profile"]
}
```

> **Note**: Order matters, this configuration will instruct the extension to first inherit from `Default`, followed by `My Other Profile`. In practice, this means that `My Other Profile` will override any inherited settings from `Default` which have the same key. You should place more important profiles towards the end of this list.

#### Full Configuration

```json
{
    "inheritProfile": {
        "parents": ["Default"],
        "runOnStartup": true,
        "runOnProfileChange": true,
        "runOnCurrentProfileSave": true,
        "runOnParentProfileSave": true,
        "inheritExtensions": true,
        "showMessages": false
    }
}
```

> **Note**: Set `inheritExtensions` to `false` if you only want to inherit settings and not extensions from your parent profiles.

> **Note**: Set `runOnCurrentProfileSave` to `false` if you don't want inheritance to be re-applied automatically whenever you edit and save the current profile's `settings.json`.

> **Note**: Set `runOnParentProfileSave` to `false` if you don't want inheritance to be re-applied automatically whenever you edit and save one of your parent profiles' `settings.json`.

---

## 💡 How Does This Extension Work?

This extension allows you to inherit from multiple other profiles. In order to apply settings, you must include them in either the global, workspace, workspace file, or profile settings file. This extension places inherited settings directly into the profile `settings.json`, and it also merges inherited extensions into the profile `extensions.json`.

Whenever inheritance is (re-)applied — whether triggered automatically or via the `Apply Profile Inheritance (Current Profile)` command — the extension collects settings and extensions from the configured parent profiles, works out what's missing from the current profile, and writes the result back into the current profile. The following sections walk through each of those steps.

### 🔁 Keeping Inheritance Up to Date

Beyond running the command manually, the extension can automatically re-apply
inheritance in response to several events, each with its own configuration
option:

- `runOnStartup` *(default: `true`)* — when the extension activates.
- `runOnProfileChange` *(default: `true`)* — when you switch to a different profile.
- `runOnCurrentProfileSave` *(default: `true`)* — when the current profile's `settings.json` is edited and saved (e.g. by hand, or by something other than this extension).
- `runOnParentProfileSave` *(default: `true`)* — when any parent profile's `settings.json` is edited and saved.

> **Note**: The extension keeps track of the content it writes to each
> settings file, so its own writes never trigger another re-application of
> inheritance — only genuine external edits do. This avoids infinite update
> loops.

> **Note**: Changing the `inheritProfile.parents` list itself does not
> immediately re-apply inheritance to the current profile, since nothing has
> been saved yet. Run the `Apply Profile Inheritance (Current Profile)`
> command afterwards, or wait for the current or a parent profile's
> `settings.json` to next be saved.

### 1: Collecting the Inherited Settings

First, the extension will read the settings for each of the profiles you have elected to inherit from. It will then flatten each of the settings keys into a single string key and store it alongside its value. As the extension iterates through the different `settings.json` files from each inherited profile, it will override any existing settings with new ones. This is done according to the order that the profiles appear in in the `inheritProfile.parents` setting.

> **Note**: A small set of well-known settings whose value is itself a JSON
> object — for example `files.exclude`, `search.exclude`, and
> `workbench.colorCustomizations` — are **not** flattened. The keys inside
> these objects are user-defined data (glob patterns, colour identifiers,
> etc.) rather than nested setting names, so flattening them would corrupt
> the setting. These are instead inherited or overridden as a single, whole
> value (see [issue #5](https://github.com/alexjthomson/inherit-profile/issues/5)).

Let's say you have two profiles you want to inherit from:

#### 📝 Profile 1

```json
{
    "one": {
        "hello": "world"
    },
    "two": "some value"
}
```

#### 📝 Profile 2

```json
{
    "two": "some other value"
}
```

> **Note**: This profile also has the `"two"` setting. The extension will resolve which value to use based on the order that the parent profiles are declared later on.

#### 🎬 Result

Let's say you want to inherit using `"inheritProfile.parents": [ "Profile 1", "Profile 2" ]`; the inherited settings will evaluate to this:

```json
{
    "one.hello": "world",
    "two": "some other value"
}
```

> **Note**: You can see that the `"one": { "hello": "world" }` was flattened into `"one.hello": "world`. This allows the extension to efficiently override and subtract settings keys during the inheritance process.

### 2: Subtracting the Current Profile Settings from the Inherited Settings

After finding the inherited settings, the extension will then check what settings are already included in the current profile. For example, if we take the output from the previous stage, and our current profile is the following:

```json
{
    "one": {
        "hello": "something"
    }
}
```

the extension will subtract the current profile settings from the inherited settings, giving us a final list of inherited settings that are missing from the current profile:

```json
{
    "two": "some other value"
}
```

> **Note**: Since `"one.hello"` was already defined in the current profile, the extension knows not to inherit this from the parent profiles since the current profile takes priority.

### 3: Inserting the Final Inherited Settings

The final inherited settings are then inserted into the current profile between a start and an end marker, alongside a warning comment and an `inheritProfile._insertionBoundary` setting that marks where the inherited block ends. This will result in the final configuration for the profile:

```json
{
    "one": {
        "hello": "something"
    },
    // --- INHERITED SETTINGS MARKER START --- //
    // WARNING: Do not remove the inherited settings start and end markers.
    //          The markers are used to identify inserted inherited settings.
    "two": "some other value",
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}
```

> **Note**: It is important that the start and end markers, the warning comment, and the `inheritProfile._insertionBoundary` setting are left alone. The extension uses them to identify the inherited settings block, and the dummy setting keeps newly added settings outside the protected section.

### 4: Inheriting Extensions

Unless disabled via `inheritExtensions`, the extension performs a similar process for each parent profile's `extensions.json`:

- Any extension already declared by the current profile always wins, so it is never overridden by an inherited one.
- If more than one parent profile declares the same extension, the first parent profile to declare it (in `inheritProfile.parents` order) wins.
- Newly inherited extensions are tagged with a `metadata.inheritedFromProfile` field, so the extension can tell them apart from extensions you installed directly into the current profile.

> **Note**: Setting `inheritExtensions` to `false` only stops *new* extensions from being inherited going forward — it does not remove extensions that were already inherited previously. Run the `Remove Inherited Settings (Current Profile)` command to strip both the inherited settings block and any previously inherited extensions from the current profile.

---

## 🤝 Contributing

Contributions are welcome! This project follows the standard GitHub
contribution flow:

1. Fork the repository and create a branch for your change.
2. Make your changes, keeping to the existing code style.
3. Add or update unit tests (and integration tests, where relevant) covering your changes — see [`src/test`](src/test).
4. Make sure everything passes:
   ```bash
   npm run compile
   npm run lint
   npm run unit-test
   npm test
   ```
5. Open a pull request describing what you changed and why.

If you're planning a larger change, consider opening an issue first to discuss it.

---

## 📖 Commands

| Command | Action |
|---------|--------|
| **Inherit Profile: Apply Inheritance** | Apply inheritance for the current profile |
| **Inherit Profile: Remove Inherited Settings** | Strip inherited settings & extensions from current profile |
| **Inherit Profile: Set Parent Profiles** | Pick parent profiles via QuickPick list |
| **Inherit Profile: Show Inheritance Tree** | Display profile inheritance tree in Output panel |
| **Inherit Profile: Force Full Reconciliation** | Rebuild all profiles from roots down (BFS order) |

---

## ⚠️ Known Limitations

### Profile Switching Auto-Detection

VS Code 1.127+ moved profile tracking from `storage.json` into internal runtime state, so automatic detection of profile switches is no longer reliable. **Use `Force Full Reconciliation` after switching profiles** to ensure child profiles are up-to-date. This applies settings **and** extensions from all parent profiles down through the hierarchy.

As a result, the **Show Inheritance Tree** command can no longer display which profile is currently active (the "▶" marker has been removed). The tree shows the inheritance hierarchy only.

### Focus on Extension Inheritance

This fork focuses on **extension inheritance first** — settings inheritance is functional but secondary. The primary use case is maintaining consistent extensions across profile hierarchies (Base → Dev → Rust, etc.).

---

## 🔧 Development Setup

1. Clone the repo and run `npm install`
2. Press **F5** to launch an Extension Development Host window
3. Make changes, then **Ctrl+R** (reload) the test window
4. Console output appears in the main window's **Debug Console**

> **Note**: The extension is registered with a **publisher ID**, so the installed VSIX version (from Marketplace) and the development version can conflict in the test window. The `launch.json` uses `--disable-extension=luotianyiismywife.inherit-profile-plus` to prevent this. If you see version 1.0.0 in the test window, ensure the `preLaunchTask` compiles before launching (the default `npm: watch` does this correctly).
