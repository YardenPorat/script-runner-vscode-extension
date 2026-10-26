import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ScriptInfo } from './model';

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const TASK_TYPE = 'scriptRunner';

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

interface ScriptTaskDefinition extends vscode.TaskDefinition {
    type: typeof TASK_TYPE;
    scriptId: string;
}

export function runScript(script: ScriptInfo): void {
    const pm = detectPackageManager(script);
    const title = `${script.packageName}: ${script.name}`;

    const definition: ScriptTaskDefinition = { type: TASK_TYPE, scriptId: script.id };
    const task = new vscode.Task(
        definition,
        script.workspaceFolder,
        title,
        TASK_TYPE,
        // Run through waitKey.js using VS Code's bundled Node, so the task itself
        // waits for a key after the script ends and the terminal then closes.
        new vscode.ProcessExecution(
            process.execPath,
            [path.join(__dirname, 'waitKey.js'), `${pm} run ${script.name}`],
            { cwd: script.pkgDir, env: { ELECTRON_RUN_AS_NODE: '1' } }
        )
    );
    // Dedicated panel: each script gets its own terminal; it closes on the key
    // press after the script finishes.
    task.presentationOptions = {
        panel: vscode.TaskPanelKind.Dedicated,
        reveal: vscode.TaskRevealKind.Always,
        focus: false,
        clear: true,
        close: true,
    };

    void vscode.tasks.executeTask(task);
}

/** Terminal lifecycle is owned by the Tasks API now; nothing to wire up. */
export function registerTerminalTracking(): vscode.Disposable {
    return new vscode.Disposable(() => {});
}

export function disposeTerminals(): void {
    for (const execution of vscode.tasks.taskExecutions) {
        if (execution.task.definition.type === TASK_TYPE) {
            execution.terminate();
        }
    }
}

export function onTerminalClosed(_closed: vscode.Terminal): void {
    // No-op: task terminals are managed by VS Code.
}
