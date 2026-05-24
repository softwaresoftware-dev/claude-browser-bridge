# Extension Versioning

When changing any file in this extension (manifest.json, background.js, etc.), bump the version in `manifest.json` before committing:

- **Patch** (x.y.Z): permission changes, bug fixes, minor tweaks
- **Minor** (x.Y.0): new features, new API handlers
- **Major** (X.0.0): breaking protocol changes, architecture rewrites

The user needs to reload the extension from `brave://extensions` after every change — the version number is the only way to confirm the right code is loaded.
