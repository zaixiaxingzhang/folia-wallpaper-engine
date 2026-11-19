'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const LIMIT = 4096;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|apng|tiff?)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|ts|m2ts|3gp|ogv)$/i;
const mediaKind = (file) => VIDEO.test(file) ? 'video' : IMAGE.test(file) ? 'image' : null;
const pathKey = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

const registeredSteamRoots = async () => {
    if (process.platform !== 'win32') return [];
    const queries = [
        ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
        ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ];
    return (await Promise.all(queries.map(([key, value]) => new Promise((resolve) => {
        execFile('reg.exe', ['query', key, '/v', value], { windowsHide: true, timeout: 2000, maxBuffer: 65536 }, (error, stdout) => {
            const match = !error && /REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i.exec(stdout);
            resolve(match ? match[1].trim() : null);
        });
    })))).filter(Boolean);
};

// Read current local imports and active playlists; do not crawl account history.
const engineFiles = (config) => {
    const files = new Set();
    let desktopFile = null;
    const accounts = [config, ...Object.values(config || {})];
    for (const account of accounts) {
        const general = account && typeof account === 'object' ? account.general : null;
        if (!general || typeof general !== 'object') continue;
        for (const file of Array.isArray(general.localfiles) ? general.localfiles : []) {
            if (typeof file === 'string' && path.isAbsolute(file)) files.add(path.resolve(file));
        }
        for (const monitor of Object.values(general.wallpaperconfig?.selectedwallpapers || {})) {
            if (!monitor || typeof monitor !== 'object') continue;
            if (typeof monitor.file === 'string' && path.isAbsolute(monitor.file)) {
                desktopFile ||= path.resolve(monitor.file);
                files.add(path.resolve(monitor.file));
            }
            for (const file of Array.isArray(monitor.playlist?.items) ? monitor.playlist.items : []) {
                if (typeof file === 'string' && path.isAbsolute(file)) files.add(path.resolve(file));
            }
        }
    }
    return { files: [...files], desktopFile };
};

const mediaItem = async (file, source = 'we-local') => {
    const kind = mediaKind(file);
    if (!kind) return null;
    let resolved;
    try {
        resolved = await fs.promises.realpath(file);
        if (!(await fs.promises.stat(resolved)).isFile()) return null;
    } catch { return null; }
    return {
        id: `f-${crypto.createHash('sha256').update(pathKey(resolved)).digest('hex').slice(0, 24)}`,
        title: path.basename(resolved, path.extname(resolved)), kind,
        live: kind === 'video' ? 'video' : null, source, workshopId: null,
        file: path.basename(resolved), preview: kind === 'image' ? path.basename(resolved) : null,
        absFile: resolved, absPreview: kind === 'image' ? resolved : null,
        dir: path.dirname(resolved), tags: [], singleFile: true,
    };
};

const collectFolder = async (folder) => {
    const pending = [{ dir: folder, depth: 0 }];
    const files = [];
    let visited = 0;
    while (pending.length && files.length < LIMIT && visited < LIMIT) {
        const { dir, depth } = pending.shift();
        visited += 1;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const file = path.join(dir, entry.name);
            if (entry.isFile() && mediaKind(file)) files.push(file);
            else if (entry.isDirectory() && depth < 16) pending.push({ dir: file, depth: depth + 1 });
            if (files.length >= LIMIT) break;
        }
    }
    return { files, truncated: pending.length > 0 || files.length >= LIMIT };
};

const createLocalFiles = (api) => {
    let rows = null;
    let loading = null;
    let busy = false;
    const load = async () => {
        if (rows) return rows;
        loading ||= api.storage.get('batch-files-v1').then((value) => {
            rows = Array.isArray(value) ? value.filter((entry) => entry && typeof entry.path === 'string'
                && path.isAbsolute(entry.path) && mediaKind(entry.path)).slice(0, LIMIT) : [];
            return rows;
        }).finally(() => { loading = null; });
        return loading;
    };
    const items = async () => (await Promise.all((await load()).map((row) => mediaItem(row.path, 'custom')))).filter(Boolean);
    const remember = async (files) => {
        await load();
        const known = new Set(rows.map((row) => pathKey(row.path)));
        let added = 0, duplicates = 0, skipped = 0;
        let firstId = null;
        const next = [...rows];
        for (const file of files) {
            const item = await mediaItem(file, 'custom');
            if (!item) { skipped += 1; continue; }
            const key = pathKey(item.absFile);
            firstId ||= `local:${item.id}`;
            if (known.has(key)) { duplicates += 1; continue; }
            if (next.length >= LIMIT) { skipped += 1; continue; }
            known.add(key);
            next.push({ path: item.absFile });
            added += 1;
        }
        // Persist before updating the cache so failed writes leave prior selections intact.
        if (added) {
            await api.storage.set('batch-files-v1', next);
            rows = next;
        }
        return { added, duplicates, skipped, total: next.length, firstId };
    };
    const pick = async (options = {}) => {
        if (busy) throw new Error('已有文件选择窗口打开');
        busy = true;
        try {
            const { dialog, BrowserWindow } = require('electron');
            const folder = options.folder === true;
            const kind = options.kind;
            const imageExt = ['png','jpg','jpeg','gif','webp','avif','bmp','svg','ico','apng','tif','tiff'];
            const videoExt = ['mp4','m4v','webm','mov','mkv','avi','wmv','flv','ts','m2ts','3gp','ogv'];
            const spec = {
                title: folder ? '选择壁纸文件夹（包含子文件夹）' : '批量选择壁纸（可用 Ctrl+A / Ctrl / Shift 多选）',
                properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
                ...(folder ? {} : { filters: [{ name: '图片与视频', extensions: kind === 'image' ? imageExt : kind === 'video' ? videoExt : [...imageExt, ...videoExt] }] }),
            };
            const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.isVisible());
            const chosen = parent ? await dialog.showOpenDialog(parent, spec) : await dialog.showOpenDialog(spec);
            if (chosen.canceled || !chosen.filePaths?.length) return { canceled: true };
            const batch = folder ? await collectFolder(chosen.filePaths[0]) : { files: chosen.filePaths, truncated: false };
            return { ...await remember(batch.files), truncated: batch.truncated };
        } finally { busy = false; }
    };
    const remove = async (id) => {
        const current = await items();
        const item = current.find((entry) => entry.id === id);
        if (!item) return;
        const next = (await load()).filter((row) => pathKey(row.path) !== pathKey(item.absFile));
        await api.storage.set('batch-files-v1', next);
        rows = next;
    };
    return { items, remember, pick, remove };
};

module.exports = { LIMIT, mediaKind, pathKey, registeredSteamRoots, engineFiles, mediaItem, collectFolder, createLocalFiles };
