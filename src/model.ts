import * as vscode from 'vscode';
import * as path from 'path';

export interface ScriptInfo {
    /** Stable id: `<pkgRelDir>#<scriptName>` */
    id: string;
    name: string;
    command: string;
    /** Workspace-relative directory of the package ('' for root) */
    pkgRelDir: string;
    /** Absolute directory of the package */
    pkgDir: string;
    packageName: string;
    workspaceFolder: vscode.WorkspaceFolder;
    group?: string;
    comment?: string;
}

export interface ScriptEntry {
    group?: string;
    comment?: string;
}

export interface RunnerConfig {
    $schema?: string;
    /** Optional explicit group ordering */
    groups?: string[];
    /** Keyed by `<pkgRelDir>#<scriptName>` */
    scripts: Record<string, ScriptEntry>;
}

function configUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    const rel = vscode.workspace.getConfiguration('scriptRunner').get<string>('configFile', 'script-runner.config.json');
    return vscode.Uri.joinPath(folder.uri, rel);
}

export class ConfigStore {
    async load(): Promise<RunnerConfig> {
        const uri = configUri();
        if (!uri) {
            return { scripts: {} };
        }
        try {
            const raw = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as RunnerConfig;
            if (typeof parsed !== 'object' || parsed === null || typeof parsed.scripts !== 'object' || parsed.scripts === null) {
                return { scripts: {} };
            }
            return parsed;
        } catch {
            return { scripts: {} };
        }
    }

    async save(config: RunnerConfig): Promise<void> {
        const uri = configUri();
        if (!uri) {
            void vscode.window.showErrorMessage('Script Runner: open a workspace folder to save the config.');
            return;
        }
        const clean: RunnerConfig = { scripts: {} };
        if (config.groups?.length) {
            clean.groups = config.groups;
        }
        for (const [key, entry] of Object.entries(config.scripts).sort(([a], [b]) => a.localeCompare(b))) {
            const e: ScriptEntry = {};
            if (entry.group) {
                e.group = entry.group;
            }
            if (entry.comment) {
                e.comment = entry.comment;
            }
            if (e.group || e.comment) {
                clean.scripts[key] = e;
            }
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(clean, null, 2) + '\n', 'utf8'));
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
    const excludes = vscode.workspace.getConfiguration('scriptRunner').get<string[]>('exclude', ['**/node_modules/**']);
    const files = await vscode.workspace.findFiles('**/package.json', `{${excludes.join(',')}}`);
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
            pkg = JSON.parse(Buffer.from(raw).toString('utf8'));
        } catch {
            continue;
        }
        if (!pkg.scripts) {
            continue;
        }
        const pkgDir = path.dirname(file.fsPath);
        const pkgRelDir = path.relative(folder.uri.fsPath, pkgDir).split(path.sep).join('/');
        for (const [name, command] of Object.entries(pkg.scripts)) {
            if (typeof command !== 'string') {
                continue;
            }
            const id = `${pkgRelDir}#${name}`;
            const entry = config.scripts[id];
            scripts.push({
                id,
                name,
                command,
                pkgRelDir,
                pkgDir,
                packageName: pkg.name ?? (pkgRelDir || path.basename(folder.uri.fsPath)),
                workspaceFolder: folder,
                group: entry?.group,
                comment: entry?.comment,
            });
        }
    }

    scripts.sort((a, b) => a.pkgRelDir.localeCompare(b.pkgRelDir) || a.name.localeCompare(b.name));
    return scripts;
}
