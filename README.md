<p align="center"><img align="center" width="280" src="branding/icon_1024.png"/><img align="center" width="280" src="branding/name.png"/></p>
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

### 📝 Examples
#### Inheriting from the Default Profile
```json
{
    "inheritProfile.parents": ["Default"]
}
```

#### Inheriting from Multiple Profiles
```json
{
    "inheritProfile.parents": ["Default", "My Other Profile"]
}
```

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

## 🎯 Future Plans
- [ ] Tidy up [`profiles.ts`](src/profiles.ts).
- [ ] Implement extension inheritance. This should be disabled by default, but
  should be possible to enable through configuration.
