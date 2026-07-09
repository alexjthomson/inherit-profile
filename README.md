<p align="center"><img width="25%" src="branding/icon_1024.png"/><img src="branding/name.png"/></p>
<h3 align="center">Enables profile inheritance in VisualStudio Code!</h3>
<h4 align="center"><a href="https://marketplace.visualstudio.com/items?itemName=alexthomson.inherit-profile" target="_blank">View in Marketplace</a></h3>
<hr>

## ⚙️ Configuration

Make sure you have this extension installed on the profile you would like to
inherit settings onto.

**Important**: After updating the inheritance configuration for your profile,
you need to run the `Apply Profile Inheritance (Current Profile)` command. This
will fetch the inherited settings from your chosen profiles. By default this
will automatically execute every time you change profile and every time the
extension starts.

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
        "inheritExtensions": true,
        "showMessages": false
    }
}
```

> **Note**: Set `inheritExtensions` to `false` if you only want to inherit settings and not extensions from your parent profiles.

> **Note**: Set `runOnCurrentProfileSave` to `false` if you don't want inheritance to be re-applied automatically whenever you edit and save the current profile's `settings.json`.

---

## 💡 How Does This Extension Work?

This extension allows you to inherit from multiple other profiles. In order to apply settings, you must include them in either the global, workspace, workspace file, or profile settings file. This extension places inherited settings directly into the profile `settings.json`, and it also merges inherited extensions into the profile `extensions.json`.

### 1: Collecting the Inherited Settings

First, the extension will read the settings for each of the profiles you have elected to inherit from. It will then flatten each of the settings keys into a single string key and store it alongside it's value. As the extension iterates through the different `settings.json` files from each inherited profile, it will override any existing settings with new ones. This is done according to the order that the profiles appear in in the `inheritProfile.parents` setting.

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

The final inherited settings are then inserted into the current profile between a start and an end marker. This will result in the final configuration for the profile:

```json
{
    "one": {
        "hello": "something"
    },
    // --- INHERITED SETTINGS MARKER START --- //
    "two": "some other value",
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}
```

> **Note**: It is important that the start and end markers and the `inheritProfile._insertionBoundary` setting are left alone. The extension uses them to identify the inherited settings block, and the dummy setting keeps newly added settings outside the protected section.

---

## 🎯 Future Plans

- [x] Update the profile inheritance when the current profile is saved. This should have a configuration entry for it.
- [ ] Update the profile inheritance when one of the parent profiles is saved. This should have a configuration entry for it.
- [x] Insert inherited settings alphabetically.
- [x] Implement formatting for inherited settings (indentation).
- [x] Add a warning comment inside the inherited settings.
- [ ] Tidy up [`profiles.ts`](src/profiles.ts).
- [x] Implement extension inheritance.
- [x] Add a configuration option to disable extension inheritance.
- [x] Implement unit testing.
