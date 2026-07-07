import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo, scanScripts } from './model';
import { buildFolderTree, dropFolders, dropScripts, OrderedFolder, sortScripts, ScriptDropTarget } from './order';

export class GroupItem extends vscode.TreeItem {
    constructor(public readonly groupName: string, count: number) {
        super(groupName, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'group';
        this.description = `${count}`;
        this.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.yellow'));
    }
}

export class FolderItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly path: string,
        count: number,
        public readonly children: Array<FolderItem | ScriptItem>,
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'folder';
        this.description = `${count}`;
        this.iconPath = vscode.ThemeIcon.Folder;
    }
}

export class ScriptItem extends vscode.TreeItem {
    constructor(public readonly script: ScriptInfo, showLocation: boolean) {
        super(script.name, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'script';
        this.iconPath = new vscode.ThemeIcon('terminal');
        const location = showLocation ? script.pkgRelDir || '(root)' : undefined;
        this.description = [location, script.comment].filter(Boolean).join(' — ');
        this.tooltip = new vscode.MarkdownString(
            [
                `**${script.packageName}** \`${script.name}\``,
                '',
                '```sh',
                script.command,
                '```',
                script.comment ? `\n> ${script.comment}` : '',
            ].join('\n'),
        );
        this.command = {
            command: 'scriptRunner.run',
            title: 'Run Script',
            arguments: [this],
        };
    }
}

type TreeNode = GroupItem | FolderItem | ScriptItem;

function toTreeItems(folder: OrderedFolder, isRoot = false): Array<FolderItem | ScriptItem> {
    const folders = folder.folders.map((f) => new FolderItem(f.label, f.path, f.count, toTreeItems(f)));
    const leaves = folder.scripts.map((s) => new ScriptItem(s, false));
    // Root-level scripts (workspace root package.json) sort before folders.
    return isRoot ? [...leaves, ...folders] : [...folders, ...leaves];
}

const SCRIPT_MIME = 'application/vnd.code.tree.scriptrunner.scripts';

interface DragPayload {
    scriptIds: string[];
    folderPaths: string[];
}

export class ScriptTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
    readonly dragMimeTypes = [SCRIPT_MIME];
    readonly dropMimeTypes = [SCRIPT_MIME];

    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    private scripts: ScriptInfo[] = [];
    private loaded = false;

    constructor(private readonly store: ConfigStore) {}

    refresh(): void {
        this.loaded = false;
        this.emitter.fire(undefined);
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            await this.ensureScripts();
            const config = await this.store.load();

            const grouped = new Map<string, ScriptInfo[]>();
            const ungrouped: ScriptInfo[] = [];
            for (const script of this.scripts) {
                if (script.group) {
                    const list = grouped.get(script.group) ?? [];
                    list.push(script);
                    grouped.set(script.group, list);
                } else {
                    ungrouped.push(script);
                }
            }

            const orderedGroups = [
                ...(config.groups ?? []).filter((g) => grouped.has(g)),
                ...[...grouped.keys()].filter((g) => !config.groups?.includes(g)).sort(),
            ];
            const groupItems = orderedGroups.map((g) => new GroupItem(g, grouped.get(g)?.length ?? 0));

            const tree = buildFolderTree(ungrouped, config.folders ?? {});
            return [...groupItems, ...toTreeItems(tree, true)];
        }
        if (element instanceof GroupItem) {
            const members = this.scripts.filter((s) => s.group === element.groupName);
            return sortScripts(members).map((s) => new ScriptItem(s, true));
        }
        if (element instanceof FolderItem) {
            return element.children;
        }
        return [];
    }

    handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
        const payload: DragPayload = {
            scriptIds: source.filter((n): n is ScriptItem => n instanceof ScriptItem).map((n) => n.script.id),
            folderPaths: source.filter((n): n is FolderItem => n instanceof FolderItem).map((n) => n.path),
        };
        if (payload.scriptIds.length || payload.folderPaths.length) {
            dataTransfer.set(SCRIPT_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
        }
    }

    async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const item = dataTransfer.get(SCRIPT_MIME);
        if (!item) {
            return;
        }
        let payload: DragPayload;
        try {
            payload = JSON.parse(await item.asString());
        } catch {
            return;
        }

        // Dragging folders only reorders them among their siblings (drop onto a sibling folder).
        if (payload.folderPaths?.length) {
            if (target instanceof FolderItem) {
                await dropFolders(this.store, this.scripts, payload.folderPaths, target.path);
                this.refresh();
            }
            return;
        }

        const ids = payload.scriptIds ?? [];
        if (!ids.length) {
            return;
        }

        // Group header → join group (append). Script → reorder before it within its container.
        // Folder / empty space → remove from group (back to the folder tree).
        let dropTarget: ScriptDropTarget;
        if (target instanceof GroupItem) {
            dropTarget = { kind: 'group', name: target.groupName };
        } else if (target instanceof ScriptItem) {
            dropTarget = target.script.group
                ? { kind: 'group', name: target.script.group, beforeId: target.script.id }
                : { kind: 'dir', dir: target.script.pkgRelDir, beforeId: target.script.id };
        } else {
            dropTarget = { kind: 'ungroup' };
        }

        await dropScripts(this.store, this.scripts, ids, dropTarget);
        this.refresh();
    }

    getScripts(): ScriptInfo[] {
        return this.scripts;
    }

    async ensureScripts(): Promise<ScriptInfo[]> {
        if (!this.loaded) {
            this.scripts = await scanScripts(this.store);
            this.loaded = true;
        }
        return this.scripts;
    }

    getGroups(): string[] {
        const groups = new Set<string>();
        for (const script of this.scripts) {
            if (script.group) {
                groups.add(script.group);
            }
        }
        return [...groups].sort();
    }
}
