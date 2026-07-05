import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo, scanScripts } from './model';

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

interface DirNode {
    dirs: Map<string, DirNode>;
    scripts: ScriptInfo[];
}

function buildFolderItems(scripts: ScriptInfo[]): Array<FolderItem | ScriptItem> {
    const root: DirNode = { dirs: new Map(), scripts: [] };
    for (const script of scripts) {
        let node = root;
        if (script.pkgRelDir) {
            for (const segment of script.pkgRelDir.split('/')) {
                let child = node.dirs.get(segment);
                if (!child) {
                    child = { dirs: new Map(), scripts: [] };
                    node.dirs.set(segment, child);
                }
                node = child;
            }
        }
        node.scripts.push(script);
    }

    const countScripts = (node: DirNode): number =>
        node.scripts.length + [...node.dirs.values()].reduce((sum, d) => sum + countScripts(d), 0);

    const toItems = (node: DirNode, isRoot = false): Array<FolderItem | ScriptItem> => {
        const folders = [...node.dirs.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, child]) => {
                // Compact single-child chains with no scripts of their own: a/b/c
                let label = name;
                while (child.scripts.length === 0 && child.dirs.size === 1) {
                    const [nextName, nextChild] = child.dirs.entries().next().value as [string, DirNode];
                    label += `/${nextName}`;
                    child = nextChild;
                }
                return new FolderItem(label, countScripts(child), toItems(child));
            });
        const leaves = node.scripts.map((s) => new ScriptItem(s, false));
        // Root-level scripts (workspace root package.json) sort before folders.
        return isRoot ? [...leaves, ...folders] : [...folders, ...leaves];
    };

    return toItems(root, true);
}

const SCRIPT_MIME = 'application/vnd.code.tree.scriptrunner.scripts';

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

            return [...groupItems, ...buildFolderItems(ungrouped)];
        }
        if (element instanceof GroupItem) {
            return this.scripts
                .filter((s) => s.group === element.groupName)
                .map((s) => new ScriptItem(s, true));
        }
        if (element instanceof FolderItem) {
            return element.children;
        }
        return [];
    }

    handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
        const ids = source.filter((n): n is ScriptItem => n instanceof ScriptItem).map((n) => n.script.id);
        if (ids.length) {
            dataTransfer.set(SCRIPT_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
        }
    }

    async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const item = dataTransfer.get(SCRIPT_MIME);
        if (!item) {
            return;
        }
        let ids: string[];
        try {
            ids = JSON.parse(await item.asString());
        } catch {
            return;
        }
        if (!Array.isArray(ids) || !ids.length) {
            return;
        }
        // Dropping on a group assigns to it; on a script, to that script's group;
        // on a folder or empty space, removes the custom group (back to folder tree).
        let group: string | undefined;
        if (target instanceof GroupItem) {
            group = target.groupName;
        } else if (target instanceof ScriptItem) {
            group = target.script.group;
        }

        const config = await this.store.load();
        const byId = new Map(this.scripts.map((s) => [s.id, s]));
        for (const id of ids) {
            const script = byId.get(id);
            if (!script || script.group === group) {
                continue;
            }
            config.scripts[id] = { ...config.scripts[id], group };
        }
        await this.store.save(config);
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
