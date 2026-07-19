import { ConfigStore, RunnerConfig, ScriptInfo } from './model';

const LAST = Number.MAX_SAFE_INTEGER;
const scriptIdx = (s: ScriptInfo): number => (typeof s.order === 'number' ? s.order : LAST);

/** Sort scripts by their persisted order, then path/name as a stable fallback. */
export function sortScripts(scripts: ScriptInfo[]): ScriptInfo[] {
    return [...scripts].sort(
        (a, b) => scriptIdx(a) - scriptIdx(b) || a.pkgRelDir.localeCompare(b.pkgRelDir) || a.name.localeCompare(b.name),
    );
}

/** Effective directory of a script in the tree: root-pinned scripts live at '' regardless of their package dir. */
export const treeDir = (s: ScriptInfo): string => (s.root ? '' : s.pkgRelDir);

export type DirChild = { kind: 'folder'; folder: OrderedFolder } | { kind: 'script'; script: ScriptInfo };

export interface OrderedFolder {
    /** Display label (may be a compacted chain like `a/b/c`) */
    label: string;
    /** Workspace-relative path of this (compacted) folder node; '' for the root */
    path: string;
    count: number;
    /** Subfolders and scripts interleaved in display order (shared index space). */
    children: DirChild[];
}

/** Stable sibling key: folders by path, scripts by id. */
export const childKey = (c: DirChild): string => (c.kind === 'folder' ? `f:${c.folder.path}` : `s:${c.script.id}`);

interface DirNode {
    dirs: Map<string, DirNode>;
    scripts: ScriptInfo[];
}

/** Build the folder tree for ungrouped scripts, applying persisted folder + script order. */
export function buildFolderTree(scripts: ScriptInfo[], folderOrder: Record<string, number> = {}): OrderedFolder {
    const root: DirNode = { dirs: new Map(), scripts: [] };
    for (const script of scripts) {
        let node = root;
        const dir = treeDir(script);
        if (dir) {
            for (const segment of dir.split('/')) {
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
    const folderIdx = (p: string): number => (typeof folderOrder[p] === 'number' ? folderOrder[p] : LAST);

    const toFolder = (label: string, path: string, node: DirNode): OrderedFolder => {
        const folders = [...node.dirs.entries()].map(([name, child]) => {
            // Compact single-child chains with no scripts of their own: a/b/c
            let lbl = name;
            let p = path ? `${path}/${name}` : name;
            let c = child;
            while (c.scripts.length === 0 && c.dirs.size === 1) {
                const [nextName, nextChild] = c.dirs.entries().next().value as [string, DirNode];
                lbl += `/${nextName}`;
                p += `/${nextName}`;
                c = nextChild;
            }
            return toFolder(lbl, p, c);
        });

        // Folders and scripts share one index space so they can interleave freely.
        // Unordered fallback keeps the old defaults: root scripts before folders,
        // folders before scripts inside a folder; then alphabetical.
        const isRoot = path === '';
        const idx = (c: DirChild): number => (c.kind === 'folder' ? folderIdx(c.folder.path) : scriptIdx(c.script));
        const rank = (c: DirChild): number => ((c.kind === 'script') === isRoot ? 0 : 1);
        const name = (c: DirChild): string => (c.kind === 'folder' ? c.folder.label : c.script.name);
        const children: DirChild[] = [
            ...folders.map((f) => ({ kind: 'folder' as const, folder: f })),
            ...sortScripts(node.scripts).map((s) => ({ kind: 'script' as const, script: s })),
        ].sort((a, b) => idx(a) - idx(b) || rank(a) - rank(b) || name(a).localeCompare(name(b)));

        return { label, path, count: countScripts(node), children };
    };

    return toFolder('', '', root);
}

export type RootChild = { kind: 'group'; name: string; scripts: ScriptInfo[] } | DirChild;

/** Stable root key: groups by name, folders by path, scripts by id. */
export const rootKey = (c: RootChild): string => (c.kind === 'group' ? `g:${c.name}` : childKey(c));

/**
 * Build the root-level children: groups, folders and scripts interleaved in one
 * shared index space (groups from `config.groups`, folders/scripts as in the tree).
 * Unordered fallback keeps the old defaults: groups, then root scripts, then folders.
 */
export function buildRoot(all: ScriptInfo[], config: RunnerConfig): RootChild[] {
    const grouped = new Map<string, ScriptInfo[]>();
    const ungrouped: ScriptInfo[] = [];
    for (const s of all) {
        if (s.group) {
            const list = grouped.get(s.group) ?? [];
            list.push(s);
            grouped.set(s.group, list);
        } else {
            ungrouped.push(s);
        }
    }
    const folders = config.folders ?? {};
    const groupOrder = config.groups ?? {};
    const tree = buildFolderTree(ungrouped, folders);
    const children: RootChild[] = [
        ...[...grouped.entries()].map(([name, scripts]) => ({
            kind: 'group' as const,
            name,
            scripts: sortScripts(scripts),
        })),
        ...tree.children,
    ];
    const idx = (c: RootChild): number => {
        if (c.kind === 'group') {
            return typeof groupOrder[c.name] === 'number' ? groupOrder[c.name] : LAST;
        }
        if (c.kind === 'folder') {
            return typeof folders[c.folder.path] === 'number' ? folders[c.folder.path] : LAST;
        }
        return scriptIdx(c.script);
    };
    const rank = (c: RootChild): number => (c.kind === 'group' ? 0 : c.kind === 'script' ? 1 : 2);
    const name = (c: RootChild): string => (c.kind === 'group' ? c.name : c.kind === 'folder' ? c.folder.label : c.script.name);
    return children.sort((a, b) => idx(a) - idx(b) || rank(a) - rank(b) || name(a).localeCompare(name(b)));
}

/**
 * Return a new key ordering with `moving` keys extracted and re-inserted before `beforeKey`
 * (or appended when `beforeKey` is undefined / not present). `moving` order is preserved.
 */
export function reorderKeys(current: string[], moving: string[], beforeKey?: string): string[] {
    const set = new Set(moving);
    const rest = current.filter((k) => !set.has(k));
    let idx = rest.length;
    if (beforeKey && !set.has(beforeKey)) {
        const i = rest.indexOf(beforeKey);
        if (i >= 0) {
            idx = i;
        }
    }
    return [...rest.slice(0, idx), ...moving, ...rest.slice(idx)];
}

function findNode(root: OrderedFolder, path: string): OrderedFolder | null {
    if (root.path === path) {
        return root;
    }
    for (const c of root.children) {
        if (c.kind === 'folder') {
            const found = findNode(c.folder, path);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

function findParentPath(root: OrderedFolder, folderPath: string): string | null {
    for (const c of root.children) {
        if (c.kind === 'folder') {
            if (c.folder.path === folderPath) {
                return root.path;
            }
            const found = findParentPath(c.folder, folderPath);
            if (found !== null) {
                return found;
            }
        }
    }
    return null;
}

/**
 * Reorder mixed group/folder/script siblings inside the container `dir`.
 * Keys are `g:<name>` for groups (root only), `f:<path>` for folders and
 * `s:<id>` for scripts. Scripts can land at the root (pinned there, ungrouped)
 * or in their own filesystem dir (unpinned, ungrouped).
 * Keys that aren't siblings of `dir` are ignored; `beforeKey` undefined appends.
 */
export async function dropTreeNodes(
    store: ConfigStore,
    all: ScriptInfo[],
    movingKeys: string[],
    dir: string,
    beforeKey?: string,
): Promise<void> {
    if (!movingKeys.length) {
        return;
    }
    const config = await store.load();
    const byId = new Map(all.map((s) => [s.id, s]));
    // Moving scripts land in `dir` when it's the root (pin) or their own dir (unpin);
    // grouped ones leave their group. Others are filtered out by the sibling check.
    const landingIds = new Set(
        movingKeys
            .filter((k) => k.startsWith('s:'))
            .map((k) => k.slice(2))
            .filter((id) => byId.has(id) && (dir === '' || byId.get(id)?.pkgRelDir === dir)),
    );
    const landed = (s: ScriptInfo): ScriptInfo => ({
        ...s,
        group: undefined,
        root: dir === '' && s.pkgRelDir !== '' ? true : undefined,
    });
    const effective = all.map((s) => (landingIds.has(s.id) ? landed(s) : s));
    let siblings: string[];
    if (dir === '') {
        // Root: groups, folders and scripts share one index space.
        siblings = buildRoot(effective, config).map(rootKey);
    } else {
        const treeScripts = effective.filter((s) => !s.group);
        const tree = buildFolderTree(treeScripts, config.folders ?? {});
        const node = findNode(tree, dir);
        if (!node) {
            return;
        }
        siblings = node.children.map(childKey);
    }
    const siblingSet = new Set(siblings);
    const moving = movingKeys.filter((k) => siblingSet.has(k));
    if (!moving.length) {
        return;
    }
    const before = beforeKey && siblingSet.has(beforeKey) ? beforeKey : undefined;
    const ordered = reorderKeys(siblings, moving, before);
    const folders = { ...(config.folders ?? {}) };
    const groups = { ...(config.groups ?? {}) };
    ordered.forEach((k, i) => {
        if (k.startsWith('g:')) {
            groups[k.slice(2)] = i;
        } else if (k.startsWith('f:')) {
            folders[k.slice(2)] = i;
        } else {
            const id = k.slice(2);
            if (landingIds.has(id)) {
                const root = dir === '' && byId.get(id)?.pkgRelDir !== '' ? true : undefined;
                config.scripts[id] = { ...config.scripts[id], group: undefined, root, order: i };
            } else {
                config.scripts[id] = { ...config.scripts[id], order: i };
            }
        }
    });
    config.folders = folders;
    config.groups = groups;
    await store.save(config);
}

const containerKey = (s: ScriptInfo): string => (s.group ? `g:${s.group}` : `d:${s.pkgRelDir}`);

function containerScripts(all: ScriptInfo[], key: string): ScriptInfo[] {
    return sortScripts(all.filter((s) => containerKey(s) === key));
}

export type ScriptDropTarget = { kind: 'group'; name: string; beforeId?: string } | { kind: 'ungroup' };

/** Move scripts into a group (with optional position) or back out of any group. */
export async function dropScripts(store: ConfigStore, all: ScriptInfo[], ids: string[], target: ScriptDropTarget): Promise<void> {
    const byId = new Map(all.map((s) => [s.id, s]));
    const moving = ids.filter((id) => byId.has(id));
    if (!moving.length) {
        return;
    }

    const config = await store.load();

    if (target.kind === 'ungroup') {
        for (const id of moving) {
            config.scripts[id] = { ...config.scripts[id], group: undefined };
        }
        await store.save(config);
        return;
    }

    const current = containerScripts(all, `g:${target.name}`).map((s) => s.id);
    const ordered = reorderKeys(current, moving, target.beforeId);
    for (const id of moving) {
        config.scripts[id] = { ...config.scripts[id], group: target.name };
    }
    ordered.forEach((id, i) => {
        config.scripts[id] = { ...config.scripts[id], order: i };
    });
    await store.save(config);
}

/** Reorder folders within their shared parent (sidebar drag). `beforeKey` may be a folder path or `s:<id>`. */
export async function dropFolders(store: ConfigStore, all: ScriptInfo[], movingPaths: string[], beforePath?: string): Promise<void> {
    if (!movingPaths.length) {
        return;
    }
    const config = await store.load();
    const ungrouped = all.filter((s) => !s.group);
    const tree = buildFolderTree(ungrouped, config.folders ?? {});
    const parent = findParentPath(tree, movingPaths[0]);
    if (parent === null) {
        return;
    }
    await dropTreeNodes(
        store,
        all,
        movingPaths.map((p) => `f:${p}`),
        parent,
        beforePath ? `f:${beforePath}` : undefined,
    );
}
