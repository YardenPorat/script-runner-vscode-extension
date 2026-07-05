# CLAUDE.md

## Release after a new feature

After adding a new feature, always:

1. Bump the `version` in `package.json` (semver: minor for features, patch for fixes).
2. Compile: `npm run compile`.
3. Pack a new VSIX: `npm run package` (outputs to `out-packaged/`).
