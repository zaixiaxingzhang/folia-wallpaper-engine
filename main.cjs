// main.cjs — Node 端：扫描 Wallpaper Engine 壁纸库，并把壁纸文件以本地 HTTP 服务暴露给渲染端。
//
// 为什么需要 Node 端：
//   1. 渲染端（file:// 页面）不能任意读取磁盘，只有用户手动 pickFile 才拿到 grant；
//      壁纸库有上百个条目，逐个弹文件选择器不现实。
//   2. 于是由本进程读取 Steam / Wallpaper Engine 的目录，起一个只读、仅监听
//      127.0.0.1 的 HTTP 服务，支持 Range（<video> 需要它才能拖动/循环播放）、
//      正确的 MIME 与 CORS（canvas 取样算亮度要用）。
//
// 只读、只监听回环、只服务已登记壁纸目录内的文件，不执行任何来自壁纸的东西。

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');
const http = require('http');

// Wallpaper Engine 在 Steam 上的 AppID
const WE_APP_ID = '431960';

const MIME = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
};

const isFile = (value) => {
    try {
        return fs.statSync(value).isFile();
    } catch {
        return false;
    }
};

const isDir = (value) => {
    try {
        return fs.statSync(value).isDirectory();
    } catch {
        return false;
    }
};

// project.json 常带 BOM，且可能是 UTF-16 或带非法字节；读不动就算没有。
const readJson = (file) => {
    try {
        let text = fs.readFileSync(file, 'utf8');
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        return JSON.parse(text);
    } catch {
        return null;
    }
};

// 只从 libraryfolders.vdf 里抠 "path" 行，不实现整套 VDF 解析。
const vdfLibraryPaths = (file) => {
    const found = [];
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return found;
    }
    const pattern = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        found.push(match[1].replace(/\\\\/g, '\\'));
    }
    return found;
};

/*
 * Steam 库根目录（含 steamapps 的目录）：
 * 常见安装位置 + 各盘符的 SteamLibrary + libraryfolders.vdf 里登记的路径，
 * 全部去重。只做 exists 检查，不递归、不遍历整个磁盘。
 */
const findSteamRoots = () => {
    const candidates = [];
    const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files'];
    programFiles.filter(Boolean).forEach((base) => {
        candidates.push(path.join(base, 'Steam'));
        candidates.push(path.join(base, 'Steam', 'steamapps'));
    });
    for (let code = 67; code <= 90; code += 1) {
        const drive = `${String.fromCharCode(code)}:\\`;
        if (!isDir(drive)) {
            continue;
        }
        candidates.push(path.join(drive, 'Steam'));
        candidates.push(path.join(drive, 'SteamLibrary'));
        candidates.push(path.join(drive, 'Program Files (x86)', 'Steam'));
        candidates.push(path.join(drive, 'Program Files', 'Steam'));
        candidates.push(path.join(drive, 'Games', 'Steam'));
        candidates.push(path.join(drive, 'SteamLibrary2'));
    }

    const roots = new Set();
    const addRoot = (value) => {
        if (!value) {
            return;
        }
        const normalized = path.resolve(value);
        // 传进来的可能是 steamapps 本身
        const root = path.basename(normalized).toLowerCase() === 'steamapps' ? path.dirname(normalized) : normalized;
        if (isDir(path.join(root, 'steamapps'))) {
            roots.add(root);
        }
    };

    candidates.forEach(addRoot);
    // 第一轮拿到的根里可能登记了别的库
    Array.from(roots).forEach((root) => {
        vdfLibraryPaths(path.join(root, 'steamapps', 'libraryfolders.vdf')).forEach(addRoot);
        vdfLibraryPaths(path.join(root, 'config', 'libraryfolders.vdf')).forEach(addRoot);
    });
    return Array.from(roots);
};

const findWorkshopDirs = (roots) => {
    const dirs = [];
    roots.forEach((root) => {
        const dir = path.join(root, 'steamapps', 'workshop', 'content', WE_APP_ID);
        if (isDir(dir)) {
            dirs.push(dir);
        }
    });
    return dirs;
};

const findEngineDirs = (roots) => {
    const dirs = [];
    roots.forEach((root) => {
        const dir = path.join(root, 'steamapps', 'common', 'wallpaper_engine');
        if (isDir(dir)) {
            dirs.push(dir);
        }
    });
    return dirs;
};

/*
 * Wallpaper Engine 的 config.json 按 SteamID 分组。桌面「当前正在用的壁纸」
 * 存在 <steamid>.general.wallpaperconfig.selectedwallpapers.<Monitor>.file。
 * 拿不到就返回 null —— 这只是「跟随桌面壁纸」模式的便利，不是必需。
 */
const readCurrentDesktopWallpaper = (engineDir) => {
    const config = readJson(path.join(engineDir, 'config.json'));
    if (!config || typeof config !== 'object') {
        return null;
    }
    const accountKey = Object.keys(config).find((key) => /^\d+$/.test(key) && config[key] && typeof config[key] === 'object');
    const general = accountKey ? config[accountKey].general : null;
    const selected = general?.wallpaperconfig?.selectedwallpapers;
    if (!selected || typeof selected !== 'object') {
        return null;
    }
    const monitorKey = Object.keys(selected).find((key) => selected[key] && typeof selected[key].file === 'string');
    if (!monitorKey) {
        return null;
    }
    const file = selected[monitorKey].file;
    const dir = path.dirname(file);
    return {
        file,
        dir,
        // 创意工坊壁纸的目录名就是它的 workshop id
        workshopId: path.basename(dir),
    };
};

/*
 * 一个壁纸目录 → 一条库条目。
 * type 说明：video / web 能真正动起来；scene / application 只能拿预览图。
 * scene 壁纸的内容封在 scene.pkg 里，必须 Wallpaper Engine 自己的运行时
 * 才解得开，第三方无法还原 —— 那就老实显示预览图，并在面板里标注。
 */
const readWallpaper = (dir, source, idPrefix) => {
    const project = readJson(path.join(dir, 'project.json'));
    if (!project || typeof project !== 'object') {
        return null;
    }
    const kind = String(project.type || 'scene').trim().toLowerCase() || 'scene';
    const fileRel = typeof project.file === 'string' ? project.file : null;
    const previewRel = typeof project.preview === 'string' ? project.preview : null;
    const resolve = (rel) => {
        if (!rel) {
            return null;
        }
        const abs = path.resolve(dir, rel);
        // 壁纸包里的相对路径不能逃出目录
        return abs.startsWith(dir + path.sep) ? abs : null;
    };
    const fileAbs = resolve(fileRel);
    const previewAbs = resolve(previewRel);
    const hasFile = fileAbs ? isFile(fileAbs) : false;
    const hasPreview = previewAbs ? isFile(previewAbs) : false;

    let live = null;
    if (hasFile) {
        const ext = path.extname(fileAbs).toLowerCase();
        if (kind === 'video' && /^\.(mp4|m4v|webm|mov|mkv)$/.test(ext)) {
            live = 'video';
        } else if (kind === 'web' && (ext === '.html' || ext === '.htm')) {
            live = 'web';
        }
    }
    if (!previewRel && !hasPreview && !live) {
        return null;
    }

    const folder = path.basename(dir);
    const workshopId = /^\d+$/.test(folder) ? folder : null;
    return {
        id: `${idPrefix}${folder}`,
        title: typeof project.title === 'string' && project.title.trim() ? project.title.trim() : folder,
        kind,
        live,
        source,
        workshopId,
        file: hasFile ? fileRel : null,
        preview: hasPreview ? previewRel : null,
        absFile: hasFile ? fileAbs : null,
        absPreview: hasPreview ? previewAbs : null,
        tags: Array.isArray(project.tags) ? project.tags.filter((tag) => typeof tag === 'string').slice(0, 6) : [],
    };
};

const scanLibrary = () => {
    const roots = findSteamRoots();
    const workshopDirs = findWorkshopDirs(roots);
    const engineDirs = findEngineDirs(roots);
    const items = [];
    const seen = new Set();

    const addFrom = (dir, source, idPrefix) => {
        let names;
        try {
            names = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        names.forEach((entry) => {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                return;
            }
            const full = path.join(dir, entry.name);
            const item = readWallpaper(full, source, '');
            if (!item) {
                return;
            }
            // 同一个 workshop id 可能在多个库里重复，只留先找到的那个
            const key = item.workshopId ? `w:${item.workshopId}` : `d:${full.toLowerCase()}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            item.id = idPrefix + entry.name;
            item.dir = full;
            items.push(item);
        });
    };

    workshopDirs.forEach((dir) => addFrom(dir, 'workshop', 'w-'));
    engineDirs.forEach((engineDir) => {
        addFrom(path.join(engineDir, 'projects', 'myprojects'), 'local', 'l-');
    });

    items.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));

    const engineDir = engineDirs[0] ?? null;
    const desktop = engineDir ? readCurrentDesktopWallpaper(engineDir) : null;
    let currentId = null;
    if (desktop?.workshopId) {
        const match = items.find((item) => item.workshopId === desktop.workshopId);
        currentId = match ? match.id : null;
    }

    return {
        items,
        currentId,
        engineDir,
        workshopDirs,
        roots,
        desktopFile: desktop?.file ?? null,
    };
};

// ---------------------------------------------------------------------------
// 场景壁纸（scene.pkg）：还原成能合成的图层清单
//
// 场景壁纸在 Wallpaper Engine 里是「多层 2.5D 场景」——背景板 + 角色 + 前景，
// 每层只是一张带透明通道的贴图。这些贴图就躺在 scene.pkg 里（常见直接内嵌
// PNG/JPEG）。于是可以按 scene.json 的绘制顺序和每层的位置尺寸，在渲染端用
// canvas 把它们叠回一张完整画面，而不是只给用户一张几百像素的预览图。
//
// 详细格式见 scene.cjs。这里只负责：解析一次、缓存清单、按需把某一层的
// 字节流切出去（不把整包常驻内存）。
// ---------------------------------------------------------------------------

const scenePkg = require('./scene.cjs');

// 单张原图（只取背景那一层）的缓存
const artCache = new Map();
const ART_CACHE_ENTRIES = 3;
const ART_CACHE_BYTES = 14 * 1024 * 1024;

// 图层清单的缓存（只有几何信息，很便宜）
const manifestCache = new Map();
const MANIFEST_CACHE_ENTRIES = 8;

const pkgKeyOf = (item) => {
    const pkgPath = path.join(item.dir, 'scene.pkg');
    const stat = fs.statSync(pkgPath);
    return { pkgPath, stat, key: `${item.id}:${stat.size}:${Math.round(stat.mtimeMs)}` };
};

const readPkgBuffer = (pkgPath) => {
    const loaded = scenePkg.readPackage(pkgPath, 256 * 1024 * 1024);
    return loaded ? loaded.buffer : null;
};

/** 单张原图（背景那一层），用于「单张原画」模式和抽不到图层时的兜底 */
const sceneArtFor = (item) => {
    if (!item || item.kind !== 'scene' || !item.dir) {
        return null;
    }
    let info;
    try {
        info = pkgKeyOf(item);
    } catch {
        return null;
    }
    const cached = artCache.get(info.key);
    if (cached) {
        artCache.delete(info.key);
        artCache.set(info.key, cached);
        return cached;
    }
    const buffer = readPkgBuffer(info.pkgPath);
    if (!buffer) {
        return null;
    }
    let art = null;
    try {
        const found = scenePkg.buildSingleArt(buffer);
        if (found) {
            art = {
                body: buffer.subarray(found.start, found.end),
                mime: found.mime,
                width: found.width,
                height: found.height,
                layer: found.layer,
                texture: found.texture,
            };
        }
    } catch {
        art = null;
    }
    if (art && art.body.length <= ART_CACHE_BYTES) {
        artCache.set(info.key, art);
        while (artCache.size > ART_CACHE_ENTRIES) {
            artCache.delete(artCache.keys().next().value);
        }
    }
    return art;
};

/**
 * 图层清单：{ frame:{cx,cy,w,h}, layers:[{index,name,cx,cy,w,h,alpha,offset,length,mime}] }
 * 图片字节按需从包里读，清单本身只有几 KB。
 */
const sceneLayersFor = (item) => {
    if (!item || item.kind !== 'scene' || !item.dir) {
        return null;
    }
    let info;
    try {
        info = pkgKeyOf(item);
    } catch {
        return null;
    }
    const cached = manifestCache.get(info.key);
    if (cached) {
        manifestCache.delete(info.key);
        manifestCache.set(info.key, cached);
        return cached;
    }
    const buffer = readPkgBuffer(info.pkgPath);
    if (!buffer) {
        return null;
    }
    let manifest = null;
    try {
        const built = scenePkg.buildScene(buffer);
        if (built) {
            manifest = { ...built, pkgPath: info.pkgPath, key: info.key };
        }
    } catch {
        manifest = null;
    }
    if (manifest) {
        manifestCache.set(info.key, manifest);
        while (manifestCache.size > MANIFEST_CACHE_ENTRIES) {
            manifestCache.delete(manifestCache.keys().next().value);
        }
    }
    return manifest;
};

// ---------------------------------------------------------------------------
// 只读文件服务
// ---------------------------------------------------------------------------

/*
 * Wallpaper Engine 的网页 API 垫片。
 *
 * 网页壁纸（index.html 那类）靠 window.wallpaperRegisterAudioListener /
 * wallpaperRegisterMedia*Listener 拿音频与曲目。这些 API 只有 WE 本体提供，
 * 而我们的 iframe 是 http://127.0.0.1 的跨源页面，外部脚本注入不进去，
 * 所以由本服务直接把垫片注入到返回的 HTML 里；数据由渲染端用 postMessage 推过来。
 */
const WE_SHIM_SOURCE = `(function () {
    if (window.__foliaWeShim) { return; }
    window.__foliaWeShim = true;
    var audioCbs = [];
    var propsCbs = [];
    var playCbs = [];
    var timeCbs = [];
    var thumbCbs = [];
    var statusCbs = [];
    var last = { properties: null, playback: null, timeline: null, thumbnail: null, status: null };
    function fire(list, payload) {
        for (var i = 0; i < list.length; i += 1) {
            try { list[i](payload); } catch (e) { }
        }
    }
    function once(list, payload) {
        for (var i = 0; i < list.length; i += 1) {
            try { list[i](payload); } catch (e) { }
        }
    }
    /*
     * 壁纸自带的声音一律静音：有的网页壁纸带 BGM，选中后用户没法关掉。
     * 这里在壁纸自己的脚本执行前就把媒体元素钉死为静音，并且拦掉 play()。
     */
    try {
        var mproto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
        if (mproto) {
            var rawPlay = mproto.play;
            mproto.play = function () {
                try { this.muted = true; this.volume = 0; } catch (e) { }
                return rawPlay.apply(this, arguments);
            };
            var volumeDesc = Object.getOwnPropertyDescriptor(mproto, 'volume');
            if (volumeDesc && volumeDesc.set) {
                Object.defineProperty(mproto, 'volume', {
                    configurable: true,
                    get: volumeDesc.get,
                    set: function () { volumeDesc.set.call(this, 0); }
                });
            }
        }
        var silence = function () {
            var list = document.querySelectorAll ? document.querySelectorAll('audio,video') : [];
            for (var i = 0; i < list.length; i += 1) {
                try { list[i].muted = true; list[i].volume = 0; } catch (e) { }
            }
        };
        silence();
        if (document.documentElement && window.MutationObserver) {
            new window.MutationObserver(silence).observe(document.documentElement, { childList: true, subtree: true });
        }
        document.addEventListener('DOMContentLoaded', silence);
    } catch (e) { }

    window.wallpaperMediaIntegration = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };
    window.wallpaperRegisterAudioListener = function (fn) {
        if (typeof fn === 'function') { audioCbs.push(fn); }
    };
    window.wallpaperRegisterMediaPropertiesListener = function (fn) {
        if (typeof fn !== 'function') { return; }
        propsCbs.push(fn);
        if (last.properties) { once([fn], last.properties); }
    };
    window.wallpaperRegisterMediaPlaybackListener = function (fn) {
        if (typeof fn !== 'function') { return; }
        playCbs.push(fn);
        if (last.playback) { once([fn], last.playback); }
    };
    window.wallpaperRegisterMediaTimelineListener = function (fn) {
        if (typeof fn !== 'function') { return; }
        timeCbs.push(fn);
        if (last.timeline) { once([fn], last.timeline); }
    };
    window.wallpaperRegisterMediaThumbnailListener = function (fn) {
        if (typeof fn !== 'function') { return; }
        thumbCbs.push(fn);
        if (last.thumbnail) { once([fn], last.thumbnail); }
    };
    window.wallpaperRegisterMediaStatusListener = function (fn) {
        if (typeof fn !== 'function') { return; }
        statusCbs.push(fn);
        if (last.status) { once([fn], last.status); }
    };
    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || data.__foliaWe !== 1) { return; }
        if (data.kind === 'audio' && data.values) {
            fire(audioCbs, data.values);
            return;
        }
        if (data.kind === 'media' && data.media) {
            var m = data.media;
            last.properties = { title: m.title, artist: m.artist, albumTitle: m.album, albumArtist: m.albumArtist, subTitle: m.artist };
            last.playback = { state: m.state };
            last.timeline = { position: m.position, duration: m.duration };
            last.status = { state: m.state };
            if (m.thumbnail) { last.thumbnail = { thumbnail: m.thumbnail }; }
            fire(propsCbs, last.properties);
            fire(playCbs, last.playback);
            fire(timeCbs, last.timeline);
            fire(statusCbs, last.status);
            if (last.thumbnail) { fire(thumbCbs, last.thumbnail); }
        }
    });
    try { parent.postMessage({ __foliaWeReady: 1 }, '*'); } catch (e) { }
})();`;

const shimBytes = Buffer.from(WE_SHIM_SOURCE, 'utf8');

/* 把垫片塞到 <head> 最前面，保证壁纸自己的脚本执行时这些 API 已经就位 */
const injectShim = (html, prefix) => {
    const tag = `<script src="${prefix}/we-shim.js"></script>`;
    const headMatch = /<head[^>]*>/i.exec(html);
    if (headMatch) {
        const at = headMatch.index + headMatch[0].length;
        return html.slice(0, at) + tag + html.slice(at);
    }
    const htmlMatch = /<html[^>]*>/i.exec(html);
    if (htmlMatch) {
        const at = htmlMatch.index + htmlMatch[0].length;
        return html.slice(0, at) + tag + html.slice(at);
    }
    return tag + html;
};

/*
 * CORS：以前一律回 `*`，于是本机任何网页都能跨站读这个服务。
 * 现在只对 Origin: null（Folia 的 file:// 渲染进程、以及不带 allow-same-origin 的
 * 沙箱 iframe）放行 —— 那正是需要读像素做取样的场景；正常网站带自己的 origin，拿不到。
 */
const corsHeaders = (request) => (
    request.headers.origin === 'null'
        ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' }
        : {}
);

const serveFile = (request, response, filePath, { allowRange = true } = {}, tokenPrefix = '') => {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
    }
    if (!stat.isFile()) {
        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
    }

    const headers = {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        // canvas 取样（算歌词可读性）需要 CORS；只对 file:// 页面放行
        ...corsHeaders(request),
        'Cache-Control': 'private, max-age=300',
    };

    // HTML 需要改写（注入垫片），整份读出来发，不走 Range
    if (path.extname(filePath).toLowerCase() === '.html' || path.extname(filePath).toLowerCase() === '.htm') {
        let html = '';
        try {
            html = fs.readFileSync(filePath, 'utf8');
        } catch {
            response.writeHead(500, { 'Cache-Control': 'no-store' });
            response.end('Read failed');
            return;
        }
        const body = Buffer.from(injectShim(html, tokenPrefix), 'utf8');
        response.writeHead(200, {
            ...headers,
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': String(body.length),
        });
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
    }

    const range = allowRange ? /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '') : null;
    if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
        let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
        end = Math.min(end, stat.size - 1);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
            response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
            response.end();
            return;
        }
        start = Math.max(0, start);
        response.writeHead(206, {
            ...headers,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        });
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        fs.createReadStream(filePath, { start, end }).pipe(response);
        return;
    }

    response.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    fs.createReadStream(filePath).pipe(response);
};

/*
 * 启动 HTTP 服务。端口由系统分配（0），只监听 127.0.0.1，外部不可达。
 * 路由：
 *   GET /health                  存活探测
 *   GET /i/<id>/r/<相对路径>      壁纸目录内的文件（含视频，支持 Range）
 *   GET /i/<id>/art              scene.pkg 里抽出来的原图（没有则 404）
 * 任何路径都会被限制在登记过的壁纸目录内。
 */
const startServer = (getLibrary) => new Promise((resolve, reject) => {
    /*
     * 随机路径前缀。没有它，本机任何网页都能扫端口读壁纸列表和文件；
     * 有了它，只有拿到 base 的渲染端（也就是模组自己）知道地址。
     */
    const token = crypto.randomBytes(16).toString('hex');
    const tokenPrefix = `/${token}`;
    const server = http.createServer((request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            // 前缀不对一律 404，不泄露任何信息
            if (url.pathname !== tokenPrefix && !url.pathname.startsWith(`${tokenPrefix}/`)) {
                response.writeHead(404, { 'Cache-Control': 'no-store' });
                response.end();
                return;
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405, { 'Cache-Control': 'no-store' });
                response.end();
                return;
            }
            url.pathname = url.pathname.slice(tokenPrefix.length) || '/';
            if (url.pathname === '/health') {
                const library = getLibrary();
                response.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    ...corsHeaders(request),
                    'Cache-Control': 'no-store',
                });
                response.end(JSON.stringify({ ok: true, count: library?.items?.length ?? 0 }));
                return;
            }

            // WE 网页 API 垫片（被注入到网页壁纸的 HTML 里）
            if (url.pathname === '/we-shim.js') {
                response.writeHead(200, {
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Content-Length': String(shimBytes.length),
                    'Cache-Control': 'private, max-age=3600',
                });
                response.end(request.method === 'HEAD' ? undefined : shimBytes);
                return;
            }

            const segments = url.pathname.split('/').filter(Boolean);

            // 图层清单：渲染端据此用 canvas 叠回完整场景
            if (segments.length === 3 && segments[0] === 'i' && segments[2] === 'scene') {
                const itemId = decodeURIComponent(segments[1]);
                const library = getLibrary();
                const item = library?.items?.find((entry) => entry.id === itemId);
                const manifest = item ? sceneLayersFor(item) : null;
                const body = JSON.stringify({
                    ok: Boolean(manifest),
                    frame: manifest?.frame ?? null,
                    layers: (manifest?.layers ?? []).map((layer, index) => ({
                        index,
                        cx: layer.cx,
                        cy: layer.cy,
                        w: layer.w,
                        h: layer.h,
                        alpha: layer.alpha,
                        mime: layer.mime,
                    })),
                });
                response.writeHead(manifest ? 200 : 404, {
                    'Content-Type': 'application/json; charset=utf-8',
                    ...corsHeaders(request),
                    'Cache-Control': 'no-store',
                });
                response.end(body);
                return;
            }

            // 单个图层：只把这一张图片的字节切出去，整包不常驻内存
            if (segments.length === 4 && segments[0] === 'i' && segments[2] === 'layer') {
                const itemId = decodeURIComponent(segments[1]);
                const layerIndex = Number(segments[3]);
                const library = getLibrary();
                const item = library?.items?.find((entry) => entry.id === itemId);
                const manifest = item ? sceneLayersFor(item) : null;
                const layer = Number.isInteger(layerIndex) ? manifest?.layers?.[layerIndex] : null;
                if (!layer) {
                    response.writeHead(404, { 'Cache-Control': 'no-store' });
                    response.end('No layer');
                    return;
                }
                let stream;
                try {
                    stream = fs.createReadStream(manifest.pkgPath, { start: layer.offset, end: layer.offset + layer.length - 1 });
                } catch {
                    response.writeHead(500, { 'Cache-Control': 'no-store' });
                    response.end('Read failed');
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': layer.mime,
                    'Content-Length': String(layer.length),
                    ...corsHeaders(request),
                    'Cache-Control': 'private, max-age=3600',
                });
                if (request.method === 'HEAD') {
                    stream.destroy();
                    response.end();
                    return;
                }
                stream.on('error', () => {
                    try {
                        response.destroy();
                    } catch {
                        /* 连接已经断了 */
                    }
                });
                stream.pipe(response);
                return;
            }

            if (segments.length === 3 && segments[0] === 'i' && segments[2] === 'art') {
                const itemId = decodeURIComponent(segments[1]);
                const library = getLibrary();
                const item = library?.items?.find((entry) => entry.id === itemId);
                const art = item ? sceneArtFor(item) : null;
                if (!art) {
                    response.writeHead(404, { 'Cache-Control': 'no-store' });
                    response.end('No art');
                    return;
                }
                const headers = {
                    'Content-Type': art.mime,
                    'Content-Length': String(art.body.length),
                    ...corsHeaders(request),
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'private, max-age=3600',
                };
                const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
                if (range && (range[1] || range[2])) {
                    const start = range[1] ? Number(range[1]) : 0;
                    const end = range[2] ? Math.min(Number(range[2]), art.body.length - 1) : art.body.length - 1;
                    if (start > end || start >= art.body.length) {
                        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${art.body.length}` });
                        response.end();
                        return;
                    }
                    response.writeHead(206, {
                        ...headers,
                        'Content-Length': String(end - start + 1),
                        'Content-Range': `bytes ${start}-${end}/${art.body.length}`,
                    });
                    response.end(request.method === 'HEAD' ? undefined : art.body.subarray(start, end + 1));
                    return;
                }
                response.writeHead(200, headers);
                response.end(request.method === 'HEAD' ? undefined : art.body);
                return;
            }
            if (segments.length < 3 || segments[0] !== 'i' || segments[2] !== 'r') {
                response.writeHead(404, { 'Cache-Control': 'no-store' });
                response.end('Not found');
                return;
            }
            const itemId = decodeURIComponent(segments[1]);
            const library = getLibrary();
            const item = library?.items?.find((entry) => entry.id === itemId);
            if (!item || !item.dir) {
                response.writeHead(404, { 'Cache-Control': 'no-store' });
                response.end('Unknown wallpaper');
                return;
            }

            const relativeSegments = segments.slice(3).map((segment) => decodeURIComponent(segment));
            if (relativeSegments.length === 0
                || relativeSegments.some((segment) => segment === '..' || segment === '.' || segment.includes('\\') || segment.includes('/') || path.isAbsolute(segment))) {
                response.writeHead(400, { 'Cache-Control': 'no-store' });
                response.end('Invalid path');
                return;
            }
            const target = path.resolve(item.dir, ...relativeSegments);
            if (!target.startsWith(item.dir + path.sep)) {
                response.writeHead(403, { 'Cache-Control': 'no-store' });
                response.end('Forbidden');
                return;
            }
            serveFile(request, response, target, {}, tokenPrefix);
        } catch (error) {
            try {
                response.writeHead(500, { 'Cache-Control': 'no-store' });
                response.end(String(error && error.message));
            } catch {
                /* 连接已经断了 */
            }
        }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve({ server, port: address.port, token, base: `http://127.0.0.1:${address.port}/${token}` });
    });
});

// ---------------------------------------------------------------------------
// 模组入口
// ---------------------------------------------------------------------------

module.exports = function activate(api) {
    let library = null;
    let base = null;
    let server = null;
    let lastScannedAt = 0;

    const ensureLibrary = (force) => {
        const fresh = !force && library && Date.now() - lastScannedAt < 60_000;
        if (fresh) {
            return library;
        }
        try {
            library = scanLibrary();
            lastScannedAt = Date.now();
            api.log.info(`扫描到 ${library.items.length} 个壁纸`, {
                engineDir: library.engineDir,
                workshopDirs: library.workshopDirs,
            });
        } catch (error) {
            api.log.error('扫描壁纸库失败', error);
            library = {
                items: [],
                currentId: null,
                engineDir: null,
                workshopDirs: [],
                roots: [],
                desktopFile: null,
                error: String(error && error.message ? error.message : error),
            };
            lastScannedAt = Date.now();
        }
        return library;
    };

    const payload = (force) => {
        const current = ensureLibrary(force);
        return {
            ok: current.items.length > 0,
            base,
            error: current.error ?? null,
            currentId: current.currentId,
            engineDir: current.engineDir,
            workshopDirs: current.workshopDirs,
            desktopFile: current.desktopFile,
            scannedAt: lastScannedAt,
            items: current.items.map((item) => ({
                id: item.id,
                title: item.title,
                kind: item.kind,
                live: item.live,
                source: item.source,
                workshopId: item.workshopId,
                file: item.file,
                preview: item.preview,
                absFile: item.absFile,
                absPreview: item.absPreview,
                tags: item.tags,
            })),
        };
    };

    api.rpc.handle('library', (options) => payload(options && options.refresh === true));

    // 兜底：渲染端第一次拿到 base 之前先要知道端口
    /*
     * 用系统默认浏览器打开链接。
     * 渲染端 window.open 会在 Folia 自己的窗口里开标签页，那里没有浏览器登录态，
     * 用户得重新登录 GitHub；所以交给操作系统去开。
     * 只放行本模组自己生成的 GitHub issue 链接。
     */
    api.rpc.handle('openExternal', async (options) => {
        let parsed;
        try {
            parsed = new URL(String(options?.url ?? ''));
        } catch {
            return { ok: false, error: 'bad-url' };
        }
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
            return { ok: false, error: 'url-not-allowed' };
        }
        const target = parsed.href;
        return await new Promise((resolve) => {
            const done = (error) => resolve(error ? { ok: false, error: String(error.message ?? error) } : { ok: true });
            try {
                if (process.platform === 'win32') {
                    // rundll32 把 URL 当 argv 交给外壳，不经过 cmd，避免 & 被解释
                    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', target], { windowsHide: true }, done);
                } else if (process.platform === 'darwin') {
                    execFile('open', [target], done);
                } else {
                    execFile('xdg-open', [target], done);
                }
            } catch (error) {
                done(error);
            }
        });
    });

    api.rpc.handle('ping', () => ({ ok: true, base }));

    startServer(() => library).then((started) => {
        server = started.server;
        base = started.base;
        api.log.info(`壁纸服务已启动 ${base}`);
        // 先建好库，面板打开时不必等
        ensureLibrary(false);
        api.rpc.send('ready', { base });
    }).catch((error) => {
        api.log.error('壁纸服务启动失败', error);
    });

    api.onDispose(() => {
        if (server) {
            try {
                server.close();
            } catch {
                /* 已经关了 */
            }
            server = null;
        }
    });

    return () => {
        if (server) {
            try {
                server.close();
            } catch {
                /* 已经关了 */
            }
            server = null;
        }
    };
};
