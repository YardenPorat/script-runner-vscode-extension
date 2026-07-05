# Monorepo Script Runner

Discover, group, annotate and run `package.json` scripts across a monorepo.

## Features

- Scans every `package.json` in the workspace (excluding `node_modules` by default) and lists all scripts in a dedicated activity-bar view.
- Scripts without a custom group are shown in a hierarchic folder tree mirroring the monorepo layout (single-child folder chains are compacted, e.g. `packages/tools`).
- Group scripts with free-form group names — groups appear at the top of the view; drag scripts between groups, onto other scripts, or back onto a folder to ungroup.
- Add a comment to any script — shown next to it in the tree and in its tooltip.
- Click a script to run it in a dedicated terminal (one terminal per script, reused across runs), with the package manager auto-detected from lockfiles (`pnpm` / `yarn` / `bun` / `npm`).
- Groups and comments persist to a committable `script-runner.config.json` at the workspace root — edit it via the UI or directly in JSON; the view refreshes automatically.
- **Open in Editor** opens the same script tree as a webview in the editor area — pin it as a tab, filter scripts, and run with a click. It stays in sync with the sidebar view and config.
- Collapse the whole tree at once with the sidebar's collapse-all button.

## Config file

```json
{
  "groups": ["Build", "Test"],
  "scripts": {
    "packages/app#dev": { "group": "Build", "comment": "Starts the dev server on :3000" },
    "packages/lib#test": { "group": "Test" }
  }
}
```

Keys are `<package-dir-relative-to-workspace-root>#<script-name>` (root package uses `#<script-name>`). `groups` optionally fixes group ordering.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `scriptRunner.configFile` | `script-runner.config.json` | Config file path, relative to the workspace root |
| `scriptRunner.packageManager` | `auto` | `auto` detects from lockfiles, or force `npm`/`yarn`/`pnpm`/`bun` |
| `scriptRunner.exclude` | `node_modules`, `dist`, `out`, `.git` | Globs excluded when scanning for `package.json` |

## Commands

- **Run Script** — also on click / inline play button
- **Assign Group…**, **Edit Comment…**, **Remove from Group**, **Rename Group…** — context menu
- **Refresh Scripts**, **Open in Editor**, **Open Config File** — view title bar
