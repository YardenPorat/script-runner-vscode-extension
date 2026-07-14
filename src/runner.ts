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

interface TrackedTerminal {
    scriptId: string;
    terminal: vscode.Terminal;
    /** True while a command is executing in this terminal (per shell integration). */
    busy: boolean;
}

const tracked: TrackedTerminal[] = [];

function find(terminal: vscode.Terminal): TrackedTerminal | undefined {
    return tracked.find((t) => t.terminal === terminal);
}

export function runScript(script: ScriptInfo): void {
    const pm = detectPackageManager(script);
    const title = `${script.packageName}: ${script.name}`;

    // Reuse an idle terminal for this script (previous run finished); otherwise
    // spin up a new one so a still-running task (watch/dev server) is left alone.
    let entry = tracked.find(
        (t) => t.scriptId === script.id && !t.busy && t.terminal.exitStatus === undefined
    );
    if (!entry) {
        entry = { scriptId: script.id, terminal: vscode.window.createTerminal({ name: title, cwd: script.pkgDir }), busy: false };
        tracked.push(entry);
    }

    // Optimistically mark busy: the shell-execution-end event flips it back when done.
    entry.busy = true;
    entry.terminal.show();
    entry.terminal.sendText(`${pm} run ${script.name}`);
}

/** Wire shell-integration events so we know when a terminal's command finishes. */
export function registerTerminalTracking(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [
        vscode.window.onDidStartTerminalShellExecution((e) => {
            const t = find(e.terminal);
            if (t) {
                t.busy = true;
            }
        }),
        vscode.window.onDidEndTerminalShellExecution((e) => {
            const t = find(e.terminal);
            if (t) {
                t.busy = false;
            }
        }),
    ];
    return vscode.Disposable.from(...disposables);
}

export function disposeTerminals(): void {
    for (const { terminal } of tracked) {
        terminal.dispose();
    }
    tracked.length = 0;
}

export function onTerminalClosed(closed: vscode.Terminal): void {
    const i = tracked.findIndex((t) => t.terminal === closed);
    if (i !== -1) {
        tracked.splice(i, 1);
    }
}
