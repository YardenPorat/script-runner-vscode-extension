import * as vscode from "vscode";
import * as path from "path";

export interface ScriptInfo {
  /** Stable id: `<pkgRelDir>#<scriptName>` */
  id: string;
  /** Actual script name in package.json (used to run it) */
  name: string;
  /** User-facing rename override; does not change package.json */
  displayName?: string;
  command: string;
  /** Workspace-relative directory of the package ('' for root) */
  pkgRelDir: string;
  /** Absolute directory of the package */
  pkgDir: string;
  packageName: string;
  workspaceFolder: vscode.WorkspaceFolder;
  group?: string;
  comment?: string;
  /** Sort index within its container (group or folder); undefined sorts last. */
  order?: number;
  /** Pin to the tree root regardless of the package's folder */
  root?: boolean;
}

export interface ScriptEntry {
  group?: string;
  comment?: string;
  order?: number;
  /** Display name override; does not change package.json */
  displayName?: string;
  /** Pin to the tree root regardless of the package's folder */
  root?: boolean;
}

export interface RunnerConfig {
  $schema?: string;
  /** Group sort index at the root, keyed by group name (shares the index space with folders/scripts) */
  groups?: Record<string, number>;
  /** Folder sort index, keyed by workspace-relative folder path */
  folders?: Record<string, number>;
  /** Keyed by `<pkgRelDir>#<scriptName>` */
  scripts: Record<string, ScriptEntry>;
}

function configUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const rel = vscode.workspace
    .getConfiguration("scriptRunner")
    .get<string>("configFile", "script-runner.config.json");
  return vscode.Uri.joinPath(folder.uri, rel);
}

const MAX_HISTORY = 50;

/** Normalized form used for persistence and change detection. */
function cleanConfig(config: RunnerConfig): RunnerConfig {
  const clean: RunnerConfig = { scripts: {} };
  if (config.groups && Object.keys(config.groups).length) {
    clean.groups = config.groups;
  }
  if (config.folders && Object.keys(config.folders).length) {
    clean.folders = config.folders;
  }
  for (const [key, entry] of Object.entries(config.scripts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const e: ScriptEntry = {};
    if (entry.group) {
      e.group = entry.group;
    }
    if (entry.comment) {
      e.comment = entry.comment;
    }
    if (typeof entry.order === "number") {
      e.order = entry.order;
    }
    if (entry.displayName) {
      e.displayName = entry.displayName;
    }
    if (entry.root) {
      e.root = true;
    }
    if (e.group || e.comment || typeof e.order === "number" || e.displayName || e.root) {
      clean.scripts[key] = e;
    }
  }
  return clean;
}

export class ConfigStore {
  private readonly undoStack: RunnerConfig[] = [];
  private readonly redoStack: RunnerConfig[] = [];

  async load(): Promise<RunnerConfig> {
    const uri = configUri();
    if (!uri) {
      return { scripts: {} };
    }
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as Omit<
        RunnerConfig,
        "groups"
      > & { groups?: string[] | Record<string, number> };
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.scripts !== "object" ||
        parsed.scripts === null
      ) {
        return { scripts: {} };
      }
      // Migrate the legacy ordered-array form to the index map.
      if (Array.isArray(parsed.groups)) {
        parsed.groups = Object.fromEntries(parsed.groups.map((g, i) => [g, i]));
      }
      return parsed as RunnerConfig;
    } catch {
      return { scripts: {} };
    }
  }

  private async write(config: RunnerConfig): Promise<void> {
    const uri = configUri();
    if (!uri) {
      void vscode.window.showErrorMessage(
        "Script Runner: open a workspace folder to save the config.",
      );
      return;
    }
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(cleanConfig(config), null, 2) + "\n", "utf8"),
    );
  }

  async save(config: RunnerConfig): Promise<void> {
    const prev = await this.load();
    // Record history only for real changes so undo never appears to do nothing.
    if (JSON.stringify(cleanConfig(prev)) !== JSON.stringify(cleanConfig(config))) {
      this.undoStack.push(prev);
      if (this.undoStack.length > MAX_HISTORY) {
        this.undoStack.shift();
      }
      this.redoStack.length = 0;
    }
    await this.write(config);
  }

  /** Revert the last extension-made config change. Returns false when there is nothing to undo. */
  async undo(): Promise<boolean> {
    const prev = this.undoStack.pop();
    if (!prev) {
      return false;
    }
    this.redoStack.push(await this.load());
    await this.write(prev);
    return true;
  }

  /** Re-apply the last undone config change. Returns false when there is nothing to redo. */
  async redo(): Promise<boolean> {
    const next = this.redoStack.pop();
    if (!next) {
      return false;
    }
    this.undoStack.push(await this.load());
    await this.write(next);
    return true;
  }

  async update(id: string, patch: ScriptEntry): Promise<void> {
    const config = await this.load();
    const entry = { ...config.scripts[id], ...patch };
    config.scripts[id] = entry;
    await this.save(config);
  }

  getUri(): vscode.Uri | undefined {
    return configUri();
  }
}

export async function scanScripts(store: ConfigStore): Promise<ScriptInfo[]> {
  const excludes = vscode.workspace
    .getConfiguration("scriptRunner")
    .get<string[]>("exclude", ["**/node_modules/**"]);
  const files = await vscode.workspace.findFiles(
    "**/package.json",
    `{${excludes.join(",")}}`,
  );
  const config = await store.load();
  const scripts: ScriptInfo[] = [];

  for (const file of files) {
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (!folder) {
      continue;
    }
    let pkg: { name?: string; scripts?: Record<string, string> };
    try {
      const raw = await vscode.workspace.fs.readFile(file);
      pkg = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      continue;
    }
    if (!pkg.scripts) {
      continue;
    }
    const pkgDir = path.dirname(file.fsPath);
    const pkgRelDir = path
      .relative(folder.uri.fsPath, pkgDir)
      .split(path.sep)
      .join("/");
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (typeof command !== "string") {
        continue;
      }
      const id = `${pkgRelDir}#${name}`;
      const entry = config.scripts[id];
      scripts.push({
        id,
        name,
        displayName: entry?.displayName,
        command,
        pkgRelDir,
        pkgDir,
        packageName:
          pkg.name ?? (pkgRelDir || path.basename(folder.uri.fsPath)),
        workspaceFolder: folder,
        group: entry?.group,
        comment: entry?.comment,
        order: entry?.order,
        root: entry?.root,
      });
    }
  }

  scripts.sort(
    (a, b) =>
      a.pkgRelDir.localeCompare(b.pkgRelDir) || a.name.localeCompare(b.name),
  );
  return scripts;
}
