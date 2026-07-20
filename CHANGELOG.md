# Changelog

All notable changes to the **Monorepo Script Runner** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.0] - 2026-07-18

### Added

- Script renaming: give any script a display-name override without touching `package.json`.
- Undo / redo for config changes (grouping, comments, ordering, renames).
- Drag-and-drop reordering of scripts, groups, and folders with persisted sort order.
- **Open in Editor** webview panel that mirrors the sidebar view and survives reloads.

### Changed

- `groups` in the config file is now an index map (`{ "Build": 0 }`); the legacy
  ordered-array form is still read and migrated automatically.
- Terminal management reworked: one reusable terminal per script.

## [0.13.2] - earlier

- Terminal management improvements and webview panel restoration.

## [0.12.0] - earlier

- Script renaming and folder/group collapse-state management.

## [0.9.2] - earlier

- Script sorting and folder management.

## [0.8.1] - earlier

- Script grouping; publisher and author metadata.

## [0.7.0] - earlier

- Commands to copy script details and open a terminal in the working directory.
