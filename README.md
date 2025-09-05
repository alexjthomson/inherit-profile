<p align="center"><img width="25%" src="branding/icon_1024.png"/><img src="branding/name.png"/></p>
<h3 align="center">Enables profile inheritance in VisualStudio Code!</h3>
<h4 align="center"><a href="https://marketplace.visualstudio.com/items?itemName=alexthomson.inherit-profile" target="_blank">View in Marketplace</a></h3>
<hr>

## ⚙️ Configuration
Make sure you have this extension installed on the profile you would like to
inherit settings onto.

__Important__: After updating the inheritance configuration for your profile,
you need to run the `Apply Profile Inheritance (Current Profile)` command. This
will fetch the inherited settings from your chosen profiles. By default this
will automatically execute every time you change profile and every time the
extension starts.

__Inheritance Priority__: This extension respects the settings you declare in your profile. Settings decalared in the current profile will take priority over inherited settings. Additionally, the order that you inherit from also matters; the extension will prioritise later profiles, meaning that if you inherit from `Default`, then from `My Other Profile`, the latter profile may shadow settings inherited from `Default` if the settings share the same keys.

### 📝 Examples
#### Inheriting from the Default Profile
```json
{
    "inheritProfile.parents": ["Default"]
}
```
> __Note__: If you have custom profiles, should use the name of the profiles you want to inherit from here.

#### Inheriting from Multiple Profiles
```json
{
    "inheritProfile.parents": ["Default", "My Other Profile"]
}
```
> __Note__: Order matters, this configuration will instruct the extension to first inherit from `Default`, followed by `My Other Profile`. In practice, this means that `My Other Profile` will override any inherited settings from `Default` which have the same key. You should place more important profiles towards the end of this list.

#### Full Configuration
```json
{
    "inheritProfile": {
        "parents": ["Default"],
        "runOnStartup": true,
        "runOnProfileChange": true,
        "showMessages": false
    }
}
```

---

## 💡 How Does This Extension Work?
This extension allows you to inherit from multiple other profiles. In order to apply settings, you must include them in either the global, workspace, workspace file, or profile settings file. This extension places inherited settings directly into the profile `settings.json`.

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
> __Note__: This profile also has the `"two"` setting. The extension will resolve which value to use based on the order that the parent profiles are declared later on.

#### 🎬 Result
Let's say you want to inherit using `"inheritProfile.parents": [ "Profile 1", "Profile 2" ]`; the inherited settings will evaluate to this:
```json
{
    "one.hello": "world",
    "two": "some other value"
}
```
> __Note__: You can see that the `"one": { "hello": "world" }` was flattened into `"one.hello": "world`. This allows the extension to efficiently override and subtract settings keys during the inheritance process.

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
> __Note__: Since `"one.hello"` was already defined in the current profile, the extension knows not to inherit this from the parent profiles since the current profile takes priority.

### 3: Inserting the Final Inherited Settings
The final inherited settings are then inserted into the current profile between a start and an end marker. This will result in the final configuration for the profile:
```json
{
    "one": {
        "hello": "something"
    },
    // --- INHERITED SETTINGS MARKER START --- //
    "two": "some other value"
    // --- INHERITED SETTINGS MARKER END --- //
}
```
> __Note__: It is important that the start and end markers are left alone. These are used by the extension to identify the settings that have been inherited to the current profile.

---

## 🎯 Future Plans
- [ ] Update the profile inheritance when the current profile is saved. This should have a configuration entry for it.
- [ ] Update the profile inheritance when one of the parent profiles is saved. This should have a configuration entry for it.
- [x] Insert inherited settings alphabetically.
- [x] Implement formatting for inherited settings (indentation).
- [x] Add a warning comment inside the inherited settings.
- [ ] Tidy up [`profiles.ts`](src/profiles.ts).
- [ ] Implement extension inheritance. This should be disabled by default, but
  should be possible to enable through configuration.
- [ ] Implement unit testing.
- [ ] Implement proper CI with auto-release.
