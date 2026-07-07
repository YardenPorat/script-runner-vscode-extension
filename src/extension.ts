import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo } from './model';
import { ScriptTreeProvider, ScriptItem, GroupItem } from './tree';
import { runScript, disposeTerminals, onTerminalClosed } from './runner';
import { ScriptPanel } from './panel';

async function pickScript(provider: ScriptTreeProvider, placeHolder: string): Promise<ScriptInfo | undefined> {
    const scripts = await provider.ensureScripts();
    if (!scripts.length) {
        void vscode.window.showInformationMessage('Script Runner: no scripts found.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        scripts.map((s) => ({
            // Path in the label so a combined query like "apps/web build" matches path+name together.
            label: `$(terminal) ${s.pkgRelDir ? `${s.pkgRelDir}/` : ''}${s.name}`,
            description: s.group,
            detail: [s.comment, s.command].filter(Boolean).join(' — '),
            script: s,
        })),
        { placeHolder, matchOnDescription: true, matchOnDetail: true },
    );
    return picked?.script;
}

async function resolveScript(provider: ScriptTreeProvider, item: unknown, placeHolder: string): Promise<ScriptInfo | undefined> {
    if (item instanceof ScriptItem) {
        return item.script;
    }
    // Webview context menus pass the element's data-vscode-context object.
    if (item && typeof item === 'object' && typeof (item as { scriptId?: unknown }).scriptId === 'string') {
        const id = (item as { scriptId: string }).scriptId;
        const found = (await provider.ensureScripts()).find((s) => s.id === id);
        if (found) {
            return found;
        }
    }
    return pickScript(provider, placeHolder);
}

// Context-menu commands are called with (clickedItem, allSelectedItems) when
// canSelectMany is on. Prefer the full selection; fall back to the single item.
async function resolveScripts(
    provider: ScriptTreeProvider,
    item: unknown,
    items: unknown,
    placeHolder: string,
): Promise<ScriptInfo[]> {
    if (Array.isArray(items)) {
        const scripts = items.filter((i): i is ScriptItem => i instanceof ScriptItem).map((i) => i.script);
        if (scripts.length > 1) {
            return scripts;
        }
    }
    const single = await resolveScript(provider, item, placeHolder);
    return single ? [single] : [];
}

async function assignGroupTo(store: ConfigStore, provider: ScriptTreeProvider, scripts: ScriptInfo[]): Promise<void> {
    if (!scripts.length) {
        return;
    }
    const existing = provider.getGroups();
    const NEW_GROUP = '$(add) New group…';
    const NO_GROUP = '$(close) Remove from group';
    const label = scripts.length === 1 ? `"${scripts[0].name}"` : `${scripts.length} scripts`;
    const picked = await vscode.window.showQuickPick([NEW_GROUP, NO_GROUP, ...existing], {
        placeHolder: `Group for ${label}`,
    });
    if (picked === undefined) {
        return;
    }
    let group: string | undefined;
    if (picked === NEW_GROUP) {
        group = await vscode.window.showInputBox({
            prompt: 'New group name',
            validateInput: (v) => (v.trim() ? undefined : 'Group name cannot be empty'),
        });
        if (group === undefined) {
            return;
        }
        group = group.trim();
    } else if (picked === NO_GROUP) {
        group = undefined;
    } else {
        group = picked;
    }
    const config = await store.load();
    for (const script of scripts) {
        config.scripts[script.id] = { ...config.scripts[script.id], group };
    }
    await store.save(config);
    provider.refresh();
}

async function editCommentFor(store: ConfigStore, provider: ScriptTreeProvider, script: ScriptInfo): Promise<void> {
    const comment = await vscode.window.showInputBox({
        prompt: `Comment for "${script.name}" (empty to clear)`,
        value: script.comment ?? '',
    });
    if (comment === undefined) {
        return;
    }
    await store.update(script.id, { group: script.group, comment: comment.trim() || undefined });
    provider.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
    const store = new ConfigStore();
    const provider = new ScriptTreeProvider(store);

    context.subscriptions.push(
        vscode.window.createTreeView('scriptRunner.scripts', {
            treeDataProvider: provider,
            dragAndDropController: provider,
            canSelectMany: true,
            showCollapseAll: true,
        }),

        vscode.commands.registerCommand('scriptRunner.refresh', () => provider.refresh()),

        vscode.commands.registerCommand('scriptRunner.openInEditor', () => {
            ScriptPanel.createOrShow(context, provider, store, {
                assignGroup: (scripts) => assignGroupTo(store, provider, scripts),
                editComment: (script) => editCommentFor(store, provider, script),
            });
        }),

        vscode.commands.registerCommand('scriptRunner.search', async () => {
            const script = await pickScript(provider, 'Search scripts by name, path, group, comment or command');
            if (script) {
                runScript(script);
            }
        }),

        vscode.commands.registerCommand('scriptRunner.run', async (item?: unknown) => {
            const script = await resolveScript(provider, item, 'Select a script to run');
            if (script) {
                runScript(script);
            }
        }),

        vscode.commands.registerCommand('scriptRunner.assignGroup', async (item?: unknown, items?: unknown) => {
            const scripts = await resolveScripts(provider, item, items, 'Select a script to group');
            await assignGroupTo(store, provider, scripts);
        }),

        vscode.commands.registerCommand('scriptRunner.editComment', async (item?: unknown) => {
            const script = await resolveScript(provider, item, 'Select a script to annotate');
            if (script) {
                await editCommentFor(store, provider, script);
            }
        }),

        vscode.commands.registerCommand('scriptRunner.removeFromGroup', async (item?: unknown, items?: unknown) => {
            const scripts = await resolveScripts(provider, item, items, 'Select a script to ungroup');
            if (!scripts.length) {
                return;
            }
            const config = await store.load();
            for (const script of scripts) {
                config.scripts[script.id] = { ...config.scripts[script.id], group: undefined };
            }
            await store.save(config);
            provider.refresh();
        }),

        vscode.commands.registerCommand('scriptRunner.copyCommand', async (item?: unknown) => {
            const script = await resolveScript(provider, item, 'Select a script to copy its command');
            if (script) {
                await vscode.env.clipboard.writeText(script.command);
                vscode.window.setStatusBarMessage(`Copied command: ${script.command}`, 2000);
            }
        }),

        vscode.commands.registerCommand('scriptRunner.copyCommandName', async (item?: unknown) => {
            const script = await resolveScript(provider, item, 'Select a script to copy its name');
            if (script) {
                await vscode.env.clipboard.writeText(script.name);
                vscode.window.setStatusBarMessage(`Copied name: ${script.name}`, 2000);
            }
        }),

        vscode.commands.registerCommand('scriptRunner.openTerminalHere', async (item?: unknown) => {
            const script = await resolveScript(provider, item, 'Select a script to open a terminal in its dir');
            if (script) {
                const terminal = vscode.window.createTerminal({
                    name: `${script.packageName}: ${script.pkgRelDir || 'root'}`,
                    cwd: script.pkgDir,
                });
                terminal.show();
            }
        }),

        vscode.commands.registerCommand('scriptRunner.renameGroup', async (item?: unknown) => {
            if (!(item instanceof GroupItem)) {
                return;
            }
            const name = await vscode.window.showInputBox({
                prompt: `Rename group "${item.groupName}"`,
                value: item.groupName,
                validateInput: (v) => (v.trim() ? undefined : 'Group name cannot be empty'),
            });
            if (name === undefined || name.trim() === item.groupName) {
                return;
            }
            const config = await store.load();
            for (const entry of Object.values(config.scripts)) {
                if (entry.group === item.groupName) {
                    entry.group = name.trim();
                }
            }
            if (config.groups) {
                config.groups = config.groups.map((g) => (g === item.groupName ? name.trim() : g));
            }
            await store.save(config);
            provider.refresh();
        }),

        vscode.commands.registerCommand('scriptRunner.openConfig', async () => {
            const uri = store.getUri();
            if (!uri) {
                return;
            }
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                await store.save({ scripts: {} });
            }
            await vscode.window.showTextDocument(uri);
        }),

        vscode.window.onDidCloseTerminal(onTerminalClosed),
    );

    // Refresh on package.json or config changes.
    const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,*.config.json}');
    let timer: NodeJS.Timeout | undefined;
    const debouncedRefresh = (uri: vscode.Uri) => {
        if (uri.fsPath.includes('node_modules')) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => provider.refresh(), 500);
    };
    watcher.onDidChange(debouncedRefresh);
    watcher.onDidCreate(debouncedRefresh);
    watcher.onDidDelete(debouncedRefresh);
    context.subscriptions.push(watcher);
}

export function deactivate(): void {
    disposeTerminals();
}
