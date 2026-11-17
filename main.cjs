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

const isFile = async (value) => {
    try {
        return (await fs.promises.stat(value)).isFile();
    } catch {
        return false;
    }
};

const isDir = async (value) => {
    try {
        return (await fs.promises.stat(value)).isDirectory();
    } catch {
        return false;
    }
};

// project.json 常带 BOM，且可能是 UTF-16 或带非法字节；读不动就算没有。
const readJson = async (file) => {
    try {
        let text = await fs.promises.readFile(file, 'utf8');
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        return JSON.parse(text);
    } catch {
        return null;
    }
};

// 只从 libraryfolders.vdf 里抠 "path" 行，不实现整套 VDF 解析。
const vdfLibraryPaths = async (file) => {
    const found = [];
    let text;
    try {
        text = await fs.promises.readFile(file, 'utf8');
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

/* 并发上限：壁纸多的时候别一次开几百个文件句柄 */
const mapLimit = async (items, limit, worker) => {
    const results = new Array(items.length);
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = index;
            index += 1;
            results[current] = await worker(items[current], current);
        }
    });
    await Promise.all(runners);
    return results;
};

/*
 * Steam 库根目录（含 steamapps 的目录）：
 * 常见安装位置 + 各盘符的 SteamLibrary + libraryfolders.vdf 里登记的路径，
 * 全部去重。只做 exists 检查，不递归、不遍历整个磁盘。
 */
const findSteamRoots = async () => {
    const candidates = [];
    const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files'];
    programFiles.filter(Boolean).forEach((base) => {
        candidates.push(path.join(base, 'Steam'));
        candidates.push(path.join(base, 'Steam', 'steamapps'));
    });
    const drives = [];
    for (let code = 67; code <= 90; code += 1) {
        drives.push(`${String.fromCharCode(code)}:\\`);
    }
    const present = await Promise.all(drives.map(async (drive) => ((await isDir(drive)) ? drive : null)));
    present.filter(Boolean).forEach((drive) => {
        candidates.push(path.join(drive, 'Steam'));
        candidates.push(path.join(drive, 'SteamLibrary'));
        candidates.push(path.join(drive, 'Program Files (x86)', 'Steam'));
        candidates.push(path.join(drive, 'Program Files', 'Steam'));
        candidates.push(path.join(drive, 'Games', 'Steam'));
        candidates.push(path.join(drive, 'SteamLibrary2'));
    });

    const roots = new Set();
    const addRoot = async (value) => {
        if (!value) {
            return;
        }
        const normalized = path.resolve(value);
        // 传进来的可能是 steamapps 本身
        const root = path.basename(normalized).toLowerCase() === 'steamapps' ? path.dirname(normalized) : normalized;
        if (await isDir(path.join(root, 'steamapps'))) {
            roots.add(root);
        }
    };

    await Promise.all(candidates.map(addRoot));
    // 第一轮拿到的根里可能登记了别的库
    const discovered = [];
    for (const root of Array.from(roots)) {
        discovered.push(...await vdfLibraryPaths(path.join(root, 'steamapps', 'libraryfolders.vdf')));
        discovered.push(...await vdfLibraryPaths(path.join(root, 'config', 'libraryfolders.vdf')));
    }
    await Promise.all(discovered.map(addRoot));
    return Array.from(roots);
};

const findWorkshopDirs = async (roots) => {
    const found = await Promise.all(roots.map(async (root) => {
        const dir = path.join(root, 'steamapps', 'workshop', 'content', WE_APP_ID);
        return (await isDir(dir)) ? dir : null;
    }));
    return found.filter(Boolean);
};

const findEngineDirs = async (roots) => {
    const found = await Promise.all(roots.map(async (root) => {
        const dir = path.join(root, 'steamapps', 'common', 'wallpaper_engine');
        return (await isDir(dir)) ? dir : null;
    }));
    return found.filter(Boolean);
};

/*
 * Wallpaper Engine 的 config.json 按 SteamID 分组。桌面「当前正在用的壁纸」
 * 存在 <steamid>.general.wallpaperconfig.selectedwallpapers.<Monitor>.file。
 * 拿不到就返回 null —— 这只是「跟随桌面壁纸」模式的便利，不是必需。
 */
const readCurrentDesktopWallpaper = async (engineDir) => {
    const config = await readJson(path.join(engineDir, 'config.json'));
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
/*
 * WE 壁纸用户属性（`project.json` 的 `general.properties`）→ 面板可用的描述列表。
 * 语义参照上游 we-props：order 按浮点读、combo 选项保留原始 JSON 类型、
 * condition 只影响面板显隐不下发过滤；`editable: false` 是作者标记的用户不可编辑，
 * 这里直接跳过（与 DSH 壁纸插件的裁剪版一致）。
 */
/* 属性文案里带 HTML 标签（<big>、<br> 等）是 WE 的常态，面板上要去掉 */
const stripHtml = (raw) => {
    if (typeof raw !== 'string' || raw === '') {
        return '';
    }
    return raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/[ \t]+\n/g, '\n')
        .trim();
};

const parseWeProps = (project) => {
    const props = project && project.general && project.general.properties;
    if (!props || typeof props !== 'object') {
        return [];
    }
    const out = [];
    for (const [name, def] of Object.entries(props)) {
        if (!def || typeof def !== 'object' || typeof def.type !== 'string') {
            continue;
        }
        if (def.editable === false) {
            continue;
        }
        const entry = {
            name,
            type: def.type,
            text: typeof def.text === 'string' && def.text.trim() !== '' ? stripHtml(def.text) : name,
            order: Number.isFinite(Number(def.order)) ? Number(def.order) : 0,
        };
        if ('value' in def) {
            entry.value = def.value;
        }
        if (Array.isArray(def.options)) {
            const options = def.options
                .filter((option) => option && typeof option === 'object' && 'value' in option)
                .map((option) => ({
                    label: typeof option.label === 'string' ? stripHtml(option.label) : String(option.value),
                    value: option.value,
                }));
            if (options.length) {
                entry.options = options;
            }
        }
        if (Number.isFinite(Number(def.min))) {
            entry.min = Number(def.min);
        }
        if (Number.isFinite(Number(def.max))) {
            entry.max = Number(def.max);
        }
        if (Number.isFinite(Number(def.step))) {
            entry.step = Number(def.step);
        }
        out.push(entry);
    }
    out.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
};

const readWallpaper = async (dir, source, idPrefix) => {
    const project = await readJson(path.join(dir, 'project.json'));
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
    const [hasFile, hasPreview] = await Promise.all([
        fileAbs ? isFile(fileAbs) : false,
        previewAbs ? isFile(previewAbs) : false,
    ]);

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
        // 场景壁纸的用户属性定义；video / web 基本没有，返回空数组
        properties: parseWeProps(project),
    };
};

const scanLibrary = async () => {
    const roots = await findSteamRoots();
    const workshopDirs = await findWorkshopDirs(roots);
    const engineDirs = await findEngineDirs(roots);
    const items = [];
    const seen = new Set();

    const addFrom = async (dir, source, idPrefix) => {
        let names;
        try {
            names = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const dirs = names
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => path.join(dir, entry.name));
        const found = await mapLimit(dirs, 8, async (full) => ({ full, item: await readWallpaper(full, source, '') }));
        found.forEach(({ full, item }) => {
            if (!item) {
                return;
            }
            // 同一个 workshop id 可能在多个库里重复，只留先找到的那个
            const key = item.workshopId ? `w:${item.workshopId}` : `d:${full.toLowerCase()}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            item.id = idPrefix + path.basename(full);
            item.dir = full;
            items.push(item);
        });
    };

    for (const dir of workshopDirs) {
        await addFrom(dir, 'workshop', 'w-');
    }
    for (const engineDir of engineDirs) {
        await addFrom(path.join(engineDir, 'projects', 'myprojects'), 'local', 'l-');
    }

    items.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));

    const engineDir = engineDirs[0] ?? null;
    const desktop = engineDir ? await readCurrentDesktopWallpaper(engineDir) : null;
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

const pkgKeyOf = async (item) => {
    const pkgPath = path.join(item.dir, 'scene.pkg');
    const stat = await fs.promises.stat(pkgPath);
    return { pkgPath, stat, key: `${item.id}:${stat.size}:${Math.round(stat.mtimeMs)}` };
};

/** 单张原图（背景那一层），用于「单张原画」模式和抽不到图层时的兜底 */
const sceneArtFor = async (item) => {
    if (!item || item.kind !== 'scene' || !item.dir) {
        return null;
    }
    let info;
    try {
        info = await pkgKeyOf(item);
    } catch {
        return null;
    }
    const cached = artCache.get(info.key);
    if (cached) {
        artCache.delete(info.key);
        artCache.set(info.key, cached);
        return cached;
    }
    let art = null;
    try {
        const found = await scenePkg.buildSingleArtFile(info.pkgPath);
        if (found) {
            art = {
                // 复制一份，别让缓存的原图拖着一整张贴图缓冲区
                body: Buffer.from(found.body),
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

// ---------------------------------------------------------------------------
// 壁纸取色：给「壁纸取色主题」用
// ---------------------------------------------------------------------------

/*
 * 用 Chromium 自带的解码器（nativeImage）取主色，而不是渲染端 canvas：
 * 播放页是 file:// 或 app://，壁纸却从临时 HTTP 端口来，canvas 画跨域图会被污染。
 * nativeImage 在主进程直接解 PNG/JPEG/WebP，缩到 40px 后统计颜色桶即可。
 */
let nativeImageRef = null;
const nativeImageOf = () => {
    if (nativeImageRef !== null) {
        return nativeImageRef;
    }
    try {
        const electron = require('electron');
        nativeImageRef = electron && electron.nativeImage ? electron.nativeImage : false;
    } catch {
        nativeImageRef = false;
    }
    return nativeImageRef;
};

const paletteCache = new Map();
const PALETTE_CACHE_ENTRIES = 300;

const paletteCachePut = (key, value) => {
    paletteCache.delete(key);
    paletteCache.set(key, value);
    while (paletteCache.size > PALETTE_CACHE_ENTRIES) {
        paletteCache.delete(paletteCache.keys().next().value);
    }
};

const rgbToHsl = ([r, g, b]) => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) {
        return [0, 0, Math.round(l * 100)];
    }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) {
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
    } else if (max === gn) {
        h = (bn - rn) / d + 2;
    } else {
        h = (rn - gn) / d + 4;
    }
    return [Math.round(h * 60) % 360 || 0, Math.round(s * 100), Math.round(l * 100)];
};

// 颜色桶统计：BGRA / RGB 两种字节序共用
const analyzeRgb = (bytes, bgro) => {
    const buckets = new Map();
    for (let index = 0; index + 2 < bytes.length; index += 3) {
        const r = bgro ? bytes[index + 2] : bytes[index];
        const g = bytes[index + 1];
        const b = bgro ? bytes[index] : bytes[index + 2];
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (lum < 0.035 || lum > 0.96) {
            continue;
        }
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
        entry.count += 1;
        entry.r += r;
        entry.g += g;
        entry.b += b;
        buckets.set(key, entry);
    }
    if (buckets.size === 0) {
        return null;
    }
    const entries = [...buckets.values()].sort((a, b) => b.count - a.count);
    const pick = (entry) => ({
        r: Math.round(entry.r / entry.count),
        g: Math.round(entry.g / entry.count),
        b: Math.round(entry.b / entry.count),
    });
    const samples = entries.slice(0, 6).map(pick);
    let primary = samples[0];
    let bestScore = -1;
    for (const color of samples) {
        const [, s, l] = rgbToHsl([color.r, color.g, color.b]);
        const score = s * 1.6 + (1 - Math.abs(l - 50) / 50) * 10;
        if (score > bestScore) {
            bestScore = score;
            primary = color;
        }
    }
    const secondary = samples.find((color) => color !== primary) ?? primary;
    return { primary, secondary };
};

// 取色主力：Electron nativeImage。取不到时返回 null，交给 ffmpeg 兜底。
const paletteViaNativeImage = (buffer) => {
    const nativeImage = nativeImageOf();
    if (!nativeImage || !buffer || buffer.length === 0) {
        return null;
    }
    let image;
    try {
        image = nativeImage.createFromBuffer(buffer);
    } catch {
        return null;
    }
    if (!image || image.isEmpty()) {
        return null;
    }
    let small;
    try {
        small = image.resize({ width: 40, height: 40, quality: 'good' });
    } catch {
        small = image;
    }
    let bitmap;
    try {
        bitmap = small.toBitmap();
    } catch {
        return null;
    }
    if (!bitmap || bitmap.length < 16) {
        return null;
    }
    const bgra = process.platform !== 'darwin';
    const palette = analyzeRgb(bitmap.subarray(0, bitmap.length - (bitmap.length % 4)), bgra);
    return palette;
};

const ffmpegCandidates = () => {
    const found = [];
    const env = process.env.FOLIA_FFMPEG_PATH;
    if (env && fs.existsSync(env)) {
        found.push(env);
    }
    const resources = process.resourcesPath;
    if (resources) {
        for (const name of ['ffmpeg', 'ffmpeg-8.1.2', 'ffmpeg-8.1.2-win64-static']) {
            const candidate = path.join(resources, name, 'ffmpeg.exe');
            try {
                if (fs.existsSync(candidate)) {
                    found.push(candidate);
                }
            } catch {
                /* 忽略 */
            }
        }
    }
    found.push('ffmpeg');
    return found;
};

// 兜底：让 ffmpeg 把图缩成 40x40 的 rgb24 原始帧，再走同一套颜色桶
const paletteViaFfmpeg = (filePath) => new Promise((resolve) => {
    const candidates = ffmpegCandidates();
    const need = 40 * 40 * 3;
    const tryNext = (index) => {
        if (index >= candidates.length) {
            resolve(null);
            return;
        }
        const args = [
            '-v', 'error',
            '-i', filePath,
            '-vf', 'scale=40:40',
            '-frames:v', '1',
            '-f', 'rawvideo',
            '-pix_fmt', 'rgb24',
            '-',
        ];
        execFile(candidates[index], args, { timeout: 10000, maxBuffer: need + 1024, windowsHide: true }, (error, stdout) => {
            if (error || !stdout || stdout.length < need) {
                tryNext(index + 1);
                return;
            }
            resolve(analyzeRgb(stdout.subarray(0, need), false));
        });
    };
    tryNext(0);
});

const paletteSourcePaths = (item) => {
    // 视频也收进来：ffmpeg 能直接抽帧，比「没有预览图就取不了色」稳
    const mediaExt = /\.(png|jpe?g|webp|bmp|gif|mp4|m4v|webm|mov|mkv)$/i;
    const paths = [];
    if (item.absFile && mediaExt.test(item.absFile)) {
        paths.push(item.absFile);
    }
    if (item.absPreview && mediaExt.test(item.absPreview)) {
        paths.push(item.absPreview);
    }
    return paths;
};

const paletteFor = async (item) => {
    const cached = paletteCache.get(item.id);
    if (cached) {
        return cached;
    }
    const paths = paletteSourcePaths(item);
    const imageExt = /\.(png|jpe?g|webp|bmp|gif)$/i;
    let palette = null;
    // 1) nativeImage 解码原图 → 预览图 → 场景原画（只喂图片，视频交给 ffmpeg）
    if (nativeImageOf()) {
        const sources = [];
        const imagePaths = paths.filter((filePath) => imageExt.test(filePath));
        if (imagePaths[0]) {
            sources.push({ path: imagePaths[0] });
        }
        if (item.kind === 'scene') {
            try {
                const art = await sceneArtFor(item);
                if (art && art.body) {
                    sources.push({ buffer: art.body });
                }
            } catch {
                /* 忽略 */
            }
        }
        if (imagePaths[1]) {
            sources.push({ path: imagePaths[1] });
        }
        for (const source of sources) {
            try {
                const buffer = source.buffer ?? await fs.promises.readFile(source.path);
                palette = paletteViaNativeImage(buffer);
            } catch {
                palette = null;
            }
            if (palette) {
                break;
            }
        }
    }
    // 2) ffmpeg 兜底（图片、视频都能抽一帧）
    if (!palette) {
        for (const filePath of paths) {
            palette = await paletteViaFfmpeg(filePath);
            if (palette) {
                break;
            }
        }
    }
    if (!palette) {
        return null;
    }
    const result = {
        ...palette,
        primaryHsl: rgbToHsl([palette.primary.r, palette.primary.g, palette.primary.b]),
        secondaryHsl: rgbToHsl([palette.secondary.r, palette.secondary.g, palette.secondary.b]),
    };
    paletteCachePut(item.id, result);
    return result;
};

/**
 * 图层清单：{ frame:{cx,cy,w,h}, layers:[{index,name,cx,cy,w,h,alpha,offset,length,mime}] }
 * 图片字节按需从包里读，清单本身只有几 KB。
 */
const sceneLayersFor = async (item) => {
    if (!item || item.kind !== 'scene' || !item.dir) {
        return null;
    }
    let info;
    try {
        info = await pkgKeyOf(item);
    } catch {
        return null;
    }
    const cached = manifestCache.get(info.key);
    if (cached) {
        manifestCache.delete(info.key);
        manifestCache.set(info.key, cached);
        return cached;
    }
    let manifest = null;
    try {
        const built = await scenePkg.buildSceneFile(info.pkgPath);
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
 * 现在只对 Origin: null（Folia 的 file:// 渲染进程）放行 —— 那正是需要读像素做取样的
 * 场景；正常网站和网页壁纸都带自己的 origin，拿不到。
 */
const corsHeaders = (request) => (
    request.headers.origin === 'null'
        ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' }
        : {}
);

const serveFile = async (request, response, filePath, { allowRange = true } = {}, tokenPrefix = '', documentHeaders = null) => {
    let stat;
    try {
        stat = await fs.promises.stat(filePath);
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
            html = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            response.writeHead(500, { 'Cache-Control': 'no-store' });
            response.end('Read failed');
            return;
        }
        const body = Buffer.from(injectShim(html, tokenPrefix), 'utf8');
        response.writeHead(200, {
            ...headers,
            ...(documentHeaders ?? {}),
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
 * 网页壁纸页面的 CSP：只允许它自己的 origin（也就是这个临时端口）与 data/blob。
 * 外网请求（CDN、在线 API）和别的本机端口都发不出去，即使壁纸脚本被换成恶意内容，
 * 也没法把页面里的数据带走或去扫本机服务。
 */
const WEB_CSP = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
].join('; ');

/*
 * 网页壁纸服务：每张网页壁纸一个独立的临时 origin（自己的端口 + 随机路径），
 * 只服务它自己的目录。
 *
 * 为什么不能去掉 allow-same-origin：Chromium 对 opaque origin 直接禁用
 * localStorage / sessionStorage / cookie / IndexedDB，Unity、React 这类壁纸会白屏。
 * 保留同源以后，隔离靠「不同端口 = 不同 origin」：它读不到主服务（端口不同、还要 token），
 * 也读不到别的壁纸（这个端口下只挂当前壁纸的目录）。
 */
const startWebServer = (item) => new Promise((resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex');
    const tokenPrefix = `/${token}`;
    const root = item.dir;
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
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

            if (url.pathname === '/we-shim.js') {
                response.writeHead(200, {
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Content-Length': String(shimBytes.length),
                    'Cache-Control': 'private, max-age=3600',
                });
                response.end(request.method === 'HEAD' ? undefined : shimBytes);
                return;
            }

            const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
            if (segments.length === 0
                || segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\\') || segment.includes('/') || path.isAbsolute(segment))) {
                response.writeHead(400, { 'Cache-Control': 'no-store' });
                response.end('Invalid path');
                return;
            }
            const target = path.resolve(root, ...segments);
            if (!target.startsWith(root + path.sep)) {
                response.writeHead(403, { 'Cache-Control': 'no-store' });
                response.end('Forbidden');
                return;
            }
            await serveFile(request, response, target, {}, tokenPrefix, { 'Content-Security-Policy': WEB_CSP });
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
        const origin = `http://127.0.0.1:${address.port}`;
        resolve({ server, token, origin, base: `${origin}/${token}`, dir: root });
    });
});

/*
 * 场景宿主页面：引擎和 SceneScript 都在这个 iframe 里跑，父页面（Folia）
 * 只通过 postMessage 给它送频谱、媒体信息、指针和暂停状态。这样脚本拿到的
 * window 是 iframe 自己的，碰不到宿主页面；CSP 又把它限制在自己的临时 origin 内。
 */
const SCENE_CSP = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
].join('; ');

const SCENE_HOST = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}canvas{display:block}</style></head>
<body>
<script src="engine.js"></script>
<script>
(function () {
    var post = function (type, extra) {
        try { parent.postMessage(Object.assign({ __foliaScene: 1, type: type }, extra || {}), '*'); } catch (e) {}
    };
    var params = new URLSearchParams(location.search);
    var left = new Float32Array(64);
    var right = new Float32Array(64);
    var ready = false;
    var mediaKey = '';
    var mediaPos = 0;
    var instance = null;
    function sendReady() {
        if (ready) return;
        ready = true;
        post('ready');
    }
    window.addEventListener('error', function (event) {
        // 场景脚本/字体偶发报错很常见，记日志但不当作致命失败
        post('diag', { level: 'warn', message: String(event.message || event) });
    });
    try {
        if (!window.WebWallGL) {
            post('error', { message: 'engine not loaded' });
            return;
        }
        var boot = function (props) {
            try {
                instance = WebWallGL.createScene(document.body, {
                    fit: params.get('fit') === 'contain' ? 'contain' : params.get('fit') === 'fill' ? 'stretch' : 'cover',
                    fps: Math.max(15, Math.min(60, Number(params.get('fps')) || 30)),
                    volume: 0,
                    autoplay: true,
                    scripts: true,
                    // 引擎的 __applyOptions 认的是 properties（scriptProperties 只是脚本侧全局名）
                    properties: props || {},
                    onDiagnostic: function (message, level) {
                        post('diag', { level: level, message: String(message) });
                        if (level !== 'error' && /renderer started|renderer:/i.test(String(message))) {
                            setTimeout(sendReady, 800);
                        }
                    },
                    onError: function (error) {
                        post('error', { message: String(error && error.message || error) });
                    }
                });
            } catch (error) {
                post('error', { message: 'create: ' + String(error && error.message || error) });
                return;
            }
            instance.setAudio({ snapshot: function () { return { left: left, right: right }; } });
            instance.load(WebWallGL.httpSource('pkg')).then(function () {
                sendReady();
                if (props && Object.keys(props).length) {
                    try {
                        instance.setProperties(props);
                    } catch (error) {
                        post('diag', { level: 'warn', message: 'props: ' + String(error && error.message || error) });
                    }
                }
            }, function (error) {
                post('error', { message: 'load: ' + String(error && error.message || error) });
            });
        };
        // 先取用户属性再建场景：没有 applyUserProperties 钩子的场景在初始化时也能吃到值
        fetch('props', { cache: 'no-store' }).then(function (response) {
            return response.ok ? response.json() : {};
        }).then(function (props) {
            boot(props && typeof props === 'object' ? props : {});
        }).catch(function (error) {
            post('diag', { level: 'warn', message: 'props fetch failed: ' + String(error && error.message || error) });
            boot({});
        });
    } catch (error) {
        post('error', { message: 'create: ' + String(error && error.message || error) });
        return;
    }
    addEventListener('message', function (event) {
        var data = event.data;
        if (!data || data.__foliaSceneIn !== 1) return;
        if (data.type === 'audio' && data.left && data.right) {
            left.set(data.left);
            right.set(data.right);
            return;
        }
        if (data.type === 'props' && data.props && instance) {
            // 运行中调属性：不重建 iframe，直接把新属性喂给引擎（重挂会黑一下）
            try {
                instance.setProperties(data.props);
            } catch (error) {
                post('diag', { level: 'warn', message: 'props: ' + String(error && error.message || error) });
            }
            return;
        }
        if (data.type === 'media') {
            var media = data.media || {};
            var key = [media.title || '', media.artist || '', media.album || '', media.state || 0, media.thumbnail || ''].join('|');
            var pos = Number(media.position) || 0;
            var applyMedia = function () {
                mediaKey = key;
                mediaPos = pos;
                try {
                    instance.setMedia(WebWallGL.createMediaSource({
                        hasMedia: Boolean(media.title),
                        playing: media.state === 1,
                        state: Number(media.state) || 0,
                        title: media.title || '',
                        artist: media.artist || '',
                        album: media.album || '',
                        position: pos,
                        duration: Number(media.duration) || 0,
                        thumbnail: media.thumbnail || '',
                        hasThumbnail: Boolean(media.thumbnail),
                    }));
                    // 场景直跑模式下引擎不会把媒体事件派给脚本；用它的公开调试入口补一次
                    if (typeof window.__mediaSet === 'function') {
                        window.__mediaSet({
                            hasMedia: Boolean(media.title),
                            state: Number(media.state) || 0,
                            title: media.title || '',
                            artist: media.artist || '',
                            album: media.album || '',
                            albumArtist: media.artist || '',
                            position: pos,
                            duration: Number(media.duration) || 0,
                            hasThumbnail: Boolean(media.thumbnail),
                            thumbnail: media.thumbnail || '',
                        });
                    }
                } catch (e) {}
            };
            if (data.force) {
                // 脚本初始化时可能已经吞掉了第一次媒体快照；先清空再送，
                // 让引擎按“空 → 有媒体”重新派发 mediaPropertiesChanged
                try {
                    instance.setMedia(WebWallGL.createMediaSource({
                        hasMedia: false, state: 0, title: '', artist: '', album: '',
                        position: 0, duration: 0, hasThumbnail: false,
                    }));
                    if (typeof window.__mediaSet === 'function') {
                        window.__mediaSet({ hasMedia: false, state: 0, title: '', artist: '', album: '', albumArtist: '', position: 0, duration: 0, hasThumbnail: false, thumbnail: '' });
                    }
                } catch (e) {}
                mediaKey = '';
                mediaPos = -999;
                setTimeout(applyMedia, 120);
                return;
            }
            if (key === mediaKey && Math.abs(pos - mediaPos) < 2) return;
            applyMedia();
            return;
        }
        if (data.type === 'pointer') {
            try { instance.pushPointer(data.x, data.y, data.buttons, data.mods); } catch (e) {}
            return;
        }
        if (data.type === 'pause') {
            try { instance.pause(); } catch (e) {}
            return;
        }
        if (data.type === 'resume') {
            try { instance.resume(); } catch (e) {}
        }
    });
    setInterval(function () {
        try {
            var canvas = instance.canvas || document.querySelector('canvas');
            if (!canvas || !canvas.width) return;
            var probe = document.createElement('canvas');
            probe.width = 32;
            probe.height = 18;
            var ctx = probe.getContext('2d');
            ctx.drawImage(canvas, 0, 0, 32, 18);
            var data = ctx.getImageData(0, 0, 32, 18).data;
            var sum = 0;
            for (var i = 0; i < data.length; i += 4) {
                sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
            }
            post('luminance', { value: sum / (data.length / 4) });
        } catch (e) {}
    }, 2500);
})();
</script>
</body></html>`;

/*
 * 场景宿主服务：每张场景一个临时 origin，只挂它自己的目录。
 * 页面、引擎和 scene.pkg 都从同一个 origin 取，脚本无法访问主服务和别的壁纸。
 */
const startSceneServer = (item) => new Promise((resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex');
    const tokenPrefix = `/${token}`;
    const root = item.dir;
    // 当前壁纸的用户属性值：渲染端每次 sceneFrame 时更新，host.html 自己来取
    let currentProps = {};
    const enginePath = path.join(__dirname, 'vendor', 'webwallgl.global.min.js');
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
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
            if (url.pathname === '/props') {
                const body = Buffer.from(JSON.stringify(currentProps ?? {}), 'utf8');
                response.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': String(body.length),
                    'Cache-Control': 'no-store',
                });
                response.end(request.method === 'HEAD' ? undefined : body);
                return;
            }
            if (url.pathname === '/host.html') {
                const body = Buffer.from(SCENE_HOST, 'utf8');
                response.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Length': String(body.length),
                    'Content-Security-Policy': SCENE_CSP,
                    'Cache-Control': 'no-store',
                });
                response.end(request.method === 'HEAD' ? undefined : body);
                return;
            }
            if (url.pathname === '/engine.js') {
                await serveFile(request, response, enginePath, {}, tokenPrefix);
                return;
            }
            if (url.pathname.startsWith('/pkg/')) {
                const segments = url.pathname.slice('/pkg/'.length).split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
                if (segments.length === 0
                    || segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\\') || segment.includes('/') || path.isAbsolute(segment))) {
                    response.writeHead(400, { 'Cache-Control': 'no-store' });
                    response.end('Invalid path');
                    return;
                }
                const target = path.resolve(root, ...segments);
                if (!target.startsWith(root + path.sep)) {
                    response.writeHead(403, { 'Cache-Control': 'no-store' });
                    response.end('Forbidden');
                    return;
                }
                await serveFile(request, response, target, {}, tokenPrefix);
                return;
            }
            response.writeHead(404, { 'Cache-Control': 'no-store' });
            response.end('Not found');
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
        const origin = `http://127.0.0.1:${address.port}`;
        resolve({
            server,
            token,
            origin,
            base: `${origin}/${token}`,
            dir: root,
            setProps: (value) => {
                currentProps = value && typeof value === 'object' ? value : {};
            },
        });
    });
});

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
    const server = http.createServer(async (request, response) => {
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
                const manifest = item ? await sceneLayersFor(item) : null;
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
                const manifest = item ? await sceneLayersFor(item) : null;
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
                const art = item ? await sceneArtFor(item) : null;
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
            await serveFile(request, response, target, {}, tokenPrefix);
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

    // 网页壁纸的临时服务，按壁纸 id 复用；渲染端卸载时 release 掉
    const webHosts = new Map();
    const webStarting = new Map();

    const closeWebHost = (id) => {
        const host = webHosts.get(id);
        if (!host) {
            return;
        }
        webHosts.delete(id);
        try {
            host.server.close();
        } catch {
            /* 已经关了 */
        }
    };
    const closeAllWebHosts = () => {
        [...webHosts.keys()].forEach(closeWebHost);
    };

    // 场景宿主（引擎 + SceneScript 跑在 iframe 里），按场景 id 复用
    const sceneHosts = new Map();
    const sceneStarting = new Map();

    const closeSceneHost = (id) => {
        const host = sceneHosts.get(id);
        if (!host) {
            return;
        }
        sceneHosts.delete(id);
        try {
            host.server.close();
        } catch {
            /* 已经关了 */
        }
    };
    const closeAllSceneHosts = () => {
        [...sceneHosts.keys()].forEach(closeSceneHost);
    };

    let scanInFlight = null;

    /*
     * 扫描全程走异步 IO，并且同一时间只扫一次：面板打开、壁纸挂载、网页壁纸
     * 请求临时地址都可能同时来，没必要各扫一遍。
     */
    const ensureLibrary = async (force) => {
        const fresh = !force && library && Date.now() - lastScannedAt < 60_000;
        if (fresh) {
            return library;
        }
        if (scanInFlight) {
            return scanInFlight;
        }
        scanInFlight = (async () => {
            try {
                const scanned = await scanLibrary();
                library = scanned;
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
            } finally {
                scanInFlight = null;
            }
            return library;
        })();
        return scanInFlight;
    };

    const payload = async (force) => {
        const current = await ensureLibrary(force);
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
                // WE 用户属性定义（场景壁纸才有）
                properties: item.properties,
            })),
        };
    };

    api.rpc.handle('library', (options) => payload(options && options.refresh === true));

    /*
     * 取某张壁纸的主色 / 辅色。渲染端拿到后自己换算成 CSS 变量注入。
     * 结果按 item.id 缓存在主进程，换回同一张壁纸不用重新解码。
     */
    api.rpc.handle('themePalette', async (options) => {
        const id = String(options?.id ?? '');
        if (!id) {
            return { ok: false, error: 'bad-id' };
        }
        const current = await ensureLibrary(false);
        const item = current.items.find((entry) => entry.id === id);
        if (!item) {
            return { ok: false, error: 'not-found' };
        }
        try {
            const palette = await paletteFor(item);
            if (!palette) {
                return { ok: false, error: 'no-image' };
            }
            return { ok: true, ...palette };
        } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
        }
    });

    /*
     * 主题写进 localStorage 后，Folia 运行中不会重新读；页面刷新还会被主题编辑器
     * 用旧值覆盖回去。唯一可靠的方式是重启进程，这里给渲染端一个「重启 Folia」。
     */
    api.rpc.handle('relaunchApp', () => {
        try {
            const { app } = require('electron');
            if (!app || typeof app.relaunch !== 'function') {
                return { ok: false, error: 'no-electron-app' };
            }
            setTimeout(() => {
                try {
                    app.relaunch();
                    app.exit(0);
                } catch {
                    /* 已经退出 */
                }
            }, 500);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
        }
    });

    /*
     * 给网页壁纸拿一个属于自己的临时 origin。渲染端只用返回的 url 当 iframe.src，
     * 卸载时调用 releaseWebFrame 关掉端口；同一张壁纸并发挂载会复用同一个服务。
     */
    api.rpc.handle('webFrame', async (options) => {
        const id = String(options?.id ?? '');
        if (!id) {
            return { ok: false, error: 'bad-id' };
        }
        const current = await ensureLibrary(false);
        const item = current.items.find((entry) => entry.id === id);
        if (!item || item.kind !== 'web' || item.live !== 'web' || !item.dir || !item.file) {
            return { ok: false, error: 'not-a-web-wallpaper' };
        }
        let host = webHosts.get(id);
        if (host && host.dir !== item.dir) {
            closeWebHost(id);
            host = null;
        }
        if (!host) {
            let pending = webStarting.get(id);
            if (!pending) {
                pending = startWebServer(item).then((started) => {
                    started.refs = 0;
                    webHosts.set(id, started);
                    webStarting.delete(id);
                    return started;
                }).catch((error) => {
                    webStarting.delete(id);
                    throw error;
                });
                webStarting.set(id, pending);
            }
            try {
                host = await pending;
            } catch (error) {
                return { ok: false, error: String(error?.message ?? error) };
            }
        }
        host.refs += 1;
        const relative = item.file.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/');
        return { ok: true, url: `${host.base}/${relative}`, origin: host.origin };
    });

    api.rpc.handle('releaseWebFrame', (options) => {
        const id = String(options?.id ?? '');
        const host = webHosts.get(id);
        if (!host) {
            return { ok: true };
        }
        host.refs = Math.max(0, (host.refs ?? 1) - 1);
        if (host.refs === 0) {
            closeWebHost(id);
        }
        return { ok: true };
    });

    /*
     * 场景宿主：渲染端拿到的 iframe 地址。引擎和 SceneScript 都在这个临时 origin
     * 里跑，父页面只负责把频谱/媒体/指针 post 进去。
     */
    api.rpc.handle('sceneFrame', async (options) => {
        const id = String(options?.id ?? '');
        if (!id) {
            return { ok: false, error: 'bad-id' };
        }
        const current = await ensureLibrary(false);
        const item = current.items.find((entry) => entry.id === id);
        if (!item || item.kind !== 'scene' || !item.dir) {
            return { ok: false, error: 'not-a-scene-wallpaper' };
        }
        let host = sceneHosts.get(id);
        if (host && host.dir !== item.dir) {
            closeSceneHost(id);
            host = null;
        }
        if (!host) {
            let pending = sceneStarting.get(id);
            if (!pending) {
                pending = startSceneServer(item).then((started) => {
                    started.refs = 0;
                    sceneHosts.set(id, started);
                    sceneStarting.delete(id);
                    return started;
                }).catch((error) => {
                    sceneStarting.delete(id);
                    throw error;
                });
                sceneStarting.set(id, pending);
            }
            try {
                host = await pending;
            } catch (error) {
                return { ok: false, error: String(error?.message ?? error) };
            }
        }
        host.refs += 1;
        if (typeof host.setProps === 'function') {
            host.setProps(options?.props && typeof options.props === 'object' ? options.props : {});
        }
        const query = new URLSearchParams({
            fit: String(options?.fit ?? 'cover'),
            fps: String(Math.max(15, Math.min(60, Number(options?.fps) || 30))),
        });
        return { ok: true, url: `${host.base}/host.html?${query.toString()}`, origin: host.origin };
    });

    api.rpc.handle('releaseSceneFrame', (options) => {
        const id = String(options?.id ?? '');
        const host = sceneHosts.get(id);
        if (!host) {
            return { ok: true };
        }
        host.refs = Math.max(0, (host.refs ?? 1) - 1);
        if (host.refs === 0) {
            closeSceneHost(id);
        }
        return { ok: true };
    });

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

    /*
     * 壁纸模式下背景在独立窗口渲染。属性面板保存后调用这里，由主进程广播给所有窗口，
     * 让每个窗口里的背景都重挂一次、带上新的属性值。
     */
    api.rpc.handle('propsChanged', () => {
        try {
            api.rpc.send('propsChanged', {});
        } catch (error) {
            void error;
        }
        return { ok: true };
    });

    startServer(() => library).then((started) => {
        server = started.server;
        base = started.base;
        api.log.info(`壁纸服务已启动 ${base}`);
        // 后台先建好库，面板打开时不必等（扫描是异步的，不挡 ready）
        ensureLibrary(false).catch(() => {});
        api.rpc.send('ready', { base });
    }).catch((error) => {
        api.log.error('壁纸服务启动失败', error);
    });

    api.onDispose(() => {
        closeAllWebHosts();
        closeAllSceneHosts();
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
        closeAllWebHosts();
        closeAllSceneHosts();
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
