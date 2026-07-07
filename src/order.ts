import { ConfigStore, ScriptInfo } from './model';

const LAST = Number.MAX_SAFE_INTEGER;
const scriptIdx = (s: ScriptInfo): number => (typeof s.order === 'number' ? s.order : LAST);

/** Sort scripts by their persisted order, then path/name as a stable fallback. */
export function sortScripts(scripts: ScriptInfo[]): ScriptInfo[] {
    return [...scripts].sort(
        (a, b) => scriptIdx(a) - scriptIdx(b) || a.pkgRelDir.localeCompare(b.pkgRelDir) || a.name.localeCompare(b.name),
    );
}

export interface OrderedFolder {
    /** Display label (may be a compacted chain like `a/b/c`) */
    label: string;
    /** Workspace-relative path of this (compacted) folder node; '' for the root */
    path: string;
    count: number;
    folders: OrderedFolder[];
    scripts: ScriptInfo[];
}

interface DirNode {
    dirs: Map<string, DirNode>;
    scripts: ScriptInfo[];
}

/** Build the folder tree for ungrouped scripts, applying persisted folder + script order. */
export function buildFolderTree(scripts: ScriptInfo[], folderOrder: Record<string, number> = {}): OrderedFolder {
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
    const folderIdx = (p: string): number => (typeof folderOrder[p] === 'number' ? folderOrder[p] : LAST);

    const toFolder = (label: string, path: string, node: DirNode): OrderedFolder => {
        const folders = [...node.dirs.entries()]
            .map(([name, child]) => {
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
            })
            .sort((a, b) => folderIdx(a.path) - folderIdx(b.path) || a.label.localeCompare(b.label));
        return { label, path, count: countScripts(node), folders, scripts: sortScripts(node.scripts) };
    };

    return toFolder('', '', root);
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

const containerKey = (s: ScriptInfo): string => (s.group ? `g:${s.group}` : `d:${s.pkgRelDir}`);

function containerScripts(all: ScriptInfo[], key: string): ScriptInfo[] {
    return sortScripts(all.filter((s) => containerKey(s) === key));
}

export type ScriptDropTarget =
    | { kind: 'group'; name: string; beforeId?: string }
    | { kind: 'dir'; dir: string; beforeId?: string }
    | { kind: 'ungroup' };

/** Move scripts into a group / folder and/or reorder them, persisting the result. */
export async function dropScripts(store: ConfigStore, all: ScriptInfo[], ids: string[], target: ScriptDropTarget): Promise<void> {
    const byId = new Map(all.map((s) => [s.id, s]));
    let moving = ids.filter((id) => byId.has(id));
    // A folder's contents are filesystem-derived, so only same-dir scripts can land there.
    if (target.kind === 'dir') {
        moving = moving.filter((id) => byId.get(id)!.pkgRelDir === target.dir);
    }
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

    const key = target.kind === 'group' ? `g:${target.name}` : `d:${target.dir}`;
    const current = containerScripts(all, key).map((s) => s.id);
    const ordered = reorderKeys(current, moving, target.beforeId);
    const group = target.kind === 'group' ? target.name : undefined;
    for (const id of moving) {
        config.scripts[id] = { ...config.scripts[id], group };
    }
    ordered.forEach((id, i) => {
        config.scripts[id] = { ...config.scripts[id], order: i };
    });
    await store.save(config);
}

function findSiblings(parent: OrderedFolder, path: string): OrderedFolder[] | null {
    if (parent.folders.some((f) => f.path === path)) {
        return parent.folders;
    }
    for (const f of parent.folders) {
        const found = findSiblings(f, path);
        if (found) {
            return found;
        }
    }
    return null;
}

/** Reorder folders within their shared parent, persisting the new indices. */
export async function dropFolders(store: ConfigStore, all: ScriptInfo[], movingPaths: string[], beforePath?: string): Promise<void> {
    if (!movingPaths.length) {
        return;
    }
    const config = await store.load();
    const ungrouped = all.filter((s) => !s.group);
    const tree = buildFolderTree(ungrouped, config.folders ?? {});
    const siblings = findSiblings(tree, movingPaths[0]);
    if (!siblings) {
        return;
    }
    const siblingPaths = siblings.map((f) => f.path);
    const moving = movingPaths.filter((p) => siblingPaths.includes(p));
    if (!moving.length) {
        return;
    }
    const before = beforePath && siblingPaths.includes(beforePath) ? beforePath : undefined;
    const ordered = reorderKeys(siblingPaths, moving, before);
    const folders = { ...(config.folders ?? {}) };
    ordered.forEach((p, i) => {
        folders[p] = i;
    });
    config.folders = folders;
    await store.save(config);
}
