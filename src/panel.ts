import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo } from './model';
import { ScriptTreeProvider } from './tree';
import { runScript } from './runner';
import { buildRoot, dropScripts, dropTreeNodes, OrderedFolder, ScriptDropTarget } from './order';

interface PanelScript {
    id: string;
    name: string;
    /** Rename override; label shows this, real name kept for running */
    displayName?: string;
    command: string;
    comment?: string;
    location?: string;
    /** Workspace-relative dir of the script's package ('' for root) */
    dir: string;
    /** Group this script belongs to, if any */
    group?: string;
}

type PanelChild =
    | { kind: 'group'; group: PanelGroup }
    | { kind: 'folder'; folder: PanelFolder }
    | { kind: 'script'; script: PanelScript };

interface PanelFolder {
    label: string;
    path: string;
    count: number;
    collapsed: boolean;
    /** Subfolders and scripts interleaved in display order (never groups) */
    children: PanelChild[];
}

interface PanelGroup {
    name: string;
    count: number;
    collapsed: boolean;
    scripts: PanelScript[];
}

interface PanelData {
    /** Groups, folders and scripts interleaved in root display order */
    root: PanelChild[];
}

function toPanelScript(s: ScriptInfo, showLocation: boolean): PanelScript {
    return {
        id: s.id,
        name: s.name,
        displayName: s.displayName,
        command: s.command,
        comment: s.comment,
        location: showLocation ? s.pkgRelDir || '(root)' : undefined,
        dir: s.pkgRelDir,
        group: s.group,
    };
}

function toPanelFolder(f: OrderedFolder, collapsedFolders: Set<string>): PanelFolder {
    return {
        label: f.label,
        path: f.path,
        count: f.count,
        collapsed: collapsedFolders.has(f.path),
        children: f.children.map((c) =>
            c.kind === 'folder'
                ? { kind: 'folder', folder: toPanelFolder(c.folder, collapsedFolders) }
                : { kind: 'script', script: toPanelScript(c.script, false) },
        ),
    };
}

async function buildData(provider: ScriptTreeProvider, store: ConfigStore): Promise<PanelData> {
    const scripts = await provider.ensureScripts();
    const config = await store.load();
    const collapsed = provider.getCollapsedState();
    const root: PanelChild[] = buildRoot(scripts, config).map((c) => {
        if (c.kind === 'group') {
            return {
                kind: 'group',
                group: {
                    name: c.name,
                    count: c.scripts.length,
                    collapsed: collapsed.groups.has(c.name),
                    scripts: c.scripts.map((s) => toPanelScript(s, true)),
                },
            };
        }
        if (c.kind === 'folder') {
            return { kind: 'folder', folder: toPanelFolder(c.folder, collapsed.folders) };
        }
        // Root-pinned scripts show their real location so the origin stays visible.
        return { kind: 'script', script: toPanelScript(c.script, !!c.script.root) };
    });
    return { root };
}

export interface PanelHandlers {
    assignGroup(scripts: ScriptInfo[]): Promise<void>;
    editComment(script: ScriptInfo): Promise<void>;
    renameScript(script: ScriptInfo): Promise<void>;
}

export class ScriptPanel {
    private static instance: ScriptPanel | undefined;

    static createOrShow(
        context: vscode.ExtensionContext,
        provider: ScriptTreeProvider,
        store: ConfigStore,
        handlers: PanelHandlers,
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ScriptPanel.instance) {
            ScriptPanel.instance.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'scriptRunner.panel',
            'Script Runner',
            column,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.iconPath = new vscode.ThemeIcon('run-all');
        ScriptPanel.instance = new ScriptPanel(panel, provider, store, handlers);
    }

    // Re-adopt a webview panel restored by VS Code after an extension restart/update.
    static revive(
        panel: vscode.WebviewPanel,
        provider: ScriptTreeProvider,
        store: ConfigStore,
        handlers: PanelHandlers,
    ): void {
        panel.iconPath = new vscode.ThemeIcon('run-all');
        ScriptPanel.instance = new ScriptPanel(panel, provider, store, handlers);
    }

    private readonly disposables: vscode.Disposable[] = [];
    private readonly wired: ScriptWebview;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        provider: ScriptTreeProvider,
        store: ConfigStore,
        handlers: PanelHandlers,
    ) {
        this.wired = new ScriptWebview(panel.webview, provider, store, handlers);
        panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    }

    private dispose(): void {
        ScriptPanel.instance = undefined;
        this.panel.dispose();
        this.wired.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

/** Sidebar variant: same webview UI, hosted in a WebviewView instead of an editor panel. */
export class ScriptSidebarProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly provider: ScriptTreeProvider,
        private readonly store: ConfigStore,
        private readonly handlers: PanelHandlers,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        const wired = new ScriptWebview(view.webview, this.provider, this.store, this.handlers);
        view.onDidDispose(() => wired.dispose());
    }
}

/** Wires a webview (editor panel or sidebar view) to script data and the message protocol. */
class ScriptWebview {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly webview: vscode.Webview,
        private readonly provider: ScriptTreeProvider,
        private readonly store: ConfigStore,
        private readonly handlers: PanelHandlers,
    ) {
        webview.onDidReceiveMessage(
            (msg: {
                type: string;
                id?: string;
                ids?: string[];
                target?: ScriptDropTarget;
                keys?: string[];
                dir?: string;
                before?: string;
                kind?: 'folder' | 'group';
                key?: string;
                collapsed?: boolean;
            }) => {
                const all = this.provider.getScripts();
                const script = msg.id ? all.find((s) => s.id === msg.id) : undefined;
                if (msg.type === 'run' && script) {
                    runScript(script);
                } else if (msg.type === 'assignGroup') {
                    const ids = msg.ids ?? (msg.id ? [msg.id] : []);
                    const scripts = ids.map((id) => all.find((s) => s.id === id)).filter((s): s is ScriptInfo => !!s);
                    if (scripts.length) {
                        void this.handlers.assignGroup(scripts);
                    }
                } else if (msg.type === 'editComment' && script) {
                    void this.handlers.editComment(script);
                } else if (msg.type === 'renameScript' && script) {
                    void this.handlers.renameScript(script);
                } else if (msg.type === 'dropScripts' && msg.ids?.length && msg.target) {
                    void dropScripts(this.store, all, msg.ids, msg.target).then(() => this.provider.refresh());
                } else if (msg.type === 'dropTree' && msg.keys?.length && msg.dir !== undefined) {
                    void dropTreeNodes(this.store, all, msg.keys, msg.dir, msg.before).then(() => this.provider.refresh());
                } else if (msg.type === 'toggleCollapse' && msg.kind && msg.key !== undefined) {
                    // Persist only; the webview already toggled its own DOM.
                    this.provider.setCollapsed(msg.kind, msg.key, !!msg.collapsed);
                } else if (msg.type === 'undo') {
                    void vscode.commands.executeCommand('scriptRunner.undo');
                } else if (msg.type === 'redo') {
                    void vscode.commands.executeCommand('scriptRunner.redo');
                } else if (msg.type === 'refresh') {
                    this.provider.refresh();
                } else if (msg.type === 'ready') {
                    void this.render();
                }
            },
            undefined,
            this.disposables,
        );

        // Re-render whenever the underlying data changes.
        this.provider.onDidChangeTreeData(() => void this.render(), undefined, this.disposables);

        webview.html = this.html();
    }

    private async render(): Promise<void> {
        const data = await buildData(this.provider, this.store);
        void this.webview.postMessage({ type: 'data', data });
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private html(): string {
        const nonce = String(Date.now());
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
    #toolbar { position: sticky; top: 0; background: var(--vscode-editor-background); display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); z-index: 1; }
    #search { flex: 1; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #tree { padding: 8px; }
    .folder-header, .group-header { cursor: pointer; padding: 2px 4px; border-radius: 3px; user-select: none; display: flex; align-items: center; gap: 6px; }
    .folder-header:hover, .group-header:hover { background: var(--vscode-list-hoverBackground); }
    .folder.collapsed > .children, .group.collapsed > .children { display: none; }
    .count { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 6px; }
    .group > .group-header { color: var(--vscode-charts-yellow); font-weight: 600; }
    .children { margin-left: 16px; }
    .icon { width: 16px; height: 16px; flex: 0 0 auto; opacity: 0.9; }
    .folder-icon { color: var(--vscode-charts-blue, var(--vscode-foreground)); }
    .group-icon { color: var(--vscode-charts-yellow); }
    .script-icon { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
    .script { display: flex; align-items: center; gap: 6px; padding: 3px 4px 3px 20px; border-radius: 3px; cursor: default; }
    .script:hover { background: var(--vscode-list-hoverBackground); }
    .runslot { position: relative; width: 16px; height: 16px; flex: 0 0 auto; }
    .runslot .script-icon { position: absolute; inset: 0; }
    .runbtn { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: transparent; border: none; padding: 0; cursor: pointer; color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
    .script:hover .runslot .script-icon { display: none; }
    .script:hover .runbtn { display: flex; }
    .script.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    #selbar { position: sticky; top: 41px; display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border); z-index: 1; }
    #selbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    #selbar button:hover { background: var(--vscode-button-hoverBackground); }
    #selbar button:disabled { opacity: 0.4; cursor: default; }
    #selbar #clearSel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    #selcount { color: var(--vscode-descriptionForeground); }
    .script .name { font-weight: 500; flex: 0 0 auto; }
    .script .cmd { color: var(--vscode-descriptionForeground); opacity: 0.65; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .script .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; flex: 0 0 auto; }
    .actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; flex: 0 0 auto; }
    .script:hover .actions { opacity: 1; }
    .action { background: transparent; padding: 2px 4px; color: var(--vscode-foreground); display: flex; align-items: center; }
    .action:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .empty { color: var(--vscode-descriptionForeground); padding: 20px; text-align: center; }
    .hidden { display: none; }
    .drop-into { background: var(--vscode-list-dropBackground, var(--vscode-list-hoverBackground)) !important; outline: 1px dashed var(--vscode-focusBorder); }
    #dropline { position: fixed; height: 2px; background: var(--vscode-focusBorder); pointer-events: none; z-index: 10; display: none; border-radius: 1px; }
    #dropline::before { content: ''; position: absolute; left: 0; top: -2px; width: 6px; height: 6px; border-radius: 50%; border: 2px solid var(--vscode-focusBorder); background: var(--vscode-editor-background); box-sizing: border-box; }
    .dragging { opacity: 0.5; }
</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="toolbar">
    <input id="search" type="text" placeholder="Filter scripts…" autocomplete="off" />
    <button id="refresh" title="Refresh">Refresh</button>
</div>
<div id="selbar" class="hidden">
    <span id="selcount"></span>
    <button id="assignSel" title="Assign selected scripts to a group">Assign to group…</button>
    <button id="clearSel" title="Clear selection">Clear</button>
</div>
<div id="tree"><div class="empty">Loading…</div></div>
<div id="dropline"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const treeEl = document.getElementById('tree');
const droplineEl = document.getElementById('dropline');
const searchEl = document.getElementById('search');
const selbarEl = document.getElementById('selbar');
const selcountEl = document.getElementById('selcount');
let currentData = null;

const selected = new Set();
let lastIndex = -1;

let dragKind = null; // 'script' | 'folder' | 'group'
let dragIds = [];
let dragPath = null;
let dragGroup = null; // group drag: group name
let dragEl = null; // dragged DOM node (script row, folder div or group div)
let dragDir = null; // script drag: source dir
let dragParent = null; // folder drag: parent container path

function visibleScripts() {
    return [...treeEl.querySelectorAll('.script:not(.hidden)')];
}
function updateSelUI() {
    for (const row of treeEl.querySelectorAll('.script')) {
        row.classList.toggle('selected', selected.has(row.dataset.id));
    }
    selbarEl.classList.toggle('hidden', selected.size === 0);
    document.getElementById('assignSel').disabled = selected.size === 0;
    selcountEl.textContent = selected.size + ' selected';
}
function clearSel() {
    selected.clear();
    lastIndex = -1;
    updateSelUI();
}
function pruneSel() {
    const present = new Set([...treeEl.querySelectorAll('.script')].map((r) => r.dataset.id));
    for (const id of [...selected]) {
        if (!present.has(id)) selected.delete(id);
    }
    lastIndex = -1;
    updateSelUI();
}

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('assignSel').addEventListener('click', () => {
    if (selected.size) vscode.postMessage({ type: 'assignGroup', ids: [...selected] });
});
document.getElementById('clearSel').addEventListener('click', clearSel);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected.size) {
        e.preventDefault();
        clearSel();
        return;
    }
    // Cmd/Ctrl+Z undoes the last config change (shift = redo, ctrl+y = redo).
    // Skip text fields so the search box keeps its native text undo.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z') {
        e.preventDefault();
        vscode.postMessage({ type: e.shiftKey ? 'redo' : 'undo' });
    } else if (key === 'y' && e.ctrlKey) {
        e.preventDefault();
        vscode.postMessage({ type: 'redo' });
    }
});
searchEl.addEventListener('input', () => applyFilter(searchEl.value.trim().toLowerCase()));

function endDrag() {
    if (dragEl) dragEl.classList.remove('dragging');
    dragKind = null;
    dragIds = [];
    dragPath = null;
    dragGroup = null;
    dragEl = null;
    dragDir = null;
    dragParent = null;
    clearIndicator();
}
function clearIndicator() {
    for (const el of treeEl.querySelectorAll('.drop-into')) {
        el.classList.remove('drop-into');
    }
    droplineEl.style.display = 'none';
}
// Draw the insertion line at the exact edge where the dragged item would land.
function showDropline(rect, after) {
    droplineEl.style.left = rect.left + 'px';
    droplineEl.style.width = rect.width + 'px';
    droplineEl.style.top = ((after ? rect.bottom : rect.top) - 1) + 'px';
    droplineEl.style.display = 'block';
}
function nextSibling(el, match) {
    let n = el.nextElementSibling;
    while (n && !match(n)) n = n.nextElementSibling;
    return n;
}
// Sibling key: groups by name, folders by path, scripts by id (matches order.ts).
function keyOf(el) {
    if (el.classList.contains('group')) return 'g:' + el.dataset.group;
    return el.classList.contains('folder') ? 'f:' + el.dataset.path : 's:' + el.dataset.id;
}
// Workspace-relative path of the container holding el ('' at the root; groups live at the root).
function containerDir(el) {
    const parent = el.parentElement.closest('.folder');
    return parent ? parent.dataset.path : '';
}
function nextTreeSibling(el) {
    return nextSibling(el, (x) => x.classList.contains('script') || x.classList.contains('folder') || x.classList.contains('group'));
}
function dropInfo(e) {
    if (dragKind === 'script') {
        const row = e.target.closest('.script');
        if (row) {
            if (row === dragEl) return null;
            // Group rows always accept (join/reorder); tree rows within the same dir,
            // and root rows accept any script (dropping there pins it to the root).
            if (!row.dataset.group && row.dataset.dir !== dragDir && containerDir(row) !== '') return null;
            const r = row.getBoundingClientRect();
            return { type: 'script-row', el: row, after: e.clientY > r.top + r.height / 2 };
        }
        const grp = e.target.closest('.group');
        if (grp) {
            const header = grp.querySelector(':scope > .group-header');
            if (e.target.closest('.group-header') === header) {
                // Any script can slot in next to a group via the header edges (pinning it
                // to the root); the middle joins the group.
                const r = header.getBoundingClientRect();
                if (e.clientY < r.top + r.height * 0.25) return { type: 'group-edge', el: grp, after: false };
                if (e.clientY >= r.bottom - r.height * 0.25) return { type: 'group-edge', el: grp, after: true };
            }
            return { type: 'group', el: grp };
        }
        const fd = e.target.closest('.folder');
        if (fd) {
            const canInto = fd.dataset.path === dragDir; // scripts land only in their own dir
            const canReorder = containerDir(fd) === dragDir || containerDir(fd) === ''; // sibling folder, or any root folder (pins)
            const header = fd.querySelector(':scope > .folder-header');
            if (e.target.closest('.folder-header') === header && canReorder) {
                // Header edges reorder next to the folder; the middle (if valid) drops into it.
                const r = header.getBoundingClientRect();
                const mid = r.top + r.height / 2;
                const beforeZone = canInto ? r.top + r.height * 0.25 : mid;
                const afterZone = canInto ? r.bottom - r.height * 0.25 : mid;
                if (e.clientY < beforeZone) return { type: 'folder', el: fd, after: false };
                if (e.clientY >= afterZone) return { type: 'folder', el: fd, after: true };
            }
            return canInto ? { type: 'dir', el: fd } : null;
        }
        return { type: 'ungroup', el: null };
    }
    if (dragKind === 'folder') {
        if (dragEl && dragEl.contains(e.target)) return null;
        const grp = e.target.closest('.group');
        if (grp) {
            // Root folders can slot in next to a group (groups live at the root).
            if (dragParent !== '') return null;
            const r = grp.querySelector(':scope > .group-header').getBoundingClientRect();
            return { type: 'group-edge', el: grp, after: e.clientY > r.top + r.height / 2 };
        }
        const row = e.target.closest('.script');
        if (row) {
            // Folders reorder only among siblings of their own parent container.
            if (row.dataset.group || containerDir(row) !== dragParent) return null;
            const r = row.getBoundingClientRect();
            return { type: 'script-row', el: row, after: e.clientY > r.top + r.height / 2 };
        }
        const fd = e.target.closest('.folder');
        if (fd && fd !== dragEl && containerDir(fd) === dragParent) {
            const r = fd.querySelector(':scope > .folder-header').getBoundingClientRect();
            return { type: 'folder', el: fd, after: e.clientY > r.top + r.height / 2 };
        }
        return null;
    }
    if (dragKind === 'group') {
        if (dragEl && dragEl.contains(e.target)) return null;
        const grp = e.target.closest('.group');
        if (grp && grp !== dragEl) {
            const r = grp.querySelector(':scope > .group-header').getBoundingClientRect();
            return { type: 'group-edge', el: grp, after: e.clientY > r.top + r.height / 2 };
        }
        const row = e.target.closest('.script');
        if (row) {
            // Groups reorder only among root-level items.
            if (row.dataset.group || containerDir(row) !== '') return null;
            const r = row.getBoundingClientRect();
            return { type: 'script-row', el: row, after: e.clientY > r.top + r.height / 2 };
        }
        const fd = e.target.closest('.folder');
        if (fd && containerDir(fd) === '') {
            const r = fd.querySelector(':scope > .folder-header').getBoundingClientRect();
            return { type: 'folder', el: fd, after: e.clientY > r.top + r.height / 2 };
        }
        return null;
    }
    return null;
}
function showIndicator(info) {
    clearIndicator();
    if (info.type === 'script-row') {
        showDropline(info.el.getBoundingClientRect(), info.after);
    } else if (info.type === 'group') {
        info.el.querySelector(':scope > .group-header').classList.add('drop-into');
    } else if (info.type === 'dir') {
        info.el.querySelector(':scope > .folder-header').classList.add('drop-into');
    } else if (info.type === 'folder' || info.type === 'group-edge') {
        // Dropping after a container inserts past its children, so use the whole box's rect.
        showDropline(info.el.getBoundingClientRect(), info.after);
    }
}
function post(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra));
}
function sendDrop(info) {
    const keys =
        dragKind === 'script' ? dragIds.map((id) => 's:' + id) : dragKind === 'folder' ? ['f:' + dragPath] : ['g:' + dragGroup];
    if (dragKind === 'script' && info.type === 'group') {
        post('dropScripts', { ids: dragIds, target: { kind: 'group', name: info.el.dataset.group } });
    } else if (dragKind === 'script' && info.type === 'ungroup') {
        // Empty space → pin to the root, outside any folder or group.
        post('dropTree', { keys, dir: '' });
    } else if (dragKind === 'script' && info.type === 'script-row' && info.el.dataset.group) {
        // Reorder within a group (groups hold scripts only).
        const row = info.el;
        let beforeId;
        if (!info.after) beforeId = row.dataset.id;
        else {
            const n = nextSibling(row, (x) => x.classList.contains('script'));
            beforeId = n ? n.dataset.id : undefined;
        }
        post('dropScripts', { ids: dragIds, target: { kind: 'group', name: row.dataset.group, beforeId } });
    } else if (dragKind === 'script' && info.type === 'dir') {
        post('dropTree', { keys, dir: info.el.dataset.path });
    } else if (info.type === 'script-row' || info.type === 'folder' || info.type === 'group-edge') {
        // Reorder among siblings — anchor may be a script, a folder or a group.
        let before;
        if (!info.after) before = keyOf(info.el);
        else {
            const n = nextTreeSibling(info.el);
            before = n ? keyOf(n) : undefined;
        }
        post('dropTree', { keys, dir: containerDir(info.el), before });
    }
}
treeEl.addEventListener('dragover', (e) => {
    const info = dropInfo(e);
    if (!info) {
        clearIndicator();
        return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showIndicator(info);
});
treeEl.addEventListener('drop', (e) => {
    const info = dropInfo(e);
    clearIndicator();
    if (!info) return;
    e.preventDefault();
    sendDrop(info);
});
treeEl.addEventListener('dragleave', (e) => {
    if (e.target === treeEl) clearIndicator();
});

window.addEventListener('message', (e) => {
    if (e.data.type === 'data') {
        currentData = e.data.data;
        renderTree(currentData);
        applyFilter(searchEl.value.trim().toLowerCase());
        pruneSel();
    }
});

const ICONS = {
    folder: '<svg class="icon folder-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14.5 3H7.7L6.6 1.9 6.3 1.8H1.5l-.5.5v11l.5.5h13l.5-.5v-9zM14 13H2V3h4l1.1 1.1.4.2H14z"/></svg>',
    group: '<svg class="icon group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2h5l1 1.5h6V13H2zm1 1v9h9V4.5H7.5L6.5 3z"/></svg>',
    script: '<svg class="icon script-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 2h13l.5.5v11l-.5.5h-13l-.5-.5v-11zM2 3v10h12V3zm1.6 2.1.7-.7L7 7.1v.8L4.3 10.6l-.7-.7L5.9 7.5zM8 9.5h4v1H8z"/></svg>',
    play: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
    tag: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1H2v6l7 7 6-6zm-3 4a1 1 0 110-2 1 1 0 010 2z"/></svg>',
    comment: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 2H2L1 3v8l1 1h2v3l3-3h7l1-1V3zm-1 8H6.5L5 11.5V10H2V3h11z"/></svg>',
    rename: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.2 1.8 14.2 2.8a1 1 0 010 1.4L5.4 13H2v-3.4l8.8-8.8a1 1 0 011.4 0zM3 12h1.6l6.7-6.7-1.6-1.6L3 10.4zm8.7-7.7 1-1-1-1-1 1z"/></svg>',
};

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}

function iconEl(svg) {
    const span = el('span');
    span.innerHTML = svg;
    return span.firstChild;
}

function actionBtn(svg, title, type, id) {
    const b = el('button', 'action');
    b.title = title;
    b.appendChild(iconEl(svg));
    b.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type, id });
    });
    return b;
}

function scriptNode(s) {
    const row = el('div', 'script');
    row.dataset.id = s.id;
    row.dataset.dir = s.dir;
    row.dataset.group = s.group || '';
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        dragKind = 'script';
        dragIds = selected.size && selected.has(s.id) ? [...selected] : [s.id];
        dragPath = null;
        dragEl = row;
        dragDir = s.dir;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', s.id);
    });
    row.addEventListener('dragend', endDrag);
    row.dataset.search = (s.name + ' ' + (s.displayName || '') + ' ' + (s.location || '') + ' ' + (s.comment || '') + ' ' + s.command).toLowerCase();
    row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'srScript', scriptId: s.id, preventDefaultContextMenuItems: true });
    row.title = s.command;
    // Left slot: script icon by default, swaps to a clickable play button on hover.
    const runSlot = el('span', 'runslot');
    runSlot.appendChild(iconEl(ICONS.script));
    const runBtn = el('button', 'runbtn');
    runBtn.title = 'Run';
    runBtn.appendChild(iconEl(ICONS.play));
    runBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'run', id: s.id });
    });
    runSlot.appendChild(runBtn);
    row.appendChild(runSlot);
    row.appendChild(el('span', 'name', s.displayName || s.name));
    row.appendChild(el('span', 'cmd', s.command));
    // When renamed, keep the real script name visible alongside location/comment.
    const renamed = s.displayName ? s.name : undefined;
    const metaBits = [s.location, renamed, s.comment].filter(Boolean).join(' — ');
    if (metaBits) row.appendChild(el('span', 'meta', metaBits));
    const actions = el('div', 'actions');
    actions.appendChild(actionBtn(ICONS.rename, 'Rename…', 'renameScript', s.id));
    actions.appendChild(actionBtn(ICONS.tag, 'Assign group…', 'assignGroup', s.id));
    actions.appendChild(actionBtn(ICONS.comment, 'Edit comment…', 'editComment', s.id));
    row.appendChild(actions);
    row.addEventListener('click', (e) => {
        const rows = visibleScripts();
        const idx = rows.indexOf(row);
        if (e.shiftKey) {
            e.preventDefault();
            window.getSelection().removeAllRanges();
            if (lastIndex < 0) lastIndex = idx;
            const lo = Math.min(lastIndex, idx);
            const hi = Math.max(lastIndex, idx);
            for (let i = lo; i <= hi; i++) selected.add(rows[i].dataset.id);
            updateSelUI();
        } else if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            selected.add(s.id);
            lastIndex = idx;
            updateSelUI();
        } else {
            // Plain click no longer runs; use the hover play button. Just clear any selection.
            if (selected.size) clearSel();
        }
    });
    return row;
}

function folderNode(f) {
    if (!f.children.length) return null;
    // Custom collapsible (not native <details>): Chromium won't start a drag from a
    // <summary>, so the header is a plain draggable <div> — same as script rows, which
    // drag reliably. JS toggles the collapsed class; a drag gesture suppresses the click.
    const details = el('div', 'folder' + (f.collapsed ? ' collapsed' : ''));
    details.dataset.path = f.path;
    const header = el('div', 'folder-header');
    header.draggable = true;
    header.appendChild(iconEl(ICONS.folder));
    header.appendChild(el('span', 'label', f.label));
    header.appendChild(el('span', 'count', String(f.count)));
    header.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        dragKind = 'folder';
        dragPath = f.path;
        dragIds = [];
        dragEl = details;
        dragParent = containerDir(details);
        details.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f.path);
    });
    header.addEventListener('dragend', endDrag);
    header.addEventListener('click', () => {
        const collapsed = details.classList.toggle('collapsed');
        vscode.postMessage({ type: 'toggleCollapse', kind: 'folder', key: f.path, collapsed });
    });
    details.appendChild(header);
    const children = el('div', 'children');
    for (const c of f.children) {
        const n = c.kind === 'folder' ? folderNode(c.folder) : scriptNode(c.script);
        if (n) children.appendChild(n);
    }
    details.appendChild(children);
    return details;
}

function groupNode(g) {
    // Same custom collapsible pattern as folders (a <summary> won't start a drag).
    const box = el('div', 'group' + (g.collapsed ? ' collapsed' : ''));
    box.dataset.group = g.name;
    const header = el('div', 'group-header');
    header.dataset.vscodeContext = JSON.stringify({ webviewSection: 'srGroup', groupName: g.name, preventDefaultContextMenuItems: true });
    header.draggable = true;
    header.appendChild(iconEl(ICONS.group));
    header.appendChild(el('span', 'label', g.name));
    header.appendChild(el('span', 'count', String(g.count)));
    header.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        dragKind = 'group';
        dragGroup = g.name;
        dragIds = [];
        dragPath = null;
        dragEl = box;
        box.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', g.name);
    });
    header.addEventListener('dragend', endDrag);
    header.addEventListener('click', () => {
        const collapsed = box.classList.toggle('collapsed');
        vscode.postMessage({ type: 'toggleCollapse', kind: 'group', key: g.name, collapsed });
    });
    box.appendChild(header);
    const children = el('div', 'children');
    for (const s of g.scripts) children.appendChild(scriptNode(s));
    box.appendChild(children);
    return box;
}

function renderTree(data) {
    treeEl.innerHTML = '';
    let any = false;
    // Root — groups, folders and scripts interleaved in persisted order.
    for (const c of data.root) {
        const n = c.kind === 'group' ? groupNode(c.group) : c.kind === 'folder' ? folderNode(c.folder) : scriptNode(c.script);
        if (n) { any = true; treeEl.appendChild(n); }
    }
    if (!any) treeEl.appendChild(el('div', 'empty', 'No scripts found.'));
}

function applyFilter(q) {
    const scripts = treeEl.querySelectorAll('.script');
    for (const row of scripts) {
        const match = !q || row.dataset.search.includes(q);
        row.classList.toggle('hidden', !match);
    }
    // Hide containers with no visible scripts; expand all while filtering.
    const containers = treeEl.querySelectorAll('.group, .folder');
    for (const d of containers) {
        const visible = d.querySelectorAll('.script:not(.hidden)').length > 0;
        d.classList.toggle('hidden', !visible);
        if (q) d.classList.remove('collapsed');
    }
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
