import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    sortScripts,
    treeDir,
    childKey,
    rootKey,
    buildFolderTree,
    buildRoot,
    reorderKeys,
    dropScripts,
    dropTreeNodes,
    dropFolders,
    OrderedFolder,
    RootChild,
} from '../src/order';
import { RunnerConfig } from '../src/model';
import { makeScript, FakeStore, asStore } from './helpers';

// ---------- sortScripts ----------

test('sortScripts: ordered before unordered, then by dir then name', () => {
    const a = makeScript('pkg-b', 'build', { order: 1 });
    const b = makeScript('pkg-a', 'zzz');
    const c = makeScript('pkg-a', 'aaa');
    const d = makeScript('pkg-b', 'test', { order: 0 });
    const sorted = sortScripts([a, b, c, d]).map((s) => s.id);
    // ordered (0,1) first, then unordered by dir/name
    assert.deepEqual(sorted, ['pkg-b#test', 'pkg-b#build', 'pkg-a#aaa', 'pkg-a#zzz']);
});

test('sortScripts: does not mutate input', () => {
    const input = [makeScript('a', 'y'), makeScript('a', 'x')];
    const copy = [...input];
    sortScripts(input);
    assert.deepEqual(input, copy);
});

// ---------- treeDir ----------

test('treeDir: root-pinned script lives at root', () => {
    assert.equal(treeDir(makeScript('packages/app', 'build', { root: true })), '');
    assert.equal(treeDir(makeScript('packages/app', 'build')), 'packages/app');
});

// ---------- buildFolderTree ----------

test('buildFolderTree: nests scripts by directory', () => {
    const tree = buildFolderTree([
        makeScript('', 'root-script'),
        makeScript('packages/a', 'build'),
        makeScript('packages/b', 'test'),
    ]);
    // root has: packages folder + root-script
    const folders = tree.children.filter((c) => c.kind === 'folder');
    assert.equal(folders.length, 1);
    const packages = folders[0].kind === 'folder' ? folders[0].folder : null;
    assert.ok(packages);
    assert.equal(packages!.label, 'packages');
    assert.equal(packages!.count, 2);
    assert.deepEqual(
        packages!.children.map((c) => (c.kind === 'folder' ? c.folder.label : c.script.name)),
        ['a', 'b'],
    );
});

test('buildFolderTree: compacts single-child chains', () => {
    const tree = buildFolderTree([makeScript('a/b/c', 'build')]);
    const folder = tree.children[0];
    assert.equal(folder.kind, 'folder');
    if (folder.kind === 'folder') {
        assert.equal(folder.folder.label, 'a/b/c');
        assert.equal(folder.folder.path, 'a/b/c');
    }
});

test('buildFolderTree: does not compact when a node owns scripts', () => {
    const tree = buildFolderTree([makeScript('a', 'own'), makeScript('a/b', 'deep')]);
    const folder = tree.children[0];
    assert.equal(folder.kind, 'folder');
    if (folder.kind === 'folder') {
        assert.equal(folder.folder.label, 'a');
        const sub = folder.folder.children.find((c) => c.kind === 'folder');
        assert.ok(sub);
    }
});

test('buildFolderTree: root defaults scripts before folders; folder defaults folders before scripts', () => {
    const tree = buildFolderTree([makeScript('', 'zzz-root'), makeScript('sub', 'child')]);
    // root: script first, folder second
    assert.deepEqual(tree.children.map((c) => c.kind), ['script', 'folder']);
});

test('buildFolderTree: folderOrder overrides default ordering', () => {
    const scripts = [makeScript('alpha', 'a'), makeScript('beta', 'b')];
    const tree = buildFolderTree(scripts, { beta: 0, alpha: 1 });
    assert.deepEqual(
        tree.children.map((c) => (c.kind === 'folder' ? c.folder.label : c.script.name)),
        ['beta', 'alpha'],
    );
});

// ---------- buildRoot ----------

test('buildRoot: groups, then root scripts, then folders by default', () => {
    const scripts = [
        makeScript('', 'root-a'),
        makeScript('pkg', 'in-folder'),
        makeScript('', 'grouped', { group: 'G' }),
    ];
    const config: RunnerConfig = { scripts: {} };
    const root = buildRoot(scripts, config);
    assert.deepEqual(root.map((c) => c.kind), ['group', 'script', 'folder']);
    assert.equal(root[0].kind === 'group' ? root[0].name : '', 'G');
});

test('buildRoot: shared index space interleaves group/folder/script', () => {
    const scripts = [
        makeScript('', 'pinned', { order: 1 }),
        makeScript('pkg', 'foldered'),
        makeScript('', 'g1', { group: 'G' }),
    ];
    const config: RunnerConfig = {
        scripts: {},
        groups: { G: 2 },
        folders: { pkg: 0 },
    };
    const root = buildRoot(scripts, config);
    assert.deepEqual(
        root.map((c) => rootKey(c)),
        ['f:pkg', 's:#pinned', 'g:G'],
    );
});

// ---------- reorderKeys ----------

test('reorderKeys: moves before target key', () => {
    assert.deepEqual(reorderKeys(['a', 'b', 'c', 'd'], ['d'], 'b'), ['a', 'd', 'b', 'c']);
});

test('reorderKeys: appends when beforeKey missing', () => {
    assert.deepEqual(reorderKeys(['a', 'b', 'c'], ['a'], undefined), ['b', 'c', 'a']);
    assert.deepEqual(reorderKeys(['a', 'b', 'c'], ['a'], 'zzz'), ['b', 'c', 'a']);
});

test('reorderKeys: preserves moving order and dedupes', () => {
    assert.deepEqual(reorderKeys(['a', 'b', 'c', 'd'], ['c', 'a'], 'd'), ['b', 'c', 'a', 'd']);
});

test('reorderKeys: beforeKey inside moving set is ignored (appends)', () => {
    assert.deepEqual(reorderKeys(['a', 'b', 'c'], ['a', 'b'], 'a'), ['c', 'a', 'b']);
});

// ---------- childKey / rootKey ----------

test('childKey and rootKey encode kind', () => {
    const folder: OrderedFolder = { label: 'p', path: 'p', count: 0, children: [] };
    assert.equal(childKey({ kind: 'folder', folder }), 'f:p');
    assert.equal(childKey({ kind: 'script', script: makeScript('d', 'n') }), 's:d#n');
    const group: RootChild = { kind: 'group', name: 'G', scripts: [] };
    assert.equal(rootKey(group), 'g:G');
});

// ---------- dropScripts ----------

test('dropScripts: assigns group and sequential order', async () => {
    const scripts = [makeScript('', 'a'), makeScript('', 'b')];
    const store = new FakeStore();
    await dropScripts(asStore(store), scripts, ['#a', '#b'], { kind: 'group', name: 'G' });
    assert.equal(store.entry('#a')?.group, 'G');
    assert.equal(store.entry('#b')?.group, 'G');
    assert.equal(store.entry('#a')?.order, 0);
    assert.equal(store.entry('#b')?.order, 1);
});

test('dropScripts: ungroup clears the group', async () => {
    const scripts = [makeScript('', 'a', { group: 'G' })];
    const store = new FakeStore({ scripts: { '#a': { group: 'G', order: 3 } } });
    await dropScripts(asStore(store), scripts, ['#a'], { kind: 'ungroup' });
    assert.equal(store.entry('#a')?.group, undefined);
});

test('dropScripts: no-op for unknown ids does not save', async () => {
    const store = new FakeStore();
    await dropScripts(asStore(store), [], ['#nope'], { kind: 'group', name: 'G' });
    assert.equal(store.saves, 0);
});

test('dropScripts: inserts before an existing group member', async () => {
    const scripts = [
        makeScript('', 'x', { group: 'G', order: 0 }),
        makeScript('', 'y', { group: 'G', order: 1 }),
        makeScript('', 'z'),
    ];
    const store = new FakeStore({ scripts: { '#x': { group: 'G', order: 0 }, '#y': { group: 'G', order: 1 } } });
    await dropScripts(asStore(store), scripts, ['#z'], { kind: 'group', name: 'G', beforeId: '#y' });
    assert.equal(store.entry('#z')?.order, 1);
    assert.equal(store.entry('#y')?.order, 2);
});

// ---------- dropTreeNodes ----------

test('dropTreeNodes: pinning to root sets root flag and clears group', async () => {
    const scripts = [makeScript('pkg', 'build', { group: 'G' }), makeScript('', 'root-x')];
    const store = new FakeStore({ scripts: { 'pkg#build': { group: 'G' } } });
    await dropTreeNodes(asStore(store), scripts, ['s:pkg#build'], '', undefined);
    assert.equal(store.entry('pkg#build')?.group, undefined);
    assert.equal(store.entry('pkg#build')?.root, true);
    assert.equal(typeof store.entry('pkg#build')?.order, 'number');
});

test('dropTreeNodes: dropping into own dir unpins (no root flag)', async () => {
    const scripts = [makeScript('pkg', 'build', { root: true }), makeScript('pkg', 'test')];
    const store = new FakeStore({ scripts: { 'pkg#build': { root: true } } });
    await dropTreeNodes(asStore(store), scripts, ['s:pkg#build'], 'pkg', undefined);
    assert.equal(store.entry('pkg#build')?.root, undefined);
});

test('dropTreeNodes: empty movingKeys is a no-op', async () => {
    const store = new FakeStore();
    await dropTreeNodes(asStore(store), [], [], '', undefined);
    assert.equal(store.saves, 0);
});

test('dropTreeNodes: reorders folders at root', async () => {
    const scripts = [makeScript('alpha', 'a'), makeScript('beta', 'b')];
    const store = new FakeStore();
    // move beta before alpha
    await dropTreeNodes(asStore(store), scripts, ['f:beta'], '', 'f:alpha');
    assert.ok((store.config.folders?.beta ?? 99) < (store.config.folders?.alpha ?? 99));
});

// ---------- dropFolders ----------

test('dropFolders: reorders sibling folders', async () => {
    const scripts = [makeScript('alpha', 'a'), makeScript('beta', 'b'), makeScript('gamma', 'c')];
    const store = new FakeStore();
    await dropFolders(asStore(store), scripts, ['gamma'], 'alpha');
    const f = store.config.folders!;
    assert.ok(f.gamma < f.alpha, 'gamma should sort before alpha');
});

test('dropFolders: empty paths is a no-op', async () => {
    const store = new FakeStore();
    await dropFolders(asStore(store), [], [], undefined);
    assert.equal(store.saves, 0);
});
