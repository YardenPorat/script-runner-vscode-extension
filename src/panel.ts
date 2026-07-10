import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo } from './model';
import { ScriptTreeProvider } from './tree';
import { runScript } from './runner';
import { buildFolderTree, dropFolders, dropScripts, OrderedFolder, ScriptDropTarget, sortScripts } from './order';

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

interface PanelFolder {
    label: string;
    path: string;
    count: number;
    folders: PanelFolder[];
    scripts: PanelScript[];
}

interface PanelGroup {
    name: string;
    count: number;
    scripts: PanelScript[];
}

interface PanelData {
    groups: PanelGroup[];
    tree: PanelFolder;
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

function toPanelFolder(f: OrderedFolder): PanelFolder {
    return {
        label: f.label,
        path: f.path,
        count: f.count,
        folders: f.folders.map(toPanelFolder),
        scripts: f.scripts.map((s) => toPanelScript(s, false)),
    };
}

async function buildData(provider: ScriptTreeProvider, store: ConfigStore): Promise<PanelData> {
    const scripts = await provider.ensureScripts();
    const config = await store.load();

    const grouped = new Map<string, ScriptInfo[]>();
    const ungrouped: ScriptInfo[] = [];
    for (const script of scripts) {
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

    const groups: PanelGroup[] = orderedGroups.map((name) => {
        const list = sortScripts(grouped.get(name) ?? []);
        return { name, count: list.length, scripts: list.map((s) => toPanelScript(s, true)) };
    });

    return { groups, tree: toPanelFolder(buildFolderTree(ungrouped, config.folders ?? {})) };
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

    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly provider: ScriptTreeProvider,
        private readonly store: ConfigStore,
        private readonly handlers: PanelHandlers,
    ) {
        panel.webview.onDidReceiveMessage(
            (msg: {
                type: string;
                id?: string;
                ids?: string[];
                target?: ScriptDropTarget;
                paths?: string[];
                beforePath?: string;
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
                } else if (msg.type === 'dropFolders' && msg.paths?.length) {
                    void dropFolders(this.store, all, msg.paths, msg.beforePath).then(() => this.provider.refresh());
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

        panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

        panel.webview.html = this.html();
    }

    private async render(): Promise<void> {
        const data = await buildData(this.provider, this.store);
        void this.panel.webview.postMessage({ type: 'data', data });
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
    details { margin: 0; }
    summary { cursor: pointer; padding: 2px 4px; border-radius: 3px; user-select: none; display: flex; align-items: center; gap: 6px; }
    summary::-webkit-details-marker { display: none; }
    summary:hover { background: var(--vscode-list-hoverBackground); }
    .count { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 6px; }
    .group > summary { color: var(--vscode-charts-yellow); font-weight: 600; }
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
    .drop-before { box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder); }
    .drop-after { box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder); }
    .drop-into { background: var(--vscode-list-dropBackground, var(--vscode-list-hoverBackground)) !important; outline: 1px dashed var(--vscode-focusBorder); }
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
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const treeEl = document.getElementById('tree');
const searchEl = document.getElementById('search');
const selbarEl = document.getElementById('selbar');
const selcountEl = document.getElementById('selcount');
let currentData = null;

const selected = new Set();
let lastIndex = -1;

let dragKind = null; // 'script' | 'folder'
let dragIds = [];
let dragPath = null;

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
    }
});
searchEl.addEventListener('input', () => applyFilter(searchEl.value.trim().toLowerCase()));

function endDrag() {
    dragKind = null;
    dragIds = [];
    dragPath = null;
    clearIndicator();
}
function clearIndicator() {
    for (const el of treeEl.querySelectorAll('.drop-before,.drop-after,.drop-into')) {
        el.classList.remove('drop-before', 'drop-after', 'drop-into');
    }
}
function nextSibling(el, match) {
    let n = el.nextElementSibling;
    while (n && !match(n)) n = n.nextElementSibling;
    return n;
}
function dropInfo(e) {
    if (dragKind === 'script') {
        const row = e.target.closest('.script');
        if (row) {
            const r = row.getBoundingClientRect();
            return { type: 'script-row', el: row, after: e.clientY > r.top + r.height / 2 };
        }
        const groupSum = e.target.closest('details.group');
        if (groupSum) return { type: 'group', el: groupSum };
        const folderSum = e.target.closest('details:not(.group)');
        if (folderSum) return { type: 'dir', el: folderSum };
        return { type: 'ungroup', el: null };
    }
    if (dragKind === 'folder') {
        const fd = e.target.closest('details:not(.group)');
        if (fd && fd.dataset.path !== dragPath) {
            const r = fd.querySelector(':scope > summary').getBoundingClientRect();
            return { type: 'folder', el: fd, after: e.clientY > r.top + r.height / 2 };
        }
        return null;
    }
    return null;
}
function showIndicator(info) {
    clearIndicator();
    if (info.type === 'script-row') {
        info.el.classList.add(info.after ? 'drop-after' : 'drop-before');
    } else if (info.type === 'group' || info.type === 'dir') {
        info.el.querySelector(':scope > summary').classList.add('drop-into');
    } else if (info.type === 'folder') {
        info.el.querySelector(':scope > summary').classList.add(info.after ? 'drop-after' : 'drop-before');
    }
}
function post(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra));
}
function sendDrop(info) {
    if (dragKind === 'script') {
        if (info.type === 'script-row') {
            const row = info.el;
            let beforeId;
            if (!info.after) beforeId = row.dataset.id;
            else {
                const n = nextSibling(row, (x) => x.classList.contains('script'));
                beforeId = n ? n.dataset.id : undefined;
            }
            const target = row.dataset.group
                ? { kind: 'group', name: row.dataset.group, beforeId }
                : { kind: 'dir', dir: row.dataset.dir, beforeId };
            post('dropScripts', { ids: dragIds, target });
        } else if (info.type === 'group') {
            post('dropScripts', { ids: dragIds, target: { kind: 'group', name: info.el.dataset.group } });
        } else if (info.type === 'dir') {
            post('dropScripts', { ids: dragIds, target: { kind: 'dir', dir: info.el.dataset.path } });
        } else if (info.type === 'ungroup') {
            post('dropScripts', { ids: dragIds, target: { kind: 'ungroup' } });
        }
    } else if (dragKind === 'folder' && info.type === 'folder') {
        const fd = info.el;
        let beforePath;
        if (!info.after) beforePath = fd.dataset.path;
        else {
            const n = nextSibling(fd, (x) => x.tagName === 'DETAILS' && !x.classList.contains('group'));
            beforePath = n ? n.dataset.path : undefined;
        }
        post('dropFolders', { paths: [dragPath], beforePath });
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

function folderNode(f, open) {
    if (!f.folders.length && !f.scripts.length) return null;
    const details = el('details');
    details.dataset.path = f.path;
    details.open = open;
    // Drag the whole <details> (Chromium won't reliably start a drag from a <summary>).
    // Nested script rows / sub-folders stopPropagation so the innermost element wins.
    details.draggable = true;
    details.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        dragKind = 'folder';
        dragPath = f.path;
        dragIds = [];
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f.path);
    });
    details.addEventListener('dragend', endDrag);
    const summary = el('summary');
    summary.appendChild(iconEl(ICONS.folder));
    summary.appendChild(el('span', 'label', f.label));
    summary.appendChild(el('span', 'count', String(f.count)));
    details.appendChild(summary);
    const children = el('div', 'children');
    for (const sub of f.folders) {
        const n = folderNode(sub, open);
        if (n) children.appendChild(n);
    }
    for (const s of f.scripts) children.appendChild(scriptNode(s));
    details.appendChild(children);
    return details;
}

function renderTree(data) {
    treeEl.innerHTML = '';
    let any = false;
    for (const g of data.groups) {
        any = true;
        const details = el('details', 'group');
        details.dataset.group = g.name;
        details.open = true;
        const summary = el('summary');
        summary.appendChild(iconEl(ICONS.group));
        summary.appendChild(el('span', 'label', g.name));
        summary.appendChild(el('span', 'count', String(g.count)));
        details.appendChild(summary);
        const children = el('div', 'children');
        for (const s of g.scripts) children.appendChild(scriptNode(s));
        details.appendChild(children);
        treeEl.appendChild(details);
    }
    // Root folder tree — root scripts sort before folders.
    for (const s of data.tree.scripts) { any = true; treeEl.appendChild(scriptNode(s)); }
    for (const sub of data.tree.folders) {
        const n = folderNode(sub, true);
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
    const containers = treeEl.querySelectorAll('details');
    for (const d of containers) {
        const visible = d.querySelectorAll('.script:not(.hidden)').length > 0;
        d.classList.toggle('hidden', !visible);
        if (q) d.open = true;
    }
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }

    private dispose(): void {
        ScriptPanel.instance = undefined;
        this.panel.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
