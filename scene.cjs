// scene.cjs — 读 Wallpaper Engine 的 scene.pkg。
//
// 容器格式（自己试出来的，官方无文档）：
//   int32 magicLen(=8) | "PKGV00xx" | int32 条目数
//   每条： int32 nameLen | name(utf8) | int32 相对偏移 | int32 长度
//   数据区基址 = 表尾，偏移是相对基址的
//
// 贴图（.tex）里常见直接内嵌整张 PNG / JPEG，所以不用写 DXT 解码器：
// 在字节范围里认 FFD8FF / 89504E47，核对宽高后按 EOI / IEND 切片即可。
//
// 场景还原：scene.json 的 objects 按绘制顺序排列，每层的
//   image(models/x.json) → material(materials/y.json) → passes[*].textures[0]
// 指向一张贴图。只合成着色器是 genericimage / genericimage2 的『纯贴图』层——
// 带特效的层（雨、光晕、粒子）跳过，否则会把未经处理的遮罩直接画上去。

'use strict';

const fs = require('fs');

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// 只认「纯贴图层」的着色器；其余交给特效，合成时跳过
const PLAIN_SHADERS = new Set(['genericimage', 'genericimage2', 'genericimage3', 'genericimage4']);

const isPlainShader = (shader) => {
    if (typeof shader !== 'string') {
        return false;
    }
    const name = shader.split('/').pop().toLowerCase();
    return PLAIN_SHADERS.has(name) || name.startsWith('genericimage');
};

const parsePackage = (buffer) => {
    try {
        let pos = 0;
        const magicLength = buffer.readInt32LE(pos);
        pos += 4;
        if (magicLength !== 8) {
            return null;
        }
        const magic = buffer.toString('latin1', pos, pos + magicLength);
        pos += magicLength;
        if (!magic.startsWith('PKGV')) {
            return null;
        }
        const count = buffer.readInt32LE(pos);
        pos += 4;
        if (count < 0 || count > 50000) {
            return null;
        }
        const entries = [];
        for (let index = 0; index < count; index += 1) {
            const nameLength = buffer.readInt32LE(pos);
            pos += 4;
            if (nameLength < 0 || nameLength > 1024 || pos + nameLength + 8 > buffer.length) {
                return null;
            }
            const name = buffer.toString('utf8', pos, pos + nameLength);
            pos += nameLength;
            const rel = buffer.readInt32LE(pos);
            pos += 4;
            const length = buffer.readInt32LE(pos);
            pos += 4;
            entries.push({ name, rel, length });
        }
        return { magic, entries, base: pos };
    } catch {
        return null;
    }
};

/*
 * 认位图头。DXT 压缩数据里偶尔也会撞出 FFD8FF，所以 JPEG 这一路要额外核一道：
 * SOI 后面紧跟的必须是 APPn / DQT / SOF / DHT / COM 这类正常起始段。
 */
const readImageHeader = (buffer, at) => {
    if (at < 0 || at + 32 > buffer.length) {
        return null;
    }
    if (buffer[at] === 0xff && buffer[at + 1] === 0xd8 && buffer[at + 2] === 0xff) {
        const first = buffer[at + 3];
        const plausibleHead = (first >= 0xe0 && first <= 0xef) || first === 0xdb || first === 0xc4
            || first === 0xdd || first === 0xfe || (first >= 0xc0 && first <= 0xcf);
        if (!plausibleHead) {
            return null;
        }
        let index = at + 2;
        const stop = Math.min(buffer.length - 8, at + 8192);
        while (index < stop) {
            if (buffer[index] !== 0xff) {
                index += 1;
                continue;
            }
            const marker = buffer[index + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                index += 2;
                continue;
            }
            const length = buffer.readUInt16BE(index + 2);
            const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrame) {
                const width = buffer.readUInt16BE(index + 7);
                const height = buffer.readUInt16BE(index + 5);
                if (width < 16 || height < 16) {
                    return null;
                }
                return {
                    mime: 'image/jpeg',
                    height,
                    width,
                    tail: Buffer.from([0xff, 0xd9]),
                    tailExtra: 2,
                };
            }
            index += 2 + length;
        }
        return null;
    }
    if (buffer.readUInt32BE(at) === 0x89504e47 && buffer.toString('latin1', at + 12, at + 16) === 'IHDR') {
        const width = buffer.readUInt32BE(at + 16);
        const height = buffer.readUInt32BE(at + 20);
        const bitDepth = buffer[at + 24];
        const colorType = buffer[at + 25];
        if (width < 16 || height < 16 || bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType)) {
            return null;
        }
        return {
            mime: 'image/png',
            width,
            height,
            tail: Buffer.from('IEND'),
            tailExtra: 8,
        };
    }
    return null;
};

/** 在 [start,end) 里找尺寸最大的内嵌位图（同一个 tex 里 mip / 缩略图会有好几张） */
const findEmbeddedImage = (buffer, start, end, { minPixels = 0, requireAspect = null, minBytesPerPixel = 0 } = {}) => {
    const limit = Math.min(end, buffer.length);
    let best = null;
    for (const signature of [JPEG_SOI, PNG_SIGNATURE]) {
        let at = buffer.indexOf(signature, start);
        while (at >= 0 && at < limit) {
            const info = readImageHeader(buffer, at);
            if (info && info.width * info.height >= minPixels) {
                const aspect = info.width / info.height;
                const aspectOk = !requireAspect || (aspect >= requireAspect[0] && aspect <= requireAspect[1]);
                const better = !best || info.width * info.height > best.width * best.height;
                if (aspectOk && better) {
                    const tailAt = buffer.indexOf(info.tail, at);
                    if (tailAt > 0 && tailAt < limit) {
                        const finish = tailAt + info.tailExtra;
                        const bytes = finish - at;
                        const density = bytes / (info.width * info.height);
                        // 像素密度兜底：撞出来的假头往往是几十字节的碎片
                        if (density >= minBytesPerPixel && density <= 4) {
                            best = { ...info, start: at, end: finish, bytes };
                        }
                    }
                }
            }
            at = buffer.indexOf(signature, at + 3);
        }
    }
    return best;
};

// "3840.00000 2160.00000" 这种只有两个分量，按需要补齐（尺寸补 0，缩放补 1）
const parseNumbers = (value, count, pad = 0) => {
    if (typeof value === 'number') {
        return Array.from({ length: count }, () => value);
    }
    if (typeof value !== 'string') {
        return null;
    }
    const parts = value.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
    if (parts.length === 0) {
        return null;
    }
    while (parts.length < count) {
        parts.push(pad);
    }
    return parts.slice(0, count);
};

/*
 * 从包里还原一份「可合成」的图层清单：
 *   frame    — 画幅（场景单位，含中心点与尺寸）
 *   layers   — 按绘制顺序，每层的贴图字节区间 + 在场景中的矩形 + 透明度
 * 只收能取到内嵌位图、且着色器是纯贴图的层。
 */
const buildScene = (buffer, { minPixels = 64 * 64 } = {}) => {
    const table = parsePackage(buffer);
    if (!table) {
        return null;
    }
    const entryOf = (name) => table.entries.find((entry) => entry.name === name);
    const jsonOf = (name) => {
        const entry = entryOf(name);
        if (!entry) {
            return null;
        }
        try {
            return JSON.parse(buffer.toString('utf8', table.base + entry.rel, table.base + entry.rel + entry.length));
        } catch {
            return null;
        }
    };

    const scene = jsonOf('scene.json');
    const objects = Array.isArray(scene?.objects) ? scene.objects : [];
    if (objects.length === 0) {
        return null;
    }

    const layers = [];
    objects.forEach((object, index) => {
        if (!object || object.visible === false || typeof object.image !== 'string' || !object.image.endsWith('.json')) {
            return;
        }
        const model = jsonOf(object.image);
        if (!model || typeof model.material !== 'string') {
            return;
        }
        const material = jsonOf(model.material);
        const passes = Array.isArray(material?.passes) ? material.passes : [];
        for (const pass of passes) {
            if (!isPlainShader(pass?.shader)) {
                continue;
            }
            const textures = Array.isArray(pass?.textures) ? pass.textures : [];
            for (const texture of textures) {
                if (typeof texture !== 'string' || texture.length === 0) {
                    continue;
                }
                const stem = texture.split('/').pop();
                const texEntry = table.entries.find((entry) => {
                    const name = entry.name.toLowerCase();
                    if (!name.endsWith('.tex')) {
                        return false;
                    }
                    const bare = entry.name.slice(0, -4);
                    return bare === texture || bare.endsWith(`/${stem}`);
                });
                if (!texEntry) {
                    continue;
                }
                const from = table.base + texEntry.rel;
                const found = findEmbeddedImage(buffer, from, from + texEntry.length, { minPixels, minBytesPerPixel: 0.01 });
                if (!found) {
                    continue;
                }
                const origin = parseNumbers(object.origin, 3) ?? [0, 0, 0];
                const size = parseNumbers(object.size, 3) ?? [found.width, found.height, 0];
                const scale = parseNumbers(object.scale, 3, 1) ?? [1, 1, 1];
                const alpha = typeof object.alpha === 'number' && Number.isFinite(object.alpha) ? object.alpha : 1;
                layers.push({
                    index,
                    name: typeof object.name === 'string' ? object.name : '',
                    texture: texEntry.name,
                    offset: found.start,
                    length: found.bytes,
                    mime: found.mime,
                    // 场景单位：中心点 + 乘过缩放的尺寸，y 轴向上
                    cx: origin[0],
                    cy: origin[1],
                    w: Math.abs(size[0] * scale[0]),
                    h: Math.abs(size[1] * scale[1]),
                    alpha: Math.max(0, Math.min(1, alpha)),
                });
                break;
            }
            break;
        }
    });

    if (layers.length === 0) {
        return null;
    }

    // 画幅：绘制顺序里的第一层就是底部整屏底图。只有它明显比别的层小很多时，
    // 才改用面积最大的那层（有些场景第一层只是个角标）。
    const largest = [...layers].sort((left, right) => right.w * right.h - left.w * left.h)[0];
    const first = layers[0];
    const frameLayer = first && first.w * first.h >= largest.w * largest.h * 0.5 ? first : largest;

    return {
        frame: { cx: frameLayer.cx, cy: frameLayer.cy, w: frameLayer.w, h: frameLayer.h },
        layers: layers.map(({ index, name, offset, length, mime, cx, cy, w, h, alpha }) => ({
            index, name, offset, length, mime, cx, cy, w, h, alpha,
        })),
    };
};

/** 单张原图：沿图层链取第一张合格的整屏底图，取不到就全包搜最大的 */
const buildSingleArt = (buffer, { minPixels = 800 * 450, requireAspect = [1.15, 2.6], minBytesPerPixel = 0.02 } = {}) => {
    const table = parsePackage(buffer);
    if (!table) {
        return null;
    }
    const score = (found) => found.bytes / (found.width * found.height) >= minBytesPerPixel;
    const entryOf = (name) => table.entries.find((entry) => entry.name === name);
    const jsonOf = (name) => {
        const entry = entryOf(name);
        if (!entry) {
            return null;
        }
        try {
            return JSON.parse(buffer.toString('utf8', table.base + entry.rel, table.base + entry.rel + entry.length));
        } catch {
            return null;
        }
    };

    const scene = jsonOf('scene.json');
    const objects = Array.isArray(scene?.objects) ? scene.objects : [];
    for (const object of objects) {
        if (!object || object.visible === false || typeof object.image !== 'string' || !object.image.endsWith('.json')) {
            continue;
        }
        const model = jsonOf(object.image);
        const material = typeof model?.material === 'string' ? jsonOf(model.material) : null;
        const passes = Array.isArray(material?.passes) ? material.passes : [];
        for (const pass of passes) {
            const textures = Array.isArray(pass?.textures) ? pass.textures : [];
            for (const texture of textures) {
                if (typeof texture !== 'string' || texture.length === 0) {
                    continue;
                }
                const stem = texture.split('/').pop();
                const texEntry = table.entries.find((entry) => {
                    const name = entry.name.toLowerCase();
                    if (!name.endsWith('.tex')) {
                        return false;
                    }
                    const bare = entry.name.slice(0, -4);
                    return bare === texture || bare.endsWith(`/${stem}`);
                });
                if (!texEntry) {
                    continue;
                }
                const from = table.base + texEntry.rel;
                const found = findEmbeddedImage(buffer, from, from + texEntry.length, { minPixels, requireAspect, minBytesPerPixel });
                if (found && score(found)) {
                    return { ...found, texture: texEntry.name, layer: object.name ?? object.image };
                }
            }
        }
    }

    let best = null;
    const texEntries = table.entries
        .filter((entry) => entry.name.toLowerCase().endsWith('.tex'))
        .sort((left, right) => right.length - left.length)
        .slice(0, 80);
    for (const entry of texEntries) {
        const from = table.base + entry.rel;
        const found = findEmbeddedImage(buffer, from, from + entry.length, { minPixels, requireAspect, minBytesPerPixel });
        if (found && score(found) && (!best || found.width * found.height > best.width * best.height)) {
            best = { ...found, texture: entry.name, layer: null };
        }
    }
    return best;
};

// ---------------------------------------------------------------------------
// 按需读取：主进程不能同步读大包，也不该为了取几张贴图把整个 scene.pkg 读进内存。
// 先读包头的目录表，再按条目只读需要的 JSON / 贴图区间；句柄用完即关。
// ---------------------------------------------------------------------------

const readAt = async (handle, length, position) => {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (bytesRead <= 0) {
            break;
        }
        offset += bytesRead;
    }
    if (offset === length) {
        return buffer;
    }
    return offset > 0 ? buffer.subarray(0, offset) : null;
};

/*
 * 目录表在文件开头，但表的大小没有单独字段。先读 256KB，解析失败就翻倍，
 * 直到能解析或读到文件尾；正常包第一轮就够。
 */
const readTable = async (handle, size) => {
    const maxWindow = Math.min(size, 16 * 1024 * 1024);
    let window = Math.min(size, 256 * 1024);
    while (window > 0) {
        const buffer = await readAt(handle, window, 0);
        if (!buffer) {
            return null;
        }
        const table = parsePackage(buffer);
        if (table) {
            return table;
        }
        if (window >= maxWindow) {
            return null;
        }
        window = Math.min(maxWindow, window * 4);
    }
    return null;
};

const openPackage = async (pkgPath, maxBytes = 256 * 1024 * 1024) => {
    try {
        const stat = await fs.promises.stat(pkgPath);
        if (!stat.isFile() || stat.size > maxBytes) {
            return null;
        }
        const handle = await fs.promises.open(pkgPath, 'r');
        const table = await readTable(handle, stat.size);
        if (!table) {
            await handle.close();
            return null;
        }
        return { handle, stat, table };
    } catch {
        return null;
    }
};

const closePackage = async (pkg) => {
    try {
        await pkg.handle.close();
    } catch {
        /* 已经关了 */
    }
};

const entryBytes = (handle, table, entry) => readAt(handle, entry.length, table.base + entry.rel);

const entryJson = async (handle, table, name) => {
    const entry = table.entries.find((item) => item.name === name);
    if (!entry) {
        return null;
    }
    try {
        const buffer = await entryBytes(handle, table, entry);
        return buffer ? JSON.parse(buffer.toString('utf8')) : null;
    } catch {
        return null;
    }
};

const textureEntryFor = (table, texture) => {
    const stem = texture.split('/').pop();
    return table.entries.find((entry) => {
        const name = entry.name.toLowerCase();
        if (!name.endsWith('.tex')) {
            return false;
        }
        const bare = entry.name.slice(0, -4);
        return bare === texture || bare.endsWith(`/${stem}`);
    });
};

const scanTexture = async (handle, table, entry, options) => {
    const buffer = await entryBytes(handle, table, entry);
    if (!buffer) {
        return null;
    }
    const found = findEmbeddedImage(buffer, 0, buffer.length, options);
    if (!found) {
        return null;
    }
    return { found, buffer, absolute: table.base + entry.rel + found.start };
};

/** 从文件还原图层清单，只读目录表、JSON 与候选贴图区间 */
const buildSceneFile = async (pkgPath, { minPixels = 64 * 64 } = {}) => {
    const pkg = await openPackage(pkgPath);
    if (!pkg) {
        return null;
    }
    const { handle, table } = pkg;
    try {
        const scene = await entryJson(handle, table, 'scene.json');
        const objects = Array.isArray(scene?.objects) ? scene.objects : [];
        if (objects.length === 0) {
            return null;
        }
        const layers = [];
        for (const [index, object] of objects.entries()) {
            if (!object || object.visible === false || typeof object.image !== 'string' || !object.image.endsWith('.json')) {
                continue;
            }
            const model = await entryJson(handle, table, object.image);
            if (!model || typeof model.material !== 'string') {
                continue;
            }
            const material = await entryJson(handle, table, model.material);
            const passes = Array.isArray(material?.passes) ? material.passes : [];
            let picked = null;
            for (const pass of passes) {
                if (!isPlainShader(pass?.shader)) {
                    continue;
                }
                const textures = Array.isArray(pass?.textures) ? pass.textures : [];
                for (const texture of textures) {
                    if (typeof texture !== 'string' || texture.length === 0) {
                        continue;
                    }
                    const texEntry = textureEntryFor(table, texture);
                    if (!texEntry) {
                        continue;
                    }
                    const scanned = await scanTexture(handle, table, texEntry, { minPixels, minBytesPerPixel: 0.01 });
                    if (!scanned) {
                        continue;
                    }
                    picked = { texEntry, ...scanned };
                    break;
                }
                if (picked) {
                    break;
                }
            }
            if (!picked) {
                continue;
            }
            const { found, absolute } = picked;
            const origin = parseNumbers(object.origin, 3) ?? [0, 0, 0];
            const size = parseNumbers(object.size, 3) ?? [found.width, found.height, 0];
            const scale = parseNumbers(object.scale, 3, 1) ?? [1, 1, 1];
            const alpha = typeof object.alpha === 'number' && Number.isFinite(object.alpha) ? object.alpha : 1;
            layers.push({
                index,
                name: typeof object.name === 'string' ? object.name : '',
                texture: picked.texEntry.name,
                offset: absolute,
                length: found.bytes,
                mime: found.mime,
                cx: origin[0],
                cy: origin[1],
                w: Math.abs(size[0] * scale[0]),
                h: Math.abs(size[1] * scale[1]),
                alpha: Math.max(0, Math.min(1, alpha)),
            });
        }
        if (layers.length === 0) {
            return null;
        }
        const largest = [...layers].sort((left, right) => right.w * right.h - left.w * left.h)[0];
        const first = layers[0];
        const frameLayer = first && first.w * first.h >= largest.w * largest.h * 0.5 ? first : largest;
        return {
            frame: { cx: frameLayer.cx, cy: frameLayer.cy, w: frameLayer.w, h: frameLayer.h },
            layers: layers.map(({ index, name, offset, length, mime, cx, cy, w, h, alpha }) => ({
                index, name, offset, length, mime, cx, cy, w, h, alpha,
            })),
        };
    } catch {
        return null;
    } finally {
        await closePackage(pkg);
    }
};

/** 从文件取单张原图；只需要那一张贴图的区间，不整包读 */
const buildSingleArtFile = async (pkgPath, {
    minPixels = 800 * 450,
    requireAspect = [1.15, 2.6],
    minBytesPerPixel = 0.02,
} = {}) => {
    const pkg = await openPackage(pkgPath);
    if (!pkg) {
        return null;
    }
    const { handle, table } = pkg;
    try {
        const scene = await entryJson(handle, table, 'scene.json');
        const objects = Array.isArray(scene?.objects) ? scene.objects : [];
        for (const object of objects) {
            if (!object || object.visible === false || typeof object.image !== 'string' || !object.image.endsWith('.json')) {
                continue;
            }
            const model = await entryJson(handle, table, object.image);
            const material = typeof model?.material === 'string' ? await entryJson(handle, table, model.material) : null;
            const passes = Array.isArray(material?.passes) ? material.passes : [];
            for (const pass of passes) {
                const textures = Array.isArray(pass?.textures) ? pass.textures : [];
                for (const texture of textures) {
                    if (typeof texture !== 'string' || texture.length === 0) {
                        continue;
                    }
                    const texEntry = textureEntryFor(table, texture);
                    if (!texEntry) {
                        continue;
                    }
                    const scanned = await scanTexture(handle, table, texEntry, { minPixels, requireAspect, minBytesPerPixel });
                    if (scanned && scanned.found.bytes / (scanned.found.width * scanned.found.height) >= minBytesPerPixel) {
                        const { found, buffer } = scanned;
                        return {
                            body: buffer.subarray(found.start, found.end),
                            mime: found.mime,
                            width: found.width,
                            height: found.height,
                            texture: texEntry.name,
                            layer: object.name ?? object.image,
                        };
                    }
                }
            }
        }

        let best = null;
        const texEntries = table.entries
            .filter((entry) => entry.name.toLowerCase().endsWith('.tex'))
            .sort((left, right) => right.length - left.length)
            .slice(0, 80);
        for (const entry of texEntries) {
            const scanned = await scanTexture(handle, table, entry, { minPixels, requireAspect, minBytesPerPixel });
            if (!scanned) {
                continue;
            }
            const { found } = scanned;
            if (found.bytes / (found.width * found.height) < minBytesPerPixel) {
                continue;
            }
            if (!best || found.width * found.height > best.found.width * best.found.height) {
                best = { ...scanned, entry };
            }
        }
        if (!best) {
            return null;
        }
        const { found, buffer, entry } = best;
        return {
            body: buffer.subarray(found.start, found.end),
            mime: found.mime,
            width: found.width,
            height: found.height,
            texture: entry.name,
            layer: null,
        };
    } catch {
        return null;
    } finally {
        await closePackage(pkg);
    }
};

module.exports = {
    parsePackage,
    findEmbeddedImage,
    buildScene,
    buildSingleArt,
    buildSceneFile,
    buildSingleArtFile,
    isPlainShader,
};
