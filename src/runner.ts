import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ScriptInfo } from './model';

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCKFILES: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
];

function detectPackageManager(script: ScriptInfo): PackageManager {
    const configured = vscode.workspace.getConfiguration('scriptRunner').get<string>('packageManager', 'auto');
    if (configured !== 'auto') {
        return configured as PackageManager;
    }
    // Walk up from the package dir to the workspace root looking for a lockfile.
    let dir = script.pkgDir;
    const root = script.workspaceFolder.uri.fsPath;
    for (;;) {
        for (const [lockfile, pm] of LOCKFILES) {
            if (fs.existsSync(path.join(dir, lockfile))) {
                return pm;
            }
        }
        if (dir === root) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return 'npm';
}

const terminals = new Map<string, vscode.Terminal>();

export function runScript(script: ScriptInfo): void {
    const pm = detectPackageManager(script);
    const title = `${script.packageName}: ${script.name}`;

    let terminal = terminals.get(script.id);
    if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({ name: title, cwd: script.pkgDir });
        terminals.set(script.id, terminal);
    }
    terminal.show();
    terminal.sendText(`${pm} run ${script.name}`);
}

export function disposeTerminals(): void {
    for (const terminal of terminals.values()) {
        terminal.dispose();
    }
    terminals.clear();
}

export function onTerminalClosed(closed: vscode.Terminal): void {
    for (const [id, terminal] of terminals) {
        if (terminal === closed) {
            terminals.delete(id);
        }
    }
}
