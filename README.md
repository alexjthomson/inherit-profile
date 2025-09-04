# inherit-profile
Enables profile inheritance in VisualStudio Code!

---

## Configuration Example
Make sure you have this extension installed on the profile you would like to
inherit settings onto.

### Inheriting from the Default Profile
`settings.json`
```json
{
    "inheritProfile.parents": ["Default"]
}
```

### Inheriting from Multiple Profiles
`settings.json`
```json
{
    "inheritProfile.parents": ["Default", "My Other Profile"]
}
```

### Full Configuration
`settings.json`
```json
{
    "inheritProfile": {
        "parents": ["Default"],
        "runOnStartup": true,
        "runOnProfileChange": true
    }
}
```

---

## Project TODOs
- [ ] Tidy up [`profiles.ts`](src/profiles.ts).
- [ ] Implement extension inheritance. This should be disabled by default, but
  should be possible to enable through configuration entries.