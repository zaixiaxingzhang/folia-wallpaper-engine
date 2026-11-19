'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const local = require('../local-files.cjs');

test('WE local library and batch file imports', async (t) => {
    const tempRoot = await fs.promises.realpath(os.tmpdir());
    const fixture = await fs.promises.mkdtemp(path.join(tempRoot, 'folia-batch-test-'));
    t.after(async () => {
        // Restrict recursive cleanup to the exact temporary fixture created above.
        assert.equal(path.dirname(path.resolve(fixture)), tempRoot);
        assert.ok(path.basename(fixture).startsWith('folia-batch-test-'));
        await fs.promises.rm(fixture, { recursive: true, force: true });
    });
    const write = async (file, value = Buffer.alloc(32, 7)) => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, value);
        return file;
    };
    const files = [];
    for (let i = 0; i < 72; i++) files.push(await write(path.join(fixture, 'media', i < 70 ? `video-${i}.mp4` : `nested/image-${i}.png`)));
    await write(path.join(fixture, 'media', 'ignored.txt'), 'not media');
    const stored = new Map();
    const storage = { get: async (key) => stored.get(key),
        set: async (key, value) => stored.set(key, JSON.parse(JSON.stringify(value))) };

    await t.test('more than 32 files, nested folders, deduplication, persistence and non-destructive removal', async () => {
        const found = await local.collectFolder(path.join(fixture, 'media'));
        assert.equal(found.files.length, 72);
        const store = local.createLocalFiles({ storage });
        assert.equal((await store.remember(found.files)).added, 72);
        const duplicate = await store.remember([files[0], files[0], path.join(fixture, 'absent.mp4'), path.join(fixture, 'media/ignored.txt')]);
        assert.equal(duplicate.added, 0);
        assert.equal(duplicate.duplicates, 2);
        assert.equal(duplicate.skipped, 2);
        const reopened = local.createLocalFiles({ storage });
        assert.equal((await reopened.items()).length, 72);
        await reopened.remove((await reopened.items())[0].id);
        assert.equal((await reopened.items()).length, 71);
        assert.ok(fs.existsSync(files[0]));
    });

    await t.test('native picker requests multi-selection, cancellation preserves state, folder selection includes children', async () => {
        let options;
        let result = { canceled: false, filePaths: files.slice(0, 70) };
        const fakeElectron = { BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
            dialog: { showOpenDialog: async (value) => { options = value; return result; } } };
        const ownRequire = createRequire(path.join(root, 'local-files.cjs'));
        const context = { module: { exports: {} }, process,
            require: (name) => name === 'electron' ? fakeElectron : ownRequire(name) };
        vm.runInNewContext(fs.readFileSync(path.join(root, 'local-files.cjs'), 'utf8'), context);
        const values = new Map();
        const picker = context.module.exports.createLocalFiles({ storage: {
            get: async (key) => values.get(key), set: async (key, value) => values.set(key, value) } });
        assert.equal((await picker.pick({ kind: 'video' })).added, 70);
        assert.ok(options.properties.includes('multiSelections'));
        result = { canceled: true, filePaths: [] };
        assert.equal((await picker.pick()).canceled, true);
        assert.equal((await picker.items()).length, 70);
        result = { canceled: false, filePaths: [path.join(fixture, 'media')] };
        assert.equal((await picker.pick({ folder: true })).added, 2);
        assert.ok(options.properties.includes('openDirectory'));
    });

    const steam = path.join(fixture, 'steam');
    const workshop = path.join(steam, 'steamapps/workshop/content/431960/123456');
    const engine = path.join(steam, 'steamapps/common/wallpaper_engine');
    for (const dir of [workshop, path.join(engine, 'projects/defaultprojects/builtin'), path.join(engine, 'projects/myprojects/no-type')]) {
        await write(path.join(dir, 'video.mp4'));
        await write(path.join(dir, 'project.json'), JSON.stringify({ file: 'video.mp4' }));
    }
    await write(path.join(engine, 'config.json'), JSON.stringify({ namedProfile: { general: {
        localfiles: files,
        wallpaperconfig: { selectedwallpapers: { Monitor0: { file: files[0], playlist: { items: [files[0], files[0]] } } } },
    } } }));
    const main = path.join(root, 'main.cjs');
    const requireMain = createRequire(main);
    const boundedFs = { ...fs, promises: { ...fs.promises, stat: async (file) => {
        if (!local.pathKey(file).startsWith(local.pathKey(fixture) + path.sep)) throw Object.assign(new Error('fixture only'), { code: 'ENOENT' });
        return fs.promises.stat(file);
    } } };
    const context = { module: { exports: {} }, process: { platform: process.platform, env: {} },
        Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
        require: (name) => name === 'fs' ? boundedFs : name === './local-files.cjs'
            ? { ...local, registeredSteamRoots: async () => [steam, steam] } : requireMain(name) };
    vm.runInNewContext(fs.readFileSync(main, 'utf8') + '\nmodule.exports.scanForTest = scanLibrary;', context, { filename: main });

    await t.test('named WE accounts, active playlist, missing project type, built-ins and path deduplication', async () => {
        const library = await context.module.exports.scanForTest();
        assert.equal(library.items.length, 75);
        assert.equal(library.items.filter((item) => item.source === 'we-local').length, 72);
        assert.equal(new Set(library.items.map((item) => item.id)).size, 75);
        assert.ok(library.currentId);
        assert.equal(library.items.filter((item) => item.source === 'local').length, 1);
        assert.equal(library.items.filter((item) => item.source === 'builtin').length, 1);
    });

    await t.test('one-click WE imports, repeat import, range playback and single-file path isolation', async () => {
        const handlers = new Map();
        const values = new Map();
        const api = { storage: { get: async (key) => values.get(key), set: async (key, value) => values.set(key, value) },
            rpc: { handle: (name, fn) => handlers.set(name, fn), send: () => {} },
            log: { info: () => {}, error: () => {} }, onDispose: () => {} };
        const dispose = context.module.exports(api);
        try {
            assert.equal((await handlers.get('importWeFiles')()).added, 72);
            assert.equal((await handlers.get('importWeFiles')()).duplicates, 72);
            const batch = await handlers.get('customFiles')();
            assert.equal(batch.items.length, 72);
            const item = batch.items.find((entry) => entry.kind === 'video');
            const response = await fetch(item.url, { headers: { Range: 'bytes=0-15' } });
            assert.equal(response.status, 206);
            assert.equal((await response.arrayBuffer()).byteLength, 16);
            assert.equal((await fetch(item.url + '/sibling.mp4')).status, 404);
            const library = await handlers.get('library')({ refresh: true });
            const loose = library.items.find((entry) => entry.source === 'we-local');
            assert.equal((await fetch(`${library.base}/i/${loose.id}/r/ignored.txt`)).status, 404);
            await handlers.get('removeLocalFile')({ id: item.grantId.slice(6) });
            assert.equal((await handlers.get('customFiles')()).items.length, 71);
        } finally { dispose(); }
    });
});
