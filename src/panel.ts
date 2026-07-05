import * as vscode from 'vscode';
import { ConfigStore, ScriptInfo } from './model';
import { ScriptTreeProvider } from './tree';
import { runScript } from './runner';

interface PanelScript {
    id: string;
    name: string;
    command: string;
    comment?: string;
    location?: string;
}

interface PanelFolder {
    label: string;
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

interface DirNode {
    dirs: Map<string, DirNode>;
    scripts: ScriptInfo[];
}

function toPanelScript(s: ScriptInfo, showLocation: boolean): PanelScript {
    return {
        id: s.id,
        name: s.name,
        command: s.command,
        comment: s.comment,
        location: showLocation ? s.pkgRelDir || '(root)' : undefined,
    };
}

function buildFolderTree(scripts: ScriptInfo[]): PanelFolder {
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

    const toFolder = (label: string, node: DirNode): PanelFolder => {
        const folders = [...node.dirs.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, child]) => {
                // Compact single-child chains with no scripts of their own: a/b/c
                let lbl = name;
                let c = child;
                while (c.scripts.length === 0 && c.dirs.size === 1) {
                    const [nextName, nextChild] = c.dirs.entries().next().value as [string, DirNode];
                    lbl += `/${nextName}`;
                    c = nextChild;
                }
                return toFolder(lbl, c);
            });
        return {
            label,
            count: countScripts(node),
            folders,
            scripts: node.scripts.map((s) => toPanelScript(s, false)),
        };
    };

    return toFolder('', root);
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
        const list = grouped.get(name) ?? [];
        return { name, count: list.length, scripts: list.map((s) => toPanelScript(s, true)) };
    });

    return { groups, tree: buildFolderTree(ungrouped) };
}

export interface PanelHandlers {
    assignGroup(script: ScriptInfo): Promise<void>;
    editComment(script: ScriptInfo): Promise<void>;
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
            (msg: { type: string; id?: string }) => {
                const script = msg.id ? this.provider.getScripts().find((s) => s.id === msg.id) : undefined;
                if (msg.type === 'run' && script) {
                    runScript(script);
                } else if (msg.type === 'assignGroup' && script) {
                    void this.handlers.assignGroup(script);
                } else if (msg.type === 'editComment' && script) {
                    void this.handlers.editComment(script);
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
    .script { display: flex; align-items: center; gap: 6px; padding: 3px 4px 3px 20px; border-radius: 3px; cursor: pointer; }
    .script:hover { background: var(--vscode-list-hoverBackground); }
    .script .name { font-weight: 500; flex: 0 0 auto; }
    .script .cmd { color: var(--vscode-descriptionForeground); opacity: 0.65; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .script .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; flex: 0 0 auto; }
    .actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; flex: 0 0 auto; }
    .script:hover .actions { opacity: 1; }
    .action { background: transparent; padding: 2px 4px; color: var(--vscode-foreground); display: flex; align-items: center; }
    .action:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .empty { color: var(--vscode-descriptionForeground); padding: 20px; text-align: center; }
    .hidden { display: none; }
</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="toolbar">
    <input id="search" type="text" placeholder="Filter scripts…" autocomplete="off" />
    <button id="refresh" title="Refresh">Refresh</button>
</div>
<div id="tree"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const treeEl = document.getElementById('tree');
const searchEl = document.getElementById('search');
let currentData = null;

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
searchEl.addEventListener('input', () => applyFilter(searchEl.value.trim().toLowerCase()));

window.addEventListener('message', (e) => {
    if (e.data.type === 'data') {
        currentData = e.data.data;
        renderTree(currentData);
        applyFilter(searchEl.value.trim().toLowerCase());
    }
});

const ICONS = {
    folder: '<svg class="icon folder-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14.5 3H7.7L6.6 1.9 6.3 1.8H1.5l-.5.5v11l.5.5h13l.5-.5v-9zM14 13H2V3h4l1.1 1.1.4.2H14z"/></svg>',
    group: '<svg class="icon group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2h5l1 1.5h6V13H2zm1 1v9h9V4.5H7.5L6.5 3z"/></svg>',
    script: '<svg class="icon script-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 2h13l.5.5v11l-.5.5h-13l-.5-.5v-11zM2 3v10h12V3zm1.6 2.1.7-.7L7 7.1v.8L4.3 10.6l-.7-.7L5.9 7.5zM8 9.5h4v1H8z"/></svg>',
    tag: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1H2v6l7 7 6-6zm-3 4a1 1 0 110-2 1 1 0 010 2z"/></svg>',
    comment: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 2H2L1 3v8l1 1h2v3l3-3h7l1-1V3zm-1 8H6.5L5 11.5V10H2V3h11z"/></svg>',
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
    row.dataset.search = (s.name + ' ' + (s.location || '') + ' ' + (s.comment || '') + ' ' + s.command).toLowerCase();
    row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'srScript', scriptId: s.id, preventDefaultContextMenuItems: true });
    row.title = s.command;
    row.appendChild(iconEl(ICONS.script));
    row.appendChild(el('span', 'name', s.name));
    row.appendChild(el('span', 'cmd', s.command));
    const metaBits = [s.location, s.comment].filter(Boolean).join(' — ');
    if (metaBits) row.appendChild(el('span', 'meta', metaBits));
    const actions = el('div', 'actions');
    actions.appendChild(actionBtn(ICONS.tag, 'Assign group…', 'assignGroup', s.id));
    actions.appendChild(actionBtn(ICONS.comment, 'Edit comment…', 'editComment', s.id));
    row.appendChild(actions);
    row.addEventListener('click', () => vscode.postMessage({ type: 'run', id: s.id }));
    return row;
}

function folderNode(f, open) {
    if (!f.folders.length && !f.scripts.length) return null;
    const details = el('details');
    details.open = open;
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
