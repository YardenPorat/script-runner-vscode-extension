import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo, scanScripts } from './model';
import { buildRoot, dropFolders, dropScripts, dropTreeNodes, OrderedFolder, sortScripts, treeDir } from './order';

const collapseState = (collapsed: boolean): vscode.TreeItemCollapsibleState =>
    collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;

export class GroupItem extends vscode.TreeItem {
    constructor(public readonly groupName: string, count: number, collapsed = false) {
        super(groupName, collapseState(collapsed));
        this.id = `group:${groupName}`;
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
        collapsed = false,
    ) {
        super(label, collapseState(collapsed));
        this.id = `folder:${path}`;
        this.contextValue = 'folder';
        this.description = `${count}`;
        this.iconPath = vscode.ThemeIcon.Folder;
    }
}

export class ScriptItem extends vscode.TreeItem {
    constructor(public readonly script: ScriptInfo, showLocation: boolean) {
        super(script.displayName || script.name, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'script';
        this.iconPath = new vscode.ThemeIcon('terminal');
        const location = showLocation ? script.pkgRelDir || '(root)' : undefined;
        // When renamed, surface the real script name so the mapping stays visible.
        const renamed = script.displayName ? script.name : undefined;
        this.description = [location, renamed, script.comment].filter(Boolean).join(' — ');
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
        // No run-on-click: run via the inline play action that appears on hover.
    }
}

type TreeNode = GroupItem | FolderItem | ScriptItem;

function toTreeItems(folder: OrderedFolder, collapsedFolders: Set<string>): Array<FolderItem | ScriptItem> {
    // Children arrive interleaved in display order (folders and scripts share one index space).
    return folder.children.map((c) =>
        c.kind === 'folder'
            ? new FolderItem(c.folder.label, c.folder.path, c.folder.count, toTreeItems(c.folder, collapsedFolders), collapsedFolders.has(c.folder.path))
            : new ScriptItem(c.script, false),
    );
}

const SCRIPT_MIME = 'application/vnd.code.tree.scriptrunner.scripts';
const COLLAPSED_KEY = 'scriptRunner.collapsed';

interface DragPayload {
    scriptIds: string[];
    folderPaths: string[];
    groupNames: string[];
}

export class ScriptTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
    readonly dragMimeTypes = [SCRIPT_MIME];
    readonly dropMimeTypes = [SCRIPT_MIME];

    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    private scripts: ScriptInfo[] = [];
    private loaded = false;

    constructor(
        private readonly store: ConfigStore,
        private readonly memento: vscode.Memento,
    ) {}

    private collapsed(): { folders: string[]; groups: string[] } {
        return this.memento.get(COLLAPSED_KEY, { folders: [], groups: [] });
    }

    getCollapsedState(): { folders: Set<string>; groups: Set<string> } {
        const state = this.collapsed();
        return { folders: new Set(state.folders), groups: new Set(state.groups) };
    }

    /** Persist a folder/group collapse toggle to workspace state (machine-local, never committed). */
    setCollapsed(kind: 'folder' | 'group', key: string, collapsed: boolean): void {
        const state = this.collapsed();
        const set = new Set(kind === 'folder' ? state.folders : state.groups);
        if (collapsed) {
            set.add(key);
        } else {
            set.delete(key);
        }
        const next = kind === 'folder' ? { ...state, folders: [...set] } : { ...state, groups: [...set] };
        void this.memento.update(COLLAPSED_KEY, next);
    }

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
            const collapsed = this.collapsed();
            const collapsedGroups = new Set(collapsed.groups);
            const collapsedFolders = new Set(collapsed.folders);
            // Groups, folders and scripts interleaved in one persisted root order.
            return buildRoot(this.scripts, config).map((c) => {
                if (c.kind === 'group') {
                    return new GroupItem(c.name, c.scripts.length, collapsedGroups.has(c.name));
                }
                if (c.kind === 'folder') {
                    return new FolderItem(
                        c.folder.label,
                        c.folder.path,
                        c.folder.count,
                        toTreeItems(c.folder, collapsedFolders),
                        collapsedFolders.has(c.folder.path),
                    );
                }
                // Root-pinned scripts show their real location so the origin stays visible.
                return new ScriptItem(c.script, !!c.script.root);
            });
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
            groupNames: source.filter((n): n is GroupItem => n instanceof GroupItem).map((n) => n.groupName),
        };
        if (payload.scriptIds.length || payload.folderPaths.length || payload.groupNames.length) {
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

        // Dragging groups reorders them at the root (drop onto any root sibling —
        // group, folder or script — to slot in before it; empty space appends).
        if (payload.groupNames?.length) {
            let before: string | undefined;
            if (target instanceof GroupItem) {
                before = `g:${target.groupName}`;
            } else if (target instanceof FolderItem) {
                before = `f:${target.path}`;
            } else if (target instanceof ScriptItem && !target.script.group) {
                before = `s:${target.script.id}`;
            }
            await dropTreeNodes(
                this.store,
                this.scripts,
                payload.groupNames.map((g) => `g:${g}`),
                '',
                before,
            );
            this.refresh();
            return;
        }

        // Dragging folders reorders them among their siblings (drop onto a sibling
        // folder, onto a group header to slot in before it at the root, or onto a
        // script row in the same parent to slot in before it).
        if (payload.folderPaths?.length) {
            if (target instanceof GroupItem) {
                await dropTreeNodes(
                    this.store,
                    this.scripts,
                    payload.folderPaths.map((p) => `f:${p}`),
                    '',
                    `g:${target.groupName}`,
                );
                this.refresh();
            } else if (target instanceof FolderItem) {
                await dropFolders(this.store, this.scripts, payload.folderPaths, target.path);
                this.refresh();
            } else if (target instanceof ScriptItem && !target.script.group) {
                await dropTreeNodes(
                    this.store,
                    this.scripts,
                    payload.folderPaths.map((p) => `f:${p}`),
                    treeDir(target.script),
                    `s:${target.script.id}`,
                );
                this.refresh();
            }
            return;
        }

        const ids = payload.scriptIds ?? [];
        if (!ids.length) {
            return;
        }

        // Group header → join group (append). Grouped script → reorder within its group.
        // Ungrouped script → reorder in that script's container (root pins, own dir unpins).
        // Own folder → move back into it. Other folder → remove from group.
        // Empty space → pin to the root, outside any folder or group.
        if (target instanceof GroupItem) {
            await dropScripts(this.store, this.scripts, ids, { kind: 'group', name: target.groupName });
        } else if (target instanceof ScriptItem && target.script.group) {
            await dropScripts(this.store, this.scripts, ids, {
                kind: 'group',
                name: target.script.group,
                beforeId: target.script.id,
            });
        } else if (target instanceof ScriptItem) {
            await dropTreeNodes(
                this.store,
                this.scripts,
                ids.map((id) => `s:${id}`),
                treeDir(target.script),
                `s:${target.script.id}`,
            );
        } else if (target instanceof FolderItem) {
            const byId = new Map(this.scripts.map((s) => [s.id, s]));
            const homeIds = ids.filter((id) => byId.get(id)?.pkgRelDir === target.path);
            const otherIds = ids.filter((id) => byId.get(id)?.pkgRelDir !== target.path);
            if (homeIds.length) {
                await dropTreeNodes(this.store, this.scripts, homeIds.map((id) => `s:${id}`), target.path);
            }
            if (otherIds.length) {
                await dropScripts(this.store, this.scripts, otherIds, { kind: 'ungroup' });
            }
        } else {
            await dropTreeNodes(this.store, this.scripts, ids.map((id) => `s:${id}`), '');
        }
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
