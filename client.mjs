// client.mjs — 渲染端：注册一个「壁纸引擎」背景类型。
//
// 它做三件事：
//   1. 把 Wallpaper Engine 的壁纸画在播放页背景层上（视频壁纸真的在放，
//      网页壁纸用 iframe 跑，场景壁纸用官方预览图）；
//   2. 给歌词做可读性避让：实时测背景在歌词那一条带上的亮度，按主题歌词色
//      反解出需要的叠色透明度，保证对比度达到设定值；
//   3. 在背景类型自带的「更多设置」里给出一套面板：选哪一张、伪随机、以及
//      全部显示参数。

export default function activate(folium) {
    const t = (zh, en) => ({ 'zh-CN': zh, en });

    // 壁纸选择状态跨 mount / 设置面板共享，改完立刻互相通知，不轮询。
    // 背景挂载与设置面板各用一组订阅：场景失败时只让面板刷新，
    // 否则通知背景重渲染 → 再次失败 → 死循环。
    const listeners = new Set();
    const panelListeners = new Set();
    const notifyPanel = () => panelListeners.forEach((listener) => {
        try {
            listener();
        } catch (error) {
            console.warn('[壁纸引擎] 面板订阅者出错', error);
        }
    });
    const notify = () => {
        listeners.forEach((listener) => {
            try {
                listener();
            } catch (error) {
                console.warn('[壁纸引擎] 订阅者出错', error);
            }
        });
        notifyPanel();
    };

    let libraryCache = null;
    let libraryPromise = null;

    /*
     * WebWallGL：MIT 许可的 Wallpaper Engine 场景渲染器（vendor/webwallgl.global.min.js，
     * 随模组一起分发）。场景的着色器、粒子、视差、SceneScript 都由它跑，
     * 场景壁纸因此能像在 Wallpaper Engine 里一样动起来。
     *
     * 用 UMD 构建而不是 .mjs：ESM 版对 mediabunny 有裸导入，需要打包器解析；
     * UMD 版自带全部依赖，挂到 window.WebWallGL 上，用 script 标签加载即可。
     * 脚本地址由本模块的 URL 推出来，不硬编码协议与主机。
     */
    let enginePromise = null;
    const loadEngine = () => {
        if (typeof window !== 'undefined' && window.WebWallGL) {
            return Promise.resolve(window.WebWallGL);
        }
        if (enginePromise) {
            return enginePromise;
        }
        enginePromise = new Promise((resolve, reject) => {
            if (typeof document === 'undefined' || !document.head) {
                reject(new Error('no document'));
                return;
            }
            const script = document.createElement('script');
            try {
                script.src = new URL('./vendor/webwallgl.global.min.js', import.meta.url).href;
            } catch (error) {
                reject(error);
                return;
            }
            script.addEventListener('load', () => {
                if (window.WebWallGL) {
                    resolve(window.WebWallGL);
                } else {
                    reject(new Error('WebWallGL 未挂载到 window'));
                }
            }, { once: true });
            script.addEventListener('error', () => reject(new Error('引擎脚本加载失败')), { once: true });
            document.head.append(script);
        }).catch((error) => {
            enginePromise = null;
            throw error;
        });
        return enginePromise;
    };

    const loadLibrary = (refresh) => {
        if (!refresh && libraryCache) {
            return Promise.resolve(libraryCache);
        }
        if (libraryPromise) {
            return libraryPromise;
        }
        libraryPromise = (async () => {
            try {
                const payload = await folium.rpc.call('library', { refresh: refresh === true });
                libraryCache = payload;
            } catch (error) {
                libraryCache = {
                    ok: false,
                    items: [],
                    error: String(error && error.message ? error.message : error),
                };
            }
            return libraryCache;
        })().finally(() => {
            libraryPromise = null;
        });
        return libraryPromise;
    };

    // -----------------------------------------------------------------------
    // 自定义背景（用户自己的图片 / 视频）
    //
    // 渲染端读不到任意磁盘路径，所以走宿主的选文件通道：
    //   folium.ui.pickFile({ accept: 'image' | 'video', persist: true })
    // 返回一个 folia-mod://_files/<token>/<name> 的会话 URL（支持 Range，
    // <video> 能拖能循环），并给出可跨重启恢复的 grantId。
    // 这里只存 grantId + 文件名 + 类型，每次挂载时用 restoreFile 换回新 URL；
    // 文件被移动或删除时 restore 返回 null，条目自动剪掉。
    // -----------------------------------------------------------------------

    const CUSTOM_KEY = 'custom';
    const CUSTOM_LIMIT = 32;   // 与宿主的 grant 上限一致，超出会顶掉最旧的
    // 最近一次场景壁纸加载失败的报告：背景里的错误卡与设置面板共用
    let lastErrorReport = null;

    const REPO_ISSUES_URL = 'https://github.com/zaixiaxingzhang/folia-wallpaper-engine/issues/new';

    const formatErrorLog = (report) => {
        if (!report) {
            return '（没有错误记录）';
        }
        const lines = [
            '壁纸引擎背景 · 场景壁纸加载失败',
            `时间: ${report.at}`,
            `壁纸: ${report.title}`,
            `壁纸 id: ${report.id}`,
            `Folia: ${report.folia}`,
            `Folium: ${report.folium}`,
            `WebGL: ${report.webgl}`,
            `平台: ${report.ua}`,
            `相关设置: ${report.settings}`,
            '',
            '--- 阶段结果 ---',
            ...(report.attempts?.length > 0 ? report.attempts : ['（没有记录）']),
            '',
            '--- 各阶段诊断 ---',
            ...(report.diag.length > 0
                ? report.diag.map((entry) => `[${entry.at}] ${entry.stage} (${entry.level}) ${entry.message}`)
                : ['（没有捕获到具体错误）']),
        ];
        return lines.join('\n');
    };

    const downloadErrorLog = (report) => {
        try {
            const text = formatErrorLog(report);
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `壁纸引擎-错误日志-${Date.now()}.txt`;
            document.body?.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            return true;
        } catch (error) {
            console.warn('[壁纸引擎] 导出日志失败', error);
            return false;
        }
    };

    const openIssuePage = (report) => {
        const title = `[Bug] 场景壁纸加载失败：${report?.title ?? '(未知壁纸)'}`;
        const body = [
            '### 现象',
            '场景壁纸在 Folia 里加载失败（实时渲染、合成静态图、单张原画都失败）。',
            '',
            '### 环境',
            `- Folia: ${report?.folia ?? '?'}`,
            `- Folium: ${report?.folium ?? '?'}`,
            `- WebGL: ${report?.webgl ?? '?'}`,
            '',
            '### 壁纸',
            `${report?.title ?? '?'}（id: \`${report?.id ?? '?'}\`）`,
            '',
            '### 诊断',
            '```',
            ...(report?.diag?.length ? report.diag.slice(-20).map((entry) => `${entry.stage}: ${entry.message}`) : ['（无）']),
            '```',
            '',
            '> 完整日志由模组里的「导出错误日志」生成，请把文件拖进来。',
        ].join('\n');
        const url = `${REPO_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
        // 交给系统浏览器：window.open 会在 Folia 内开标签页，没有浏览器登录态
        try {
            const pending = folium.rpc?.call?.('openExternal', { url });
            if (pending && typeof pending.then === 'function') {
                pending.then((result) => {
                    if (result && result.ok === false) {
                        console.warn('[壁纸引擎] 系统浏览器打开失败', result.error);
                    }
                }).catch((error) => console.warn('[壁纸引擎] 系统浏览器打开失败', error));
                return true;
            }
        } catch (error) {
            console.warn('[壁纸引擎] 系统浏览器打开失败', error);
        }
        return false;
    };

    let customCache = null;    // [{ grantId, name, kind, url }]
    let customPromise = null;

    const isCustomEntry = (value) => (
        value
        && typeof value === 'object'
        && typeof value.grantId === 'string'
        && (value.kind === 'image' || value.kind === 'video')
    );

    const readCustomEntries = async () => {
        try {
            const value = await folium.storage.get(CUSTOM_KEY);
            return Array.isArray(value) ? value.filter(isCustomEntry) : [];
        } catch {
            return [];
        }
    };

    const writeCustomEntries = async (entries) => {
        const trimmed = entries.slice(-CUSTOM_LIMIT);
        try {
            await folium.storage.set(CUSTOM_KEY, trimmed);
        } catch (error) {
            console.warn('[壁纸引擎] 保存自定义背景失败', error);
        }
        customCache = null;
        notify();
        return trimmed;
    };

    /*
     * 把存下来的 grantId 换成这次运行的 URL。恢复失败的（文件没了 / 授权被清）
     * 会从记录里剔掉，并在返回值里标记 removed，面板据此提示一次。
     */
    const resolveCustom = async (force) => {
        if (!force && customCache) {
            return customCache;
        }
        if (!force && customPromise) {
            return customPromise;
        }
        customPromise = (async () => {
            const entries = await readCustomEntries();
            const resolved = [];
            const missing = [];
            for (const entry of entries) {
                let handle = null;
                try {
                    handle = await folium.ui.restoreFile(entry.grantId);
                } catch {
                    handle = null;
                }
                if (handle && handle.url) {
                    resolved.push({ ...entry, url: handle.url, name: handle.name || entry.name });
                } else {
                    missing.push(entry);
                }
            }
            if (missing.length > 0) {
                await writeCustomEntries(entries.filter((entry) => !missing.includes(entry)));
            }
            customCache = resolved;
            return resolved;
        })().finally(() => {
            customPromise = null;
        });
        return customPromise;
    };

    const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|ts|m2ts|3gp|ogv)$/i;
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|apng|tiff?)$/i;

    /*
     * 「其他格式」走的是不过滤的文件对话框（accept: 'any'），所以类型得自己按扩展名判断。
     * 判不出来的直接拒绝——存进列表也只会得到一块黑。
     */
    const classifyFile = (name) => (VIDEO_EXT.test(name) ? 'video' : IMAGE_EXT.test(name) ? 'image' : null);

    const addCustomFile = async (kind) => {
        const handle = await folium.ui.pickFile({ accept: kind, persist: true });
        if (!handle || !handle.url || !handle.grantId) {
            return null;
        }
        const resolvedKind = kind === 'any' ? classifyFile(handle.name ?? '') : kind;
        if (!resolvedKind) {
            try {
                await folium.ui.releaseFile(handle.grantId);
            } catch {
                /* 授权已经不在，忽略 */
            }
            throw new Error(`认不出这个文件类型：${handle.name ?? ''}`);
        }
        const entries = await readCustomEntries();
        await writeCustomEntries([...entries, { grantId: handle.grantId, name: handle.name, kind: resolvedKind }]);
        return { ...handle, kind: resolvedKind };
    };

    const removeCustomFile = async (grantId) => {
        const entries = await readCustomEntries();
        await writeCustomEntries(entries.filter((entry) => entry.grantId !== grantId));
        try {
            await folium.ui.releaseFile(grantId);
        } catch {
            /* 授权已经不在，忽略 */
        }
    };

    const readState = async () => {
        try {
            const value = await folium.storage.get('selection');
            return value && typeof value === 'object' ? value : {};
        } catch {
            return {};
        }
    };

    const writeState = async (patch) => {
        try {
            const current = await readState();
            await folium.storage.set('selection', { ...current, ...patch });
        } catch (error) {
            console.warn('[壁纸引擎] 保存壁纸选择失败', error);
        }
        notify();
    };

    const SETTINGS = [
        {
            key: 'library', type: 'select', defaultValue: 'we',
            label: t('取图来源', 'Source'),
            description: t('「壁纸引擎库」用 Wallpaper Engine 的壁纸；「我的文件」用你自己添加的图片或视频', '“Wallpaper Engine” uses your Wallpaper Engine library; “My files” uses images or videos you added yourself'),
            options: [
                { value: 'we', label: t('壁纸引擎库', 'Wallpaper Engine') },
                { value: 'custom', label: t('我的图片与视频', 'My own files') },
            ],
        },
        {
            key: 'mode', type: 'select', defaultValue: 'random',
            label: t('壁纸来源', 'Wallpaper source'),
            description: t('伪随机会按种子和切歌计算，同一首歌每次都是同一张', 'Pseudo-random derives from the seed and the song, so a song always gets the same wallpaper'),
            options: [
                { value: 'random', label: t('伪随机', 'Pseudo-random') },
                { value: 'fixed', label: t('指定壁纸', 'Fixed wallpaper') },
                { value: 'desktop', label: t('跟随桌面', 'Follow desktop') },
            ],
        },
        {
            key: 'seed', type: 'number', defaultValue: 20261105, min: 0, max: 99999999, step: 1,
            label: t('随机种子', 'Random seed'),
            description: t('换个数字就是另一套随机结果；相同种子永远得到相同的顺序', 'Change the number for a different shuffle; the same seed always gives the same order'),
        },
        {
            key: 'reshuffle', type: 'select', defaultValue: 'song',
            label: t('重新抽取时机', 'Reshuffle on'),
            description: t('伪随机模式下什么时候换下一张', 'When pseudo-random mode picks the next wallpaper'),
            options: [
                { value: 'song', label: t('每次切歌', 'Song change') },
                { value: 'hour', label: t('每小时', 'Every hour') },
                { value: 'session', label: t('每次启动', 'App launch') },
            ],
        },
        {
            key: 'liveOnly', type: 'boolean', defaultValue: true,
            label: t('只抽动态壁纸', 'Live wallpapers only'),
            description: t('只从视频与网页壁纸里抽。场景壁纸（scene.pkg）第三方无法渲染，只能放预览图', 'Draw only from video and web wallpapers. Scene wallpapers (scene.pkg) cannot be rendered by third parties and fall back to their preview image'),
        },
        {
            key: 'sceneFps', type: 'number', defaultValue: 30, min: 15, max: 60, step: 5,
            label: t('场景帧率', 'Scene frame rate'),
            description: t('实时渲染场景的帧率上限；调低可省电、省 GPU', 'Frame-rate cap for live scenes; lower it to save power'),
        },
        {
            key: 'fit', type: 'select', defaultValue: 'cover',
            label: t('填充方式', 'Fit'),
            description: t('壁纸与窗口比例不一致时怎么摆', 'How the wallpaper is placed when its aspect ratio differs'),
            options: [
                { value: 'cover', label: t('铺满裁切', 'Cover') },
                { value: 'contain', label: t('完整留边', 'Contain') },
                { value: 'fill', label: t('拉伸铺满', 'Fill') },
            ],
        },
        {
            key: 'motionAmount', type: 'number', defaultValue: 30, min: 0, max: 100, step: 1,
            label: t('跟随鼓点推拉', 'Beat zoom'),
            description: t('0 关闭；往右拉是幅度更大的推拉。判定方式与自带「隐现」背景一致：全频段加权后看帧间上升量，起得快、落得慢', '0 turns it off; drag right for a bigger push. Detection matches the built-in “latent” background: weighted bands, frame-to-frame rise, fast attack and slow release'),
        },
        {
            key: 'blur', type: 'number', defaultValue: 0, min: 0, max: 40, step: 1,
            label: t('背景模糊', 'Blur'),
            description: t('模糊能显著提升歌词可读性，也更有氛围', 'Blur helps readability a lot and sets a mood'),
        },
        {
            key: 'dim', type: 'number', defaultValue: 0.06, min: 0, max: 0.85, step: 0.01,
            label: t('整体压暗', 'Dim'),
            description: t('均匀压暗一层，和下面的自动叠色互不影响', 'An even darkening layer, independent of the automatic tint below'),
        },
        {
            key: 'saturation', type: 'number', defaultValue: 1.05, min: 0, max: 2, step: 0.05,
            label: t('饱和度', 'Saturation'),
        },
        {
            key: 'readability', type: 'number', defaultValue: 15, min: 0, max: 100, step: 1,
            label: t('歌词可读性避让', 'Lyric readability'),
            description: t('按歌词所在区域的实际亮度自动叠色，把对比度顶到这个档位；0 为关闭', 'Measures the brightness behind the lyrics and tints just enough to reach this contrast target; 0 turns it off'),
        },
        {
            key: 'vignette', type: 'number', defaultValue: 0.3, min: 0, max: 1, step: 0.05,
            label: t('暗角', 'Vignette'),
        },
        {
            key: 'videoRate', type: 'number', defaultValue: 1, min: 0.25, max: 2, step: 0.05,
            label: t('视频速度', 'Video speed'),
            description: t('只影响视频壁纸的播放速度', 'Playback speed of video wallpapers only'),
        },
        {
            key: 'syncPause', type: 'boolean', defaultValue: true,
            label: t('与播放同步', 'Sync with playback'),
            description: t('音乐暂停时壁纸也停住，省电也安静', 'Freeze the wallpaper while the music is paused'),
        },
        {
            key: 'showInfo', type: 'boolean', defaultValue: false,
            label: t('显示壁纸名', 'Show wallpaper name'),
            description: t('左下角小字标注当前壁纸', 'A small caption with the current wallpaper'),
        },
    ];

    // -----------------------------------------------------------------------
    // 亮度 / 对比度计算
    // -----------------------------------------------------------------------

    const hexToRgb = (value) => {
        if (typeof value !== 'string') {
            return null;
        }
        const text = value.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{3}$/.test(text)) {
            return [0, 1, 2].map((index) => parseInt(text[index] + text[index], 16));
        }
        if (/^[0-9a-fA-F]{6}$/.test(text)) {
            return [0, 2, 4].map((index) => parseInt(text.slice(index, index + 2), 16));
        }
        return null;
    };

    const channelLuminance = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };

    const relativeLuminance = (rgb) => (
        0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2])
    );

    const contrastRatio = (a, b) => {
        const high = Math.max(a, b);
        const low = Math.min(a, b);
        return (high + 0.05) / (low + 0.05);
    };

    /*
     * 解一个叠色透明度：把背景亮度往远离歌词色的方向推，直到对比度达到目标。
     * 亮度混合在 0..1 上单调，二分足够，也不会有浮点抖动。
     */
    const solveScrim = (backgroundLum, textLum, target) => {
        if (!(target > 1)) {
            return null;
        }
        const darken = textLum >= backgroundLum;
        const scrimLum = darken ? 0.004 : 0.985;
        const rgb = darken ? [6, 7, 11] : [246, 247, 250];
        let low = 0;
        let high = 1;
        if (contrastRatio(scrimLum, textLum) < target) {
            // 纯黑/纯白都顶不到目标：给到最大，交给用户下调档位
            return { alpha: 0.9, rgb };
        }
        for (let step = 0; step < 22; step += 1) {
            const mid = (low + high) / 2;
            const blended = backgroundLum * (1 - mid) + scrimLum * mid;
            if (contrastRatio(blended, textLum) >= target) {
                high = mid;
            } else {
                low = mid;
            }
        }
        return { alpha: Math.min(0.9, high), rgb };
    };

    const readabilityTarget = (value) => {
        const normalized = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
        // 1.6 : 1（几乎不干预）→ 6 : 1（接近 AAA）
        return 1.6 + (normalized ** 1.25) * 4.4;
    };

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 64;
    sampleCanvas.height = 36;

    /*
     * 只取画面中间那一条带（歌词压在这里），返回平均亮度与最亮一行，
     * 用亮度更高的那一侧决定叠色强度，避免个别高光把整屏带黑。
     */
    const sampleBandLuminance = (source) => {
        const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }
        try {
            context.drawImage(source, 0, 0, 64, 36);
        } catch {
            return null;
        }
        let data;
        try {
            data = context.getImageData(0, 0, 64, 36).data;
        } catch {
            // 跨源被污染（file:// 兜底路径）：读不了就退回中性值
            return null;
        }
        const rows = [];
        let sum = 0;
        let count = 0;
        for (let y = 7; y <= 29; y += 1) {
            let rowSum = 0;
            for (let x = 0; x < 64; x += 1) {
                const index = (y * 64 + x) * 4;
                rowSum += relativeLuminance([data[index], data[index + 1], data[index + 2]]);
            }
            const row = rowSum / 64;
            rows.push(row);
            sum += row;
            count += 1;
        }
        if (count === 0) {
            return null;
        }
        const mean = sum / count;
        const peak = Math.max(...rows);
        return mean + 0.35 * (peak - mean);
    };

    // -----------------------------------------------------------------------
    // 选择逻辑
    // -----------------------------------------------------------------------

    const fnv1a = (text) => {
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash >>> 0;
    };

    const shuffleKey = (settings, context) => {
        if (settings.reshuffle === 'hour') {
            return `h${Math.floor(Date.now() / 3_600_000)}`;
        }
        if (settings.reshuffle === 'session') {
            return 'session';
        }
        try {
            return `s${context.getCoverUrl() ?? ''}`;
        } catch {
            return 'session';
        }
    };

    /*
     * 自定义文件走同一套选法：指定 / 伪随机 / 跟随桌面（后者没有桌面可跟，
     * 退回伪随机，面板里会写明）。自定义条目本来就少，抽中率是均匀的。
     */
    const chooseCustom = (entries, settings, context, selection) => {
        if (!Array.isArray(entries) || entries.length === 0) {
            return null;
        }
        if (settings.mode === 'fixed') {
            return entries.find((entry) => entry.grantId === selection.customId) ?? entries[0];
        }
        const index = fnv1a(`${settings.seed}|${shuffleKey(settings, context)}`) % entries.length;
        return entries[index];
    };

    const chooseWallpaper = (library, settings, context, selection) => {
        if (!library || !Array.isArray(library.items) || library.items.length === 0) {
            return null;
        }
        const all = library.items;
        if (settings.mode === 'fixed') {
            return all.find((item) => item.id === selection.wallpaperId) ?? all[0];
        }
        if (settings.mode === 'desktop') {
            const current = all.find((item) => item.id === library.currentId);
            if (current) {
                return current;
            }
        }
        const pool = settings.liveOnly ? all.filter((item) => item.live) : all;
        const usable = pool.length > 0 ? pool : all;
        const index = fnv1a(`${settings.seed}|${shuffleKey(settings, context)}`) % usable.length;
        return usable[index];
    };

    // -----------------------------------------------------------------------
    // 媒体地址
    // -----------------------------------------------------------------------

    const encodePath = (relative) => relative
        .split(/[\\/]/)
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join('/');

    const httpUrl = (library, item, relative) => {
        if (!library || !library.base || !relative) {
            return null;
        }
        return `${library.base}/i/${encodeURIComponent(item.id)}/r/${encodePath(relative)}`;
    };

    // 场景壁纸的原图（主进程从 scene.pkg 里抽出来）；没有就 404，前端自动退预览图
    const artUrl = (library, item) => {
        if (!library || !library.base) {
            return null;
        }
        return `${library.base}/i/${encodeURIComponent(item.id)}/art`;
    };

    // http 服务不可用时的兜底：file://（页面本身是 file://，同源可读）
    const toFileUrl = (absolute) => {
        if (typeof absolute !== 'string' || absolute.length === 0) {
            return null;
        }
        return `file:///${absolute
            .replace(/\\/g, '/')
            .split('/')
            .map((segment, index) => (index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
            .join('/')}`;
    };

    // -----------------------------------------------------------------------
    // 背景挂载
    // -----------------------------------------------------------------------

    const mountWallpaper = (container, context) => {
        const style = document.createElement('style');
        style.textContent = `
            .wp-eng-root { position: absolute; inset: 0; overflow: hidden; contain: strict; background: #06070a; }
            .wp-eng-media { position: absolute; inset: 0; transform-origin: 50% 50%; will-change: transform; }
            .wp-eng-media > video, .wp-eng-media > img, .wp-eng-media > canvas { width: 100%; height: 100%; display: block; object-fit: cover; border: 0; }
            .wp-eng-media > iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; opacity: 0; transition: opacity 700ms ease; }
            .wp-eng-media > iframe.wp-eng-ready { opacity: 1; }
            .wp-eng-scrim, .wp-eng-dim, .wp-eng-vignette, .wp-eng-info { position: absolute; inset: 0; pointer-events: none; }
            .wp-eng-dim, .wp-eng-vignette { background: #000; }
            .wp-eng-info {
                inset: auto 0 22px 0; display: flex; justify-content: flex-start; padding: 0 26px;
                font: 500 11px/1.5 "Microsoft YaHei UI", system-ui, sans-serif; letter-spacing: 0.02em;
                color: rgba(255, 255, 255, 0.62); text-shadow: 0 1px 8px rgba(0, 0, 0, 0.75);
                opacity: 0; transition: opacity 500ms ease;
            }
            .wp-eng-info.wp-eng-visible { opacity: 1; }
            .wp-eng-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 6; }
            .wp-eng-error-card {
                max-width: min(560px, 90%); border-radius: 16px; padding: 18px 20px;
                background: rgba(12, 13, 18, 0.9); border: 1px solid rgba(255, 255, 255, 0.14);
                color: #f2f3f5; font: 400 12px/1.7 "Microsoft YaHei UI", system-ui, sans-serif;
                box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); pointer-events: auto;
                backdrop-filter: blur(12px);
            }
            .wp-eng-error-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
            .wp-eng-error-sub { color: rgba(255, 255, 255, 0.62); margin-bottom: 12px; word-break: break-all; }
            .wp-eng-error-actions { display: flex; gap: 8px; flex-wrap: wrap; }
            .wp-eng-error-actions button {
                cursor: pointer; border-radius: 8px; padding: 6px 12px; font-size: 11.5px;
                border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.1); color: #fff;
            }
            .wp-eng-error-actions button:hover { background: rgba(255, 255, 255, 0.2); }
            .wp-eng-error-status { margin-top: 10px; color: rgba(255, 255, 255, 0.55); min-height: 16px; }
            .wp-eng-toast {
                position: absolute; top: 14px; left: 50%; transform: translate(-50%, -8px);
                display: flex; align-items: center; gap: 10px; max-width: min(720px, 92%);
                padding: 9px 12px; border-radius: 12px; z-index: 7; pointer-events: auto;
                background: rgba(14, 15, 20, 0.92); border: 1px solid rgba(255, 255, 255, 0.16);
                color: #f2f3f5; font: 400 12px/1.5 "Microsoft YaHei UI", system-ui, sans-serif;
                box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5); backdrop-filter: blur(10px);
                opacity: 0; transition: opacity 220ms ease, transform 220ms ease;
            }
            .wp-eng-toast.wp-eng-in { opacity: 1; transform: translate(-50%, 0); }
            .wp-eng-toast-text { flex: 1; min-width: 0; }
            .wp-eng-toast-sub { color: rgba(255, 255, 255, 0.6); font-size: 11px; }
            .wp-eng-toast button {
                flex: none; cursor: pointer; border-radius: 8px; padding: 5px 11px; font-size: 11.5px;
                border: 1px solid rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.14); color: #fff;
            }
            .wp-eng-toast button:hover { background: rgba(255, 255, 255, 0.24); }
            .wp-eng-toast button.wp-eng-ghost { background: transparent; border-color: rgba(255, 255, 255, 0.16); color: rgba(255, 255, 255, 0.7); }
        `;

        const root = document.createElement('div');
        root.className = 'wp-eng-root';
        const mediaWrap = document.createElement('div');
        mediaWrap.className = 'wp-eng-media';
        const scrim = document.createElement('div');
        scrim.className = 'wp-eng-scrim';
        const dim = document.createElement('div');
        dim.className = 'wp-eng-dim';
        const vignette = document.createElement('div');
        vignette.className = 'wp-eng-vignette';
        const info = document.createElement('div');
        info.className = 'wp-eng-info';
        root.append(mediaWrap, scrim, dim, vignette, info);
        container.append(style, root);

        let media = null;          // video | img | iframe | canvas | live host
        let currentKey = null;
        let liveInstance = null;   // WebWallGL 实例（场景实时渲染时才有）
        let customMedia = false;   // 当前媒体来自 folia-mod://（画布不可采样）
        let sceneErrorCard = null; // 场景三层都失败时的错误卡
        let sceneToast = null;     // 实时渲染失败、但兜底成功时的顶部提示
        let sceneToastTimer = 0;
        let stopLive = null;   // 实时场景的停止函数列表
        let cleanupMedia = null;
        let disposed = false;
        let selection = {};
        let library = null;

        const textLuminance = () => {
            let primary = '#ffffff';
            try {
                const theme = context.getTheme();
                primary = theme?.primaryColor ?? primary;
            } catch {
                /* 主题拿不到就用白字 */
            }
            const rgb = hexToRgb(primary) ?? [255, 255, 255];
            return relativeLuminance(rgb);
        };

        const paintReadability = (backgroundLum) => {
            const settings = context.getSettings();
            const target = readabilityTarget(settings.readability);
            if (target <= 1.6 || backgroundLum === null) {
                scrim.style.background = 'transparent';
                return;
            }
            const solution = solveScrim(backgroundLum, textLuminance(), target);
            if (!solution) {
                scrim.style.background = 'transparent';
                return;
            }
            const [r, g, b] = solution.rgb;
            const a = solution.alpha;
            if (a < 0.012) {
                scrim.style.background = 'transparent';
                return;
            }
            scrim.style.background = `radial-gradient(150% 105% at 50% 50%,
                rgba(${r}, ${g}, ${b}, ${a.toFixed(3)}) 0%,
                rgba(${r}, ${g}, ${b}, ${(a * 0.94).toFixed(3)}) 44%,
                rgba(${r}, ${g}, ${b}, ${(a * 0.66).toFixed(3)}) 74%,
                rgba(${r}, ${g}, ${b}, ${(a * 0.46).toFixed(3)}) 100%)`;
        };

        const refreshReadability = () => {
            // 实时场景：直接采引擎画布。跨源贴图可能污染画布读不出像素，读不到就按中等偏亮估
            if (liveInstance?.canvas) {
                const luminance = sampleBandLuminance(liveInstance.canvas);
                paintReadability(luminance ?? 0.34);
                return;
            }
            if (!media || media.tagName === 'IFRAME') {
                // 网页壁纸读不到像素：按「中等偏亮」保守估一份，不会把画面压死
                paintReadability(0.34);
                return;
            }
            if (media.tagName === 'IMG' && media.complete && media.naturalWidth > 0) {
                paintReadability(sampleBandLuminance(media) ?? (customMedia ? 0.34 : null));
                return;
            }
            if (media.tagName === 'CANVAS') {
                paintReadability(sampleBandLuminance(media) ?? (customMedia ? 0.34 : null));
                return;
            }
            if (media.tagName === 'VIDEO' && media.readyState >= 2 && media.videoWidth > 0) {
                paintReadability(sampleBandLuminance(media));
            }
        };

        /*
         * 鼓点推拉。
         *
         * 判定方式照搬 Folia 自带的「隐现（latent）」背景（playerOverlayLayout 里的
         * enhancedBeatResponse 分支），它比单纯盯低频稳得多：
         *   1. 全频段加权后开 0.55 次方（压缩动态，小音量也有反应）：
         *      (bass*.22 + lowMid*.18 + mid*.22 + vocal*.28 + treble*.1) ** 0.55
         *   2. 鼓点 = 本帧电平相对上一帧的「上升量 × 7」，每帧衰减 0.84
         *   3. 合成 = 电平*0.42 + 鼓点*0.85
         *   4. 输出做非对称平滑：上升 0.42、回落 0.14（起得快、落得慢，不像之前那样发颤）
         * 滑块 0..100 线性映射到最大 8% 的额外缩放；0 关闭。
         */
        const MOTION_MAX = 0.05;   // 滑块 100% 时的最大额外缩放

        let motionRaf = 0;
        let motionBeat = 0;
        let motionPrevLevel = 0;
        let motionOutput = 0;
        let motionLastFrame = 0;
        let motionWritten = -1;

        const unit = (value) => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
        };

        // 把「60fps 下每帧的系数」换算成按经过时间生效，掉帧时行为不变
        const easeAlpha = (perFrame, dt) => 1 - Math.pow(1 - perFrame, Math.min(0.1, dt) * 60);

        const motionStrength = () => Math.min(1, Math.max(0, Number(context.getSettings().motionAmount) / 100));

        const baseScale = () => (Number(context.getSettings().blur) > 0 ? 1.06 : 1);

        // 图片、视频、网页、实时场景都能被外层缩放带动
        const motionAllowed = () => {
            if (disposed || !media || context.staticMode) {
                return false;
            }
            return motionStrength() > 0;
        };

        const writeScale = (scale) => {
            if (Math.abs(scale - motionWritten) < 0.0002) {
                return;
            }
            motionWritten = scale;
            mediaWrap.style.transform = `scale(${scale.toFixed(4)})`;
        };

        const stopMotion = () => {
            if (motionRaf) {
                if (typeof cancelAnimationFrame === 'function') {
                    cancelAnimationFrame(motionRaf);
                }
                motionRaf = 0;
            }
            motionBeat = 0;
            motionPrevLevel = 0;
            motionOutput = 0;
            motionLastFrame = 0;
            motionWritten = -1;
        };

        const tickMotion = (now) => {
            motionRaf = 0;
            if (!motionAllowed()) {
                stopMotion();
                writeScale(baseScale());
                return;
            }
            const first = motionLastFrame === 0;
            const dt = first ? 0.016 : Math.min(0.05, (now - motionLastFrame) / 1000);
            motionLastFrame = now;
            const paused = context.isPaused();

            let bands = null;
            if (!paused) {
                try {
                    bands = typeof context.audio?.getBands === 'function' ? context.audio.getBands() : null;
                } catch {
                    bands = null;
                }
            }
            if (!bands) {
                bands = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0 };
            }
            const combined = unit(bands.bass) * 0.22
                + unit(bands.lowMid) * 0.18
                + unit(bands.mid) * 0.22
                + unit(bands.vocal) * 0.28
                + unit(bands.treble) * 0.1;
            // 低电平当成静音：0.08 以下不放大，避免底噪让画面一直鼓着
            const level = combined <= 0.08 ? 0 : Math.pow((combined - 0.08) / 0.92, 0.55);

            if (first) {
                motionPrevLevel = level;
            }
            const rise = Math.max(0, (level - motionPrevLevel) * 7);
            motionPrevLevel = level;
            motionBeat = Math.max(motionBeat * Math.pow(0.84, dt * 60), Math.min(1, rise));

            const drive = Math.min(1, level * 0.42 + motionBeat * 0.85);
            motionOutput += (drive - motionOutput) * easeAlpha(drive > motionOutput ? 0.42 : 0.14, dt);
            if (motionOutput < 0.0015) {
                motionOutput = 0;
            }

            writeScale(baseScale() * (1 + motionOutput * MOTION_MAX * motionStrength()));
            motionRaf = requestAnimationFrame(tickMotion);
        };

        const startMotion = () => {
            if (typeof requestAnimationFrame !== 'function') {
                writeScale(baseScale());
                return;
            }
            if (!motionAllowed()) {
                stopMotion();
                writeScale(baseScale());
                return;
            }
            if (!motionRaf) {
                motionLastFrame = 0;
                motionRaf = requestAnimationFrame(tickMotion);
            }
        };

        const applyFilters = () => {
            const settings = context.getSettings();
            const blur = Math.max(0, Number(settings.blur) || 0);
            const saturation = Math.max(0, Number(settings.saturation) || 0);
            // 模糊会吃掉边缘，稍微放大一点盖住；推拉幅度由鼓点循环接管
            mediaWrap.style.filter = `blur(${blur}px) saturate(${saturation})`;

            dim.style.opacity = String(Math.max(0, Math.min(1, Number(settings.dim) || 0)));
            const vignetteStrength = Math.max(0, Math.min(1, Number(settings.vignette) || 0));
            vignette.style.opacity = String(vignetteStrength);
            vignette.style.background = vignetteStrength > 0
                ? 'radial-gradient(120% 90% at 50% 45%, rgba(0,0,0,0) 42%, rgba(0,0,0,0.55) 78%, rgba(0,0,0,0.92) 100%)'
                : 'transparent';

            if (media && media.tagName === 'VIDEO') {
                const rate = Math.max(0.25, Math.min(2, Number(settings.videoRate) || 1));
                try {
                    media.playbackRate = rate;
                } catch {
                    /* 某些编码不支持变速 */
                }
            }

            const fit = settings.fit === 'contain' || settings.fit === 'fill' ? settings.fit : 'cover';
            if (media && media.tagName !== 'IFRAME' && !liveInstance) {
                media.style.objectFit = fit;
            }

            // 实时场景有自己的相机，静态图才需要跟随鼓点
            startMotion();

            info.classList.toggle('wp-eng-visible', settings.showInfo !== false);

            if (liveInstance && settings.syncPause) {
                try {
                    if (context.isPaused()) {
                        liveInstance.pause();
                    } else {
                        liveInstance.resume();
                    }
                } catch {
                    /* 实例还没就绪 */
                }
            }

            if (media && media.tagName === 'VIDEO' && settings.syncPause) {
                if (context.isPaused()) {
                    if (!media.paused) {
                        media.pause();
                    }
                } else if (media.paused) {
                    media.play().catch(() => undefined);
                }
            }

            // 可读性档位、主题歌词色、画面本身都可能刚变，重算一次叠色
            refreshReadability();
        };

        const teardownMedia = () => {
            stopMotion();
            if (cleanupMedia) {
                try {
                    cleanupMedia();
                } catch {
                    /* 清理失败不影响换下一张 */
                }
                cleanupMedia = null;
            }
            if (media) {
                if (media.tagName === 'VIDEO') {
                    try {
                        media.pause();
                        media.removeAttribute('src');
                        media.load();
                    } catch {
                        /* 已经销毁 */
                    }
                }
                media.remove();
                media = null;
            }
            customMedia = false;
            mediaWrap.replaceChildren();
        };

        /*
         * 先走本地 HTTP（Range / CORS / 正确 MIME 都齐），失败再退 file://。
         * 退到 file:// 后画布会被污染，可读性检测自动降级成中性叠色。
         */
        const attachWithFallback = (element, primary, fallback) => {
            let triedFallback = false;
            const onError = () => {
                if (triedFallback || !fallback) {
                    return;
                }
                triedFallback = true;
                // file:// 走不了 CORS 模式，得把 crossOrigin 摘掉，否则一样报错
                element.removeAttribute('crossorigin');
                element.src = fallback;
            };
            element.addEventListener('error', onError);
            element.src = primary ?? fallback;
            return () => element.removeEventListener('error', onError);
        };

        /*
         * 依次尝试多个地址：前一个加载失败就换下一个，加载成功回调带上它是第几个，
         * 用来区分「原画」和「预览图」。file:// 走不了 CORS 模式，切过去前摘掉 crossOrigin。
         */
        const attachChain = (element, sources, onSettle) => {
            let index = 0;
            const onError = () => {
                index += 1;
                if (index >= sources.length) {
                    return;
                }
                element.removeAttribute('crossorigin');
                element.src = sources[index].url;
            };
            const onLoad = () => onSettle(index);
            element.addEventListener('error', onError);
            element.addEventListener('load', onLoad);
            element.src = sources[0].url;
            return () => {
                element.removeEventListener('error', onError);
                element.removeEventListener('load', onLoad);
            };
        };

        /*
         * 场景加载的诊断记录。场景壁纸可能在三层里都失败，原因各不相同，
         * 用户要报 bug 时手里得有一份能看的东西，所以每一层都把原因记下来。
         */
        const attempts = [];
        const noteAttempt = (stage, ok, detail) => {
            attempts.push(`${ok ? 'OK' : 'FAIL'} ${stage}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
            if (attempts.length > 12) {
                attempts.shift();
            }
        };

        const diag = [];
        const pushDiag = (stage, message, level = 'error') => {
            const text = typeof message === 'string' ? message : String(message?.message ?? message);
            diag.push({ at: new Date().toISOString(), stage, level, message: text.slice(0, 400) });
            if (diag.length > 120) {
                diag.splice(0, diag.length - 120);
            }
            if (level === 'error') {
                console.warn(`[壁纸引擎] ${stage}: ${text}`);
            }
        };

        const webglInfo = () => {
            try {
                const probe = document.createElement('canvas');
                const gl2 = probe.getContext('webgl2');
                if (gl2) {
                    return 'WebGL2';
                }
                const gl1 = probe.getContext('webgl');
                return gl1 ? 'WebGL1' : '不可用';
            } catch {
                return '检测失败';
            }
        };

        /*
         * 场景壁纸不是静态图：它是多层 2.5D 场景，每层一张带透明通道的贴图。
         * 主进程把「画幅 + 每层的场景矩形 + 贴图字节区间」整理好，这里按顺序
         * 叠到一张 canvas 上，得到一张分辨率远超官方预览图的完整画面。
         * 逐层加载、画完即释放，避免十几张 4K 位图同时驻留显存。
         */
        const compositeScene = async (item, isCancelled) => {
            if (!library?.base) {
                pushDiag('合成静态图', '本地服务没有就绪（library.base 为空）');
                return false;
            }
            let manifest;
            try {
                const res = await fetch(`${library.base}/i/${encodeURIComponent(item.id)}/scene`, { cache: 'no-store' });
                if (!res.ok) {
                    pushDiag('合成静态图', `图层清单返回 HTTP ${res.status}`);
                    return false;
                }
                manifest = await res.json();
            } catch (error) {
                pushDiag('合成静态图', `读取图层清单失败：${error?.message ?? error}`);
                return false;
            }
            if (!manifest?.ok || !Array.isArray(manifest.layers) || manifest.layers.length === 0 || !manifest.frame) {
                pushDiag('合成静态图', 'scene.pkg 里没有可用的纯贴图层（可能全部是着色器或 DXT 贴图）');
                noteAttempt('合成静态图', false, '没有可合成的贴图层');
                return false;
            }
            if (isCancelled()) {
                return true;
            }

            const frame = manifest.frame;
            const width = Math.max(960, Math.min(2560, Math.round(frame.w)));
            const height = Math.max(540, Math.round((width * frame.h) / frame.w));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const painter = canvas.getContext('2d');
            if (!painter) {
                return false;
            }
            painter.fillStyle = '#06070a';
            painter.fillRect(0, 0, width, height);
            media = canvas;
            mediaWrap.append(canvas);
            startMotion();

            const scale = Math.max(width / frame.w, height / frame.h);
            for (const layer of manifest.layers) {
                if (isCancelled()) {
                    return true;
                }
                const image = new Image();
                image.crossOrigin = 'anonymous';
                image.decoding = 'async';
                image.src = `${library.base}/i/${encodeURIComponent(item.id)}/layer/${layer.index}`;
                try {
                    await image.decode();
                } catch {
                    continue;
                }
                if (isCancelled()) {
                    return true;
                }
                const centerX = width / 2 + (layer.cx - frame.cx) * scale;
                const centerY = height / 2 - (layer.cy - frame.cy) * scale;
                const drawWidth = layer.w * scale;
                const drawHeight = layer.h * scale;
                painter.globalAlpha = Math.max(0, Math.min(1, Number(layer.alpha ?? 1)));
                try {
                    painter.drawImage(image, centerX - drawWidth / 2, centerY - drawHeight / 2, drawWidth, drawHeight);
                } catch {
                    /* 单层画不上不影响其余层 */
                }
                image.src = '';
                if (layer.index === 0) {
                    info.textContent = formatCaption(item, 'composited');
                    refreshReadability();
                }
            }
            painter.globalAlpha = 1;
            noteAttempt('合成静态图', true, `${manifest.layers.length} 层`);
            refreshReadability();
            return true;
        };

        /*
         * 实时渲染场景：把壁纸目录挂在本地 HTTP 上，交给 WebWallGL 解析 scene.pkg 并
         * 逐帧渲染。加载期间先垫一张预览图，避免装配那几秒黑屏。
         * 失败（引擎没起来 / 包解析不了）返回 false，交给静态兜底。
         */
        const liveScene = async (item, settings, isCancelled, registerStop) => {
            if (!library?.base) {
                pushDiag('实时渲染', '本地服务没有就绪（library.base 为空）');
                return false;
            }
            let engine;
            try {
                engine = await loadEngine();
            } catch (error) {
                pushDiag('实时渲染', `引擎脚本加载失败：${error?.message ?? error}`);
                noteAttempt('实时渲染', false, `引擎脚本加载失败：${error?.message ?? error}`);
                return false;
            }
            if (isCancelled()) {
                return true;
            }

            let poster = null;

            const host = document.createElement('div');
            host.style.cssText = 'position:absolute;inset:0;';
            mediaWrap.append(host);

            // 引擎是否已经产出过装配/首帧诊断
            let engineAlive = false;
            let instance;
            try {
                instance = engine.createScene(host, {
                    fit: settings.fit === 'contain' ? 'contain' : settings.fit === 'fill' ? 'stretch' : 'cover',
                    fps: Math.max(15, Math.min(60, Number(settings.sceneFps) || 30)),
                    volume: 0,
                    autoplay: true,
                    // 永远不执行壁纸自带的 SceneScript：它来自创意工坊、不在签名范围里，
                    // 而引擎用 new Function 求值，脚本能拿到宿主页面。脚本关掉后
                    // 场景仍会跑图层动画、粒子、着色器，只是时钟/文字/属性联动停在快照值。
                    scripts: false,
                    onError: (error) => {
                        // 引擎自己报的致命错误，原样记进日志（下次导出就能看到真正原因）
                        pushDiag('实时渲染', `引擎错误：${error?.message ?? error}`, 'error');
                        noteAttempt('实时渲染', false, `引擎错误：${error?.message ?? error}`);
                    },
                    onDiagnostic: (message, level) => {
                        // 引擎吐过装配/首帧的 info，就说明它确实跑起来了。
                        // 后面 load() 的 promise 即使被拒，也不该把已经渲染的画面扔掉。
                        // 只有「渲染器真的起来了」才算活着。仅凭「包已收到」会让
                        // 卡在装配阶段的场景一直留一块黑屏，不如老实降级。
                        if (level !== 'error' && /renderer started|renderer:/i.test(String(message))) {
                            engineAlive = true;
                        }
                        pushDiag('实时渲染', message, level === 'error' ? 'error' : 'info');
                    },
                });
            } catch (error) {
                pushDiag('实时渲染', `createScene 失败：${error?.message ?? error}`);
                noteAttempt('实时渲染', false, `createScene 失败：${error?.message ?? error}`);
                host.remove();
                poster?.remove();
                return false;
            }

            let destroyed = false;
            liveInstance = instance;
            media = host;
            startMotion();
            const stop = () => {
                if (destroyed) {
                    return;
                }
                destroyed = true;
                if (liveInstance === instance) {
                    liveInstance = null;
                }
                try {
                    instance.destroy();
                } catch {
                    /* 已经销毁 */
                }
            };
            registerStop(stop);
            // 真实频谱 + 真实「正在播放」，替换引擎的模拟数据
            attachAudio(instance);
            attachMedia(instance, engine, registerStop);

            const source = engine.httpSource(`${library.base}/i/${encodeURIComponent(item.id)}/r`);
            // 首帧可能很久（大包解析）。等 20 秒：超时但引擎已经在装配，就让它继续跑；
            // 只有从头到尾没有任何装配迹象，才算失败。
            const firstFrame = instance.load(source)
                .then(() => 'ready', (error) => ({ reason: error?.message ?? String(error) }))
                .catch(() => ({ reason: 'load-failed' }));
            const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000));
            const outcome = await Promise.race([firstFrame, timeout]);
            if (outcome !== 'ready' && !destroyed && !isCancelled()) {
                if (engineAlive) {
                    // 引擎已经在渲染（装配日志、首帧都可能晚于 load 的 promise）
                    pushDiag('实时渲染', `load 未在预期时间内完成（${typeof outcome === 'string' ? outcome : outcome.reason}），但引擎已在渲染，继续使用`, 'info');
                } else {
                    const reason = typeof outcome === 'string' ? outcome : outcome.reason;
                    pushDiag('实时渲染', `scene.pkg 解析失败：${reason}`);
                    noteAttempt('实时渲染', false, reason);
                    stop();
                    host.remove();
                    poster?.remove();
                    return false;
                }
            }
            if (destroyed) {
                noteAttempt('实时渲染', true, '已被取消但引擎曾启动');
                return true;
            }
            noteAttempt('实时渲染', true, engineAlive ? '引擎已渲染' : `load=${typeof outcome === 'string' ? outcome : 'ok'}`);
            // 壁纸自带的 BGM 一律不播
            try {
                instance.setVolume?.(0);
            } catch {
                /* 老版本引擎没有 setVolume */
            }
            poster?.remove();
            info.textContent = formatCaption(item, 'live');
            if (settings.syncPause && context.isPaused()) {
                try {
                    instance.pause();
                } catch {
                    /* 不支持暂停 */
                }
            }
            refreshReadability();
            return true;
        };

        /*
         * 音频响应：把 Folia 的实时频谱喂给引擎。
         * 引擎默认用内置的模拟频谱（自己在那儿跳），所以「音频响应」类壁纸
         * 之前跟音乐毫无关系。ctx.audio 给的是 64 段 Uint8Array（0..255），
         * 引擎要的是左右声道各 64 段、0..1 的浮点。
         */
        /*
         * 把 Folia 的实时频谱读成 WE 的 128 段格式（左 64 + 右 64，0..1）。
         * scene 走引擎的 setAudio，网页壁纸走 postMessage 推给注入的垫片。
         */
        // 上一帧的输出，用于暂停时平滑衰减（直接清零会「啪」一下，保留残留又会抽搐）
        const lastLeft = new Float32Array(64);
        const lastRight = new Float32Array(64);

        // 噪声门限：极小的值直接归零，避免静音段细碎抖动；同时记下本帧供暂停时衰减
        const gateAndRemember = (left, right) => {
            for (let index = 0; index < 64; index += 1) {
                if (left[index] < 0.015) {
                    left[index] = 0;
                }
                if (right[index] < 0.015) {
                    right[index] = 0;
                }
                lastLeft[index] = left[index];
                lastRight[index] = right[index];
            }
        };

        const fillAudioFrames = (left, right) => {
            /*
             * 暂停时 Folia 的频谱仍会抖动（分析器没数据时也吐噪声），
             * 壁纸的频谱条就会一直抽。这里直接不读，改为把上一帧按 0.82 逐帧衰减到 0。
             */
            if (context.isPaused()) {
                for (let index = 0; index < 64; index += 1) {
                    const l = lastLeft[index] * 0.82;
                    const r = lastRight[index] * 0.82;
                    lastLeft[index] = l < 0.002 ? 0 : l;
                    lastRight[index] = r < 0.002 ? 0 : r;
                    left[index] = lastLeft[index];
                    right[index] = lastRight[index];
                }
                return;
            }
            const audio = context.audio;
            let spectrum = null;
            try {
                spectrum = audio && typeof audio.getSpectrum === 'function' ? audio.getSpectrum() : null;
            } catch {
                spectrum = null;
            }
            // 频谱数组存在但整排是 0（未开始分析 / 静音段）时退到分频能量，
            // 否则壁纸会一直「没反应」
            let spectrumPeak = 0;
            if (spectrum) {
                for (let index = 0; index < spectrum.length; index += 1) {
                    const raw = Number(spectrum[index]) || 0;
                    const value = raw > 1 ? raw / 255 : raw;
                    if (value > spectrumPeak) {
                        spectrumPeak = value;
                    }
                }
            }
            if (spectrum && spectrum.length > 0 && spectrumPeak > 0.01) {
                const count = Math.min(64, spectrum.length);
                for (let index = 0; index < count; index += 1) {
                    const raw = spectrum[index];
                    const value = raw > 1 ? Math.min(1, raw / 255) : Math.max(0, raw);
                    left[index] = value;
                    right[index] = value;
                }
                for (let index = count; index < 64; index += 1) {
                    left[index] = 0;
                    right[index] = 0;
                }
                return;
            }
            let bands = null;
            let power = 0;
            try {
                bands = audio && typeof audio.getBands === 'function' ? audio.getBands() : null;
                power = audio && typeof audio.getPower === 'function' ? Number(audio.getPower()) || 0 : 0;
            } catch {
                bands = null;
                power = 0;
            }
            const shape = bands
                ? [bands.bass, bands.lowMid, bands.mid, bands.vocal, bands.treble]
                : [power, power, power, power, power];
            for (let index = 0; index < 64; index += 1) {
                const band = shape[Math.min(shape.length - 1, Math.floor((index / 64) * shape.length))] ?? 0;
                const value = Math.max(0, Math.min(1, Number(band) || 0));
                left[index] = value;
                right[index] = value;
            }
            gateAndRemember(left, right);
        };

        const attachAudio = (instance) => {
            if (!context.audio || typeof instance.setAudio !== 'function') {
                return;
            }
            const left = new Float32Array(64);
            const right = new Float32Array(64);
            try {
                instance.setAudio({ snapshot: () => { fillAudioFrames(left, right); return { left, right }; } });
            } catch {
                /* 老版本引擎没有 setAudio */
            }
        };

        const attachMedia = (instance, engine, registerStop) => {
            if (typeof engine?.createMediaSource !== 'function' || typeof instance.setMedia !== 'function') {
                return;
            }
            const readPlayback = () => {
                try {
                    return folium.playback?.getState?.() ?? null;
                } catch {
                    return null;
                }
            };
            /*
             * 换歌判定不能只看 song.id：宿主给的歌曲 DTO 里 id 往往不存在（用的是 ref，
             * 而且 ref 每次都是新分配的），于是 key 永远不变、一直显示上一首。
             * 这里把能区分的字段都拼上，任何一项变了就重建媒体源。
             */
            const signatureOf = (state) => {
                const song = state?.song ?? null;
                if (!song) {
                    return `none|${state?.state ?? ''}`;
                }
                let cover = '';
                try {
                    cover = context.getCoverUrl?.() ?? '';
                } catch {
                    cover = '';
                }
                return [
                    state?.state ?? '',
                    song.ref ?? song.id ?? '',
                    song.title ?? '',
                    song.artist ?? '',
                    song.album ?? '',
                    cover,
                ].join('|');
            };

            let built = null;
            const build = () => {
                const state = readPlayback();
                const song = state?.song ?? null;
                let cover = null;
                try {
                    cover = context.getCoverUrl?.() ?? null;
                } catch {
                    cover = null;
                }
                const playing = state?.state === 'playing';
                const position = Number(state?.position) || 0;
                const init = {
                    hasMedia: Boolean(song),
                    playing,
                    state: playing ? 1 : state?.state === 'paused' ? 2 : 0,
                    title: song?.title ?? '',
                    artist: song?.artist ?? '',
                    album: song?.album ?? '',
                    position,
                    duration: Number(state?.duration) || 0,
                    ...(cover ? { thumbnail: cover, hasThumbnail: true } : { hasThumbnail: false }),
                };
                let source;
                try {
                    source = engine.createMediaSource(init);
                } catch {
                    return;
                }
                built = { key: signatureOf(state), at: Date.now(), position };
                try {
                    instance.setMedia(source);
                } catch {
                    /* 忽略 */
                }
            };
            build();
            if (typeof context.every !== 'function') {
                return;
            }
            const stop = context.every(1000, () => {
                const state = readPlayback();
                if (!built || signatureOf(state) !== built.key) {
                    build();
                    return;
                }
                // 引擎按自己的时钟推进进度，和播放器差得多了就重建一次
                const expected = built.position + (state?.state === 'playing' ? (Date.now() - built.at) / 1000 : 0);
                if (Math.abs(expected - (Number(state?.position) || 0)) > 2) {
                    build();
                }
            });
            registerStop(() => {
                try {
                    stop?.();
                } catch {
                    /* 已释放 */
                }
            });
        };

        /* 最后一层兜底：只取 scene.pkg 里的背景原图；失败就返回 false，交给错误卡 */
        const paintSceneArt = (item, isCancelled) => {
            const url = artUrl(library, item);
            if (!url) {
                pushDiag('单张原画', '这张壁纸没有可抽取的背景原图');
                return Promise.resolve(false);
            }
            return new Promise((resolve) => {
                const image = document.createElement('img');
                image.decoding = 'async';
                image.crossOrigin = 'anonymous';
                image.style.objectFit = context.getSettings().fit === 'contain' || context.getSettings().fit === 'fill'
                    ? context.getSettings().fit
                    : 'cover';
                let settled = false;
                let timer = null;
                const settle = (ok) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (timer) {
                        clearTimeout(timer);
                    }
                    image.removeEventListener('load', onLoad);
                    image.removeEventListener('error', onError);
                    resolve(ok);
                };
                const onLoad = () => {
                    if (isCancelled()) {
                        settle(true);
                        return;
                    }
                    media = image;
                    mediaWrap.append(image);
                    info.textContent = formatCaption(item, 'art');
                    startMotion();
                    refreshReadability();
                    settle(true);
                };
                const onError = () => {
                    pushDiag('单张原画', '背景原图加载失败（接口不可用或图片解码失败）');
                    settle(false);
                };
                // 请求卡住（服务不响应）时不能一直等，12 秒后按失败处理
                timer = setTimeout(() => {
                    pushDiag('单张原画', '背景原图 12 秒内没有返回');
                    settle(false);
                }, 12000);
                image.addEventListener('load', onLoad);
                image.addEventListener('error', onError);
                image.src = url;
                if (typeof image.complete === 'boolean' && image.complete && image.naturalWidth > 0) {
                    onLoad();
                }
            });
        };

        /*
         * 实时渲染失败、但兜底成功了：顶部弹一条提示，5 秒后自动收起。
         * 点「上报」= 导出日志 + 打开仓库的 issue 页面，然后把提示收掉。
         */
        const TOAST_MS = 5000;

        const clearSceneToast = () => {
            if (sceneToastTimer) {
                clearTimeout(sceneToastTimer);
                sceneToastTimer = 0;
            }
            if (sceneToast) {
                sceneToast.remove();
                sceneToast = null;
            }
        };

        const showSceneToast = (item, fallbackName) => {
            clearSceneToast();
            const report = buildFailureReport(item);

            const toast = document.createElement('div');
            toast.className = 'wp-eng-toast';

            const text = document.createElement('div');
            text.className = 'wp-eng-toast-text';
            const line = document.createElement('div');
            line.textContent = '实时渲染失败，已启用兜底服务';
            const sub = document.createElement('div');
            sub.className = 'wp-eng-toast-sub';
            sub.textContent = `当前显示：${fallbackName}。是否上报日志？`;
            text.append(line, sub);

            const reportBtn = document.createElement('button');
            reportBtn.type = 'button';
            reportBtn.textContent = '上报';
            reportBtn.addEventListener('click', () => {
                downloadErrorLog(report);
                openIssuePage(report);
                sub.textContent = '日志已导出，已打开仓库的 issue 页面';
                reportBtn.disabled = true;
                reportBtn.textContent = '已上报';
                clearTimeout(sceneToastTimer);
                sceneToastTimer = setTimeout(clearSceneToast, 1500);
            });

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'wp-eng-ghost';
            closeBtn.textContent = '不再提示';
            closeBtn.addEventListener('click', clearSceneToast);

            toast.append(text, reportBtn, closeBtn);
            root.append(toast);
            sceneToast = toast;
            // 下一帧再加 class，让过渡动画生效
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => toast.classList.add('wp-eng-in'));
            } else {
                toast.classList.add('wp-eng-in');
            }

            sceneToastTimer = setTimeout(clearSceneToast, TOAST_MS);
        };

        const clearSceneError = () => {
            if (sceneErrorCard) {
                sceneErrorCard.remove();
                sceneErrorCard = null;
            }
        };

        const buildFailureReport = (item) => {
            const settings = context.getSettings();
            const host = (() => {
                try {
                    return folium.host ?? {};
                } catch {
                    return {};
                }
            })();
            return {
                at: new Date().toISOString(),
                title: item.title,
                id: item.id,
                folia: host.folia ?? '未知',
                folium: host.folium ? `${host.folium.major}.${host.folium.minor}` : '未知',
                webgl: webglInfo(),
                ua: typeof navigator !== 'undefined' ? navigator.userAgent : '未知',
                settings: `sceneFps=${settings.sceneFps}, scripts=off, fit=${settings.fit}`,
                attempts: attempts.slice(),
                diag: diag.slice(),
            };
        };

        /*
         * 三层都失败：不再退官方预览图（那只是几百像素的 GIF），直接说清楚并给出出路。
         * 背景层本身是 pointer-events:none，错误卡用 pointer-events:auto 单独放开。
         */
        const showSceneError = (item) => {
            clearSceneError();
            teardownMedia();
            currentKey = null;
            paintReadability(0.06);

            const report = buildFailureReport(item);
            lastErrorReport = report;

            const wrap = document.createElement('div');
            wrap.className = 'wp-eng-error';
            const card = document.createElement('div');
            card.className = 'wp-eng-error-card';

            const title = document.createElement('div');
            title.className = 'wp-eng-error-title';
            title.textContent = '这张场景壁纸没能加载';
            const sub = document.createElement('div');
            sub.className = 'wp-eng-error-sub';
            sub.textContent = `${item.title}：实时渲染、合成静态图、单张原画都失败了。`;
            const status = document.createElement('div');
            status.className = 'wp-eng-error-status';

            const actions = document.createElement('div');
            actions.className = 'wp-eng-error-actions';
            const makeButton = (text, onClick) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = text;
                button.addEventListener('click', onClick);
                return button;
            };
            actions.append(
                makeButton('导出错误日志', () => {
                    status.textContent = downloadErrorLog(report)
                        ? '日志已导出到下载文件夹'
                        : '导出失败，可到「更多设置」里再试';
                }),
                makeButton('提交 Issue', () => {
                    status.textContent = openIssuePage(report)
                        ? '已打开仓库的 issue 页面，请把日志文件拖进去'
                        : '打开失败，可手动访问仓库的 Issues';
                }),
                makeButton('重试', () => {
                    clearSceneError();
                    render().catch(() => undefined);
                }),
            );

            card.append(title, sub, actions, status);
            wrap.append(card);
            root.append(wrap);
            sceneErrorCard = wrap;
            notifyPanel();
        };

        /*
         * 网页壁纸用 iframe 渲染。WE 的网页 API 由本地服务注入的垫片提供，
         * 这里把频谱与「正在播放」用 postMessage 推给它（iframe 是跨源的，
         * 只能走 postMessage）。
         */
        const pumpWebFrame = (frame) => {
            const left = new Float32Array(64);
            const right = new Float32Array(64);
            const post = (payload) => {
                try {
                    frame.contentWindow?.postMessage(payload, '*');
                } catch {
                    /* iframe 还没就绪 */
                }
            };
            const audioStop = typeof context.every === 'function'
                ? context.every(33, () => {
                    // 暂停时的衰减由 fillAudioFrames 统一处理
                    fillAudioFrames(left, right);
                    post({ __foliaWe: 1, kind: 'audio', values: Array.from(left).concat(Array.from(right)) });
                })
                : null;

            const sendMedia = () => {
                let state = null;
                try {
                    state = folium.playback?.getState?.() ?? null;
                } catch {
                    state = null;
                }
                const song = state?.song ?? null;
                let cover = null;
                try {
                    cover = context.getCoverUrl?.() ?? null;
                } catch {
                    cover = null;
                }
                const playing = state?.state === 'playing';
                post({
                    __foliaWe: 1,
                    kind: 'media',
                    media: {
                        title: song?.title ?? '',
                        artist: song?.artist ?? '',
                        album: song?.album ?? '',
                        albumArtist: song?.artist ?? '',
                        position: Number(state?.position) || 0,
                        duration: Number(state?.duration) || 0,
                        state: playing ? 1 : state?.state === 'paused' ? 2 : 0,
                        ...(cover ? { thumbnail: cover, hasThumbnail: true } : { hasThumbnail: false }),
                    },
                });
            };
            sendMedia();
            const mediaStop = typeof context.every === 'function' ? context.every(1000, sendMedia) : null;

            return () => {
                try {
                    audioStop?.();
                } catch {
                    /* 已释放 */
                }
                try {
                    mediaStop?.();
                } catch {
                    /* 已释放 */
                }
            };
        };

        const paintWebFrame = (item, settings) => {
            const frame = document.createElement('iframe');
            // 不给 allow-same-origin：壁纸页面拿不到本机服务的同源身份，
            // 也就没法借它读别的壁纸文件
            frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-forms');
            // 不给 autoplay 授权：壁纸自带 BGM 不该出声（垫片里还会再钉一次静音）
            frame.setAttribute('allow', 'fullscreen');
            frame.referrerPolicy = 'no-referrer';
            if (item.preview) {
                const poster = document.createElement('img');
                poster.src = httpUrl(library, item, item.preview) ?? toFileUrl(item.absPreview) ?? '';
                poster.style.objectFit = settings.fit === 'contain' || settings.fit === 'fill' ? settings.fit : 'cover';
                mediaWrap.append(poster);
                poster.addEventListener('error', () => {
                    poster.remove();
                }, { once: true });
            }
            frame.addEventListener('load', () => frame.classList.add('wp-eng-ready'), { once: true });
            frame.src = httpUrl(library, item, item.file) ?? 'about:blank';
            media = frame;
            mediaWrap.append(frame);
            const stopPump = pumpWebFrame(frame);
            cleanupMedia = () => {
                try {
                    stopPump();
                } catch {
                    /* 已释放 */
                }
                frame.src = 'about:blank';
            };
            startMotion();
            refreshReadability();
        };

        /*
         * 背景选择器里的「悬停预览」会把背景挂载起来拍一张快照。
         * 对场景壁纸来说这等于每次都起一个 WebGL 引擎去解析几十 MB 的包，
         * 鼠标划过去就卡一下。这里通过容器形态把它认出来，只画一张静态图。
         */
        const isPreviewSurface = () => {
            if (context.staticMode === true) {
                return true;
            }
            const element = container;
            if (!element || element.isConnected === false) {
                return true;
            }
            const width = Number(element.clientWidth) || 0;
            const height = Number(element.clientHeight) || 0;
            if (width > 0 && height > 0 && (width < 420 || height < 240)) {
                return true;
            }
            try {
                const style = typeof window !== 'undefined' && window.getComputedStyle
                    ? window.getComputedStyle(element)
                    : null;
                if (style) {
                    if (style.visibility === 'hidden' || style.display === 'none') {
                        return true;
                    }
                    const opacity = Number(style.opacity);
                    if (Number.isFinite(opacity) && opacity === 0) {
                        return true;
                    }
                }
                const rect = element.getBoundingClientRect?.();
                if (rect && typeof rect.bottom === 'number' && typeof window !== 'undefined') {
                    if (rect.bottom <= 0 || rect.right <= 0
                        || rect.top >= (window.innerHeight || 0) || rect.left >= (window.innerWidth || 0)) {
                        return true;
                    }
                }
            } catch {
                /* 取不到样式就按正式背景处理 */
            }
            return false;
        };

        /* 预览用的廉价渲染：只要能看出是什么就行，不启动引擎 */
        const paintPreviewStill = (item) => {
            const url = item.custom
                ? null
                : (httpUrl(library, item, item.preview) ?? toFileUrl(item.absPreview));
            if (url) {
                const image = document.createElement('img');
                image.src = url;
                image.style.objectFit = 'cover';
                media = image;
                mediaWrap.append(image);
                cleanupMedia = () => {
                    image.removeAttribute('src');
                };
                return true;
            }
            const art = item.custom ? item.url : artUrl(library, item);
            if (art) {
                const image = document.createElement('img');
                image.src = art;
                image.style.objectFit = 'cover';
                media = image;
                mediaWrap.append(image);
                cleanupMedia = () => {
                    image.removeAttribute('src');
                };
                return true;
            }
            return false;
        };

        const show = (item) => {
            if (!item) {
                return;
            }
            const settings = context.getSettings();

            // 自定义背景：URL 由宿主的 file 协议给出，已经支持 Range，直接喂给媒体元素
            if (item.custom) {
                if (item.live === 'video') {
                    const video = document.createElement('video');
                    video.muted = true;
                    video.loop = true;
                    video.autoplay = true;
                    video.playsInline = true;
                    video.preload = 'auto';
                    // 宿主的 folia-mod://_files 不返回 CORS 头，加 crossOrigin 反而会加载失败；
                    // 代价是画布会被污染，没法采样亮度，改用中性估值
                    video.style.objectFit = settings.fit === 'contain' || settings.fit === 'fill' ? settings.fit : 'cover';
                    media = video;
                    customMedia = true;
                    mediaWrap.append(video);
                    const onReady = () => {
                        refreshReadability();
                        if (context.isPaused() && settings.syncPause) {
                            return;
                        }
                        video.play().catch(() => undefined);
                    };
                    // 容器能读、编码解不了（例如 avi / wmv）时给出明确提示，而不是留一块黑
                    video.addEventListener('error', () => {
                        info.textContent = `${item.title} · 这个视频格式解不了（支持 mp4 / m4v / webm / mov）`;
                        info.classList.add('wp-eng-visible');
                        paintReadability(0.34);
                    }, { once: true });
                    video.addEventListener('loadeddata', onReady);
                    video.addEventListener('seeked', refreshReadability);
                    video.src = item.url;
                    cleanupMedia = () => {
                        video.removeEventListener('loadeddata', onReady);
                        video.removeEventListener('seeked', refreshReadability);
                        video.removeAttribute('src');
                        video.load();
                    };
                    return;
                }

                const image = document.createElement('img');
                image.decoding = 'async';
                image.style.objectFit = settings.fit === 'contain' || settings.fit === 'fill' ? settings.fit : 'cover';
                image.addEventListener('error', () => {
                    info.textContent = `${item.title} · 这个图片格式读不出来`;
                    info.classList.add('wp-eng-visible');
                    paintReadability(0.34);
                }, { once: true });
                media = image;
                customMedia = true;
                mediaWrap.append(image);
                const onLoad = () => refreshReadability();
                image.addEventListener('load', onLoad);
                image.src = item.url;
                cleanupMedia = () => {
                    image.removeEventListener('load', onLoad);
                };
                return;
            }

            const live = item.live;
            if (live === 'video' && item.file) {
                const video = document.createElement('video');
                video.muted = true;
                video.loop = true;
                video.autoplay = true;
                video.playsInline = true;
                video.preload = 'auto';
                video.crossOrigin = 'anonymous';
                video.style.objectFit = settings.fit === 'contain' || settings.fit === 'fill' ? settings.fit : 'cover';
                media = video;
                mediaWrap.append(video);
                const detach = attachWithFallback(
                    video,
                    httpUrl(library, item, item.file),
                    toFileUrl(item.absFile),
                );
                const onReady = () => {
                    refreshReadability();
                    if (context.isPaused() && settings.syncPause) {
                        return;
                    }
                    video.play().catch(() => undefined);
                };
                video.addEventListener('loadeddata', onReady);
                video.addEventListener('seeked', refreshReadability);
                cleanupMedia = () => {
                    detach();
                    video.removeEventListener('loadeddata', onReady);
                    video.removeEventListener('seeked', refreshReadability);
                };
                return;
            }

            if (live === 'web' && item.file) {
                paintWebFrame(item, settings);
                return;
            }

            // 兜底只到「单张原画」为止；场景壁纸不再使用官方预览图（那只是几百像素的 GIF）
            const sources = [];
            const sharpArt = artUrl(library, item);
            if (sharpArt) {
                sources.push({ url: sharpArt, sharp: true });
            }
            if (item.kind !== 'scene') {
                const previewOverHttp = httpUrl(library, item, item.preview);
                if (previewOverHttp) {
                    sources.push({ url: previewOverHttp, sharp: false });
                }
                const previewOverFile = toFileUrl(item.absPreview);
                if (previewOverFile) {
                    sources.push({ url: previewOverFile, sharp: false });
                }
            }

            const paintStill = () => {
                const image = document.createElement('img');
                image.decoding = 'async';
                image.crossOrigin = 'anonymous';
                image.style.objectFit = settings.fit === 'contain' || settings.fit === 'fill' ? settings.fit : 'cover';
                media = image;
                mediaWrap.append(image);
                const detach = attachChain(image, sources, (index) => {
                    info.textContent = formatCaption(item, sources[index]?.sharp === true ? 'art' : 'preview');
                    refreshReadability();
                });
                cleanupMedia = detach;
            };

            // 场景壁纸：实时渲染 → 合成静态图 → 单张原画；三层都不行就报错（不再退预览图）
            if (item.kind === 'scene') {
                let cancelled = false;
                stopLive = [];
                const runStops = () => {
                    const pending = stopLive ?? [];
                    stopLive = null;
                    pending.forEach((stop) => {
                        try {
                            stop();
                        } catch {
                            /* 单项失败不影响其余 */
                        }
                    });
                };
                const run = async () => {
                    const liveOk = await liveScene(item, settings, () => cancelled || disposed, (stop) => {
                        if (stopLive) {
                            stopLive.push(stop);
                        } else {
                            stop();
                        }
                    });
                    let fallback = null;
                    if (!liveOk && !cancelled && !disposed) {
                        fallback = await compositeScene(item, () => cancelled || disposed) ? '合成静态图' : null;
                    }
                    if (!liveOk && !fallback && !cancelled && !disposed) {
                        fallback = await paintSceneArt(item, () => cancelled || disposed) ? '单张原画' : null;
                    }
                    if (cancelled || disposed) {
                        return;
                    }
                    if (liveOk || fallback) {
                        lastErrorReport = null;
                    }
                    if (!liveOk && fallback) {
                        // 实时渲染没成，但画面还有：顶部提示一次，5 秒后自己收
                        showSceneToast(item, fallback);
                        return;
                    }
                    // 只有三层全都没成才报错。liveOk 时 fallback 本来就是 null，
                    // 之前写成 `if (!fallback)` 会把渲染成功的场景也拆掉换成错误卡。
                    if (!liveOk && !fallback) {
                        showSceneError(item);
                    }
                };
                run().catch((error) => {
                    pushDiag('加载流程', `未捕获的异常：${error?.message ?? error}`);
                    if (!cancelled && !disposed) {
                        showSceneError(item);
                    }
                });
                cleanupMedia = () => {
                    cancelled = true;
                    runStops();
                };
                return;
            }

            if (sources.length === 0) {
                paintReadability(0.06);
                return;
            }
            paintStill();
            return;

            paintReadability(0.06);
        };

        const render = async () => {
            if (disposed) {
                return;
            }
            clearSceneError();
            clearSceneToast();
            const settings = context.getSettings();

            // 选择器预览：不碰引擎，只铺一张静态图
            if (isPreviewSurface()) {
                const previewSelection = await readState();
                let previewItem;
                if (settings.library === 'custom') {
                    library = null;
                    previewItem = chooseCustom(await resolveCustom(false), settings, context, previewSelection);
                } else {
                    library = await loadLibrary(false);
                    previewItem = chooseWallpaper(library, settings, context, previewSelection);
                }
                if (disposed) {
                    return;
                }
                if (!previewItem) {
                    return;
                }
                const previewKey = `preview:${previewItem.id ?? previewItem.grantId}`;
                if (previewKey === currentKey) {
                    return;
                }
                currentKey = previewKey;
                teardownMedia();
                paintPreviewStill({
                    ...previewItem,
                    custom: Boolean(previewItem.grantId),
                    url: previewItem.url,
                });
                return;
            }
            selection = await readState();
            if (disposed) {
                return;
            }

            if (settings.library === 'custom') {
                const entries = await resolveCustom(false);
                if (disposed) {
                    return;
                }
                library = null;
                const choice = chooseCustom(entries, settings, context, selection);
                if (!choice) {
                    teardownMedia();
                    currentKey = null;
                    paintReadability(0.06);
                    info.textContent = '我的文件：还没添加图片或视频（右侧「更多设置」里添加）';
                    info.classList.add('wp-eng-visible');
                    return;
                }
                const item = {
                    id: `custom:${choice.grantId}`,
                    title: choice.name,
                    live: choice.kind === 'video' ? 'video' : 'image',
                    custom: true,
                    url: choice.url,
                };
                info.classList.remove('wp-eng-visible');
                info.textContent = formatCaption(item, false);
                if (item.id === currentKey && media) {
                    applyFilters();
                    return;
                }
                currentKey = item.id;
                teardownMedia();
                show(item);
                applyFilters();
                return;
            }

            library = await loadLibrary(false);
            if (disposed) {
                return;
            }
            selection = await readState();
            if (disposed) {
                return;
            }
            const item = chooseWallpaper(library, settings, context, selection);
            if (!item) {
                paintReadability(0.06);
                info.textContent = library?.error ? '壁纸引擎：未找到壁纸库' : '壁纸引擎：没有可用壁纸';
                info.classList.add('wp-eng-visible');
                return;
            }
            info.textContent = formatCaption(item, false);
            if (item.id === currentKey && media) {
                applyFilters();
                return;
            }
            currentKey = item.id;
            teardownMedia();
            show(item);
            applyFilters();
        };

        const formatCaption = (item, mode) => {
            const kindText = item.custom
                ? (item.live === 'video' ? '我的视频' : '我的图片')
                : item.live === 'video'
                    ? '视频'
                    : item.live === 'web'
                        ? '网页'
                        : mode === 'live'
                            ? '实时场景'
                            : mode === 'composited'
                                ? '合成场景'
                                : mode === 'art' ? '原画' : '预览图';
            return `${item.title} · ${kindText}`;
        };

        /*
         * 防抖：设置面板里拖滑杆、壁纸选择器里连续换项都会连着触发通知，
         * 每一次都重挂一个引擎就是「切壁纸卡一下」的主要来源。
         */
        let renderTimer = 0;
        const scheduleRender = () => {
            if (renderTimer) {
                clearTimeout(renderTimer);
            }
            renderTimer = setTimeout(() => {
                renderTimer = 0;
                render().catch((error) => console.warn('[壁纸引擎] 更新失败', error));
            }, 160);
        };

        const onSelectionChange = () => {
            scheduleRender();
        };
        listeners.add(onSelectionChange);

        render().catch((error) => console.warn('[壁纸引擎] 挂载失败', error));

        /*
         * 设置变了、切歌了、播放/暂停了，宿主都会通知。
         * Folium 2 把 ctx.subscribe 改名成 ctx.onChange（旧名会打弃用警告），
         * 这里优先用新名，老宿主上再退回旧名。
         */
        const contextOnChange = typeof context.onChange === 'function'
            ? context.onChange
            : (typeof context.subscribe === 'function' ? context.subscribe : null);
        const stopSettings = contextOnChange ? contextOnChange.call(context, scheduleRender) : null;

        // 场景的鼠标视差：把窗口指针位置喂给引擎（u/v 归一化）
        const onPointerMove = (event) => {
            if (!liveInstance || typeof liveInstance.pushPointer !== 'function') {
                return;
            }
            try {
                liveInstance.pushPointer(
                    event.clientX / Math.max(1, window.innerWidth),
                    event.clientY / Math.max(1, window.innerHeight),
                    event.buttons ?? 0,
                    (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0),
                );
            } catch {
                /* 引擎还没装配完 */
            }
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pointermove', onPointerMove, { passive: true });
        }

        // 视频帧在变，每 2.5 秒重测一次；静态图不需要
        const stopSampling = context.every(2500, () => {
            if (media && media.tagName === 'VIDEO') {
                refreshReadability();
            }
        });

        const stopResize = context.onResize((size) => {
            // 预览容器被撑成正式尺寸（或反过来）时，需要重新决定走哪条路径
            const previewNow = isPreviewSurface();
            const previewRendered = typeof currentKey === 'string' && currentKey.startsWith('preview:');
            if (previewNow !== previewRendered) {
                scheduleRender();
                return;
            }
            if (size.width > 0 && size.height > 0) {
                refreshReadability();
            }
        });

        return () => {
            disposed = true;
            listeners.delete(onSelectionChange);
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('pointermove', onPointerMove);
            }
            (stopLive ?? []).forEach((stop) => {
                try {
                    stop();
                } catch {
                    /* 单项失败不影响其余 */
                }
            });
            stopLive = null;
            try {
                stopSettings?.();
            } catch {
                /* 已经释放 */
            }
            try {
                stopSampling?.();
            } catch {
                /* 已经释放 */
            }
            try {
                stopResize?.();
            } catch {
                /* 已经释放 */
            }
            if (renderTimer) {
                clearTimeout(renderTimer);
                renderTimer = 0;
            }
            clearSceneError();
            clearSceneToast();
            teardownMedia();
            style.remove();
            root.remove();
        };
    };

    // -----------------------------------------------------------------------
    // 设置面板（背景类型右侧「更多设置」里）
    // -----------------------------------------------------------------------

    const mountSettingsPanel = (container, panelContext) => {
        const state = { tab: 'wallpaper', query: '', busy: false, message: '' };

        const style = document.createElement('style');
        style.textContent = `
            .wp-eng-panel { display: flex; flex-direction: column; gap: 12px; font-family: "Microsoft YaHei UI", system-ui, sans-serif; }
            .wp-eng-panel * { box-sizing: border-box; }
            .wp-eng-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
            .wp-eng-tabs { display: flex; gap: 4px; padding: 3px; border-radius: 10px; }
            .wp-eng-tab { flex: 1; padding: 6px 10px; border-radius: 8px; border: 0; cursor: pointer; font-size: 12px; font-weight: 500; background: transparent; }
            .wp-eng-seg { display: flex; gap: 4px; padding: 3px; border-radius: 10px; }
            .wp-eng-seg button { flex: 1; padding: 7px 8px; border-radius: 8px; border: 0; cursor: pointer; font-size: 12px; background: transparent; }
            .wp-eng-hint { font-size: 11px; line-height: 1.6; opacity: 0.55; }
            .wp-eng-btn { padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 11.5px; border: 0; }
            .wp-eng-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; max-height: 268px; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; }
            .wp-eng-card { position: relative; border-radius: 10px; overflow: hidden; cursor: pointer; border: 2px solid transparent; background: #111; aspect-ratio: 16 / 9; }
            .wp-eng-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
            .wp-eng-card .wp-eng-name { position: absolute; inset: auto 0 0 0; padding: 12px 5px 4px; font-size: 10px; line-height: 1.3; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,0.85)); max-height: 46px; overflow: hidden; }
            .wp-eng-card .wp-eng-kind { position: absolute; top: 4px; right: 4px; font-size: 9px; padding: 1px 5px; border-radius: 999px; background: rgba(0,0,0,0.6); color: #fff; }
            .wp-eng-field { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; }
            .wp-eng-field label { font-size: 11.5px; opacity: 0.85; }
            .wp-eng-field input[type="range"] { grid-column: 1 / -1; width: 100%; }
            .wp-eng-field .wp-eng-value { font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.6; }
            .wp-eng-empty { padding: 18px 12px; text-align: center; font-size: 11.5px; opacity: 0.6; line-height: 1.8; }
            .wp-eng-card .wp-eng-del {
                position: absolute; top: 4px; left: 4px; width: 18px; height: 18px; padding: 0;
                border: 0; border-radius: 999px; cursor: pointer; line-height: 1;
                background: rgba(0, 0, 0, 0.62); color: #fff; font-size: 12px;
            }
            .wp-eng-card video { width: 100%; height: 100%; object-fit: cover; display: block; }
            .wp-eng-card.wp-eng-missing { opacity: 0.45; }
        `;
        const root = document.createElement('div');
        root.className = 'wp-eng-panel';
        container.append(style, root);

        const themeColors = () => {
            try {
                const theme = panelContext.getTheme();
                return {
                    text: theme?.primaryColor ?? '#f5f5f5',
                    muted: theme?.secondaryColor ?? '#a1a1aa',
                    accent: theme?.accentColor ?? '#ffffff',
                    surface: theme?.backgroundColor ?? '#0b0b0f',
                };
            } catch {
                return { text: '#f5f5f5', muted: '#a1a1aa', accent: '#ffffff', surface: '#0b0b0f' };
            }
        };

        const mix = (hex, amount) => {
            const rgb = hexToRgb(hex) ?? [20, 20, 24];
            const target = amount >= 0 ? 255 : 0;
            const ratio = Math.abs(amount);
            return `rgb(${rgb.map((value) => Math.round(value + (target - value) * ratio)).join(', ')})`;
        };

        const el = (tag, options = {}) => {
            const node = document.createElement(tag);
            if (options.className) {
                node.className = options.className;
            }
            if (options.text !== undefined) {
                node.textContent = options.text;
            }
            if (options.attrs) {
                Object.entries(options.attrs).forEach(([key, value]) => node.setAttribute(key, value));
            }
            if (options.style) {
                node.style.cssText = options.style;
            }
            return node;
        };

        const paint = () => {
            const colors = themeColors();
            const settings = panelContext.settings.get();
            root.replaceChildren();
            root.style.color = colors.text;
            root.style.setProperty('--wp-muted', colors.muted);

            // 顶部：标题 + 库状态
            const head = el('div', { className: 'wp-eng-row', style: 'justify-content: space-between;' });
            const title = el('div', {
                style: 'font-size: 13px; font-weight: 600;',
                text: `壁纸引擎 · ${libraryCache?.items?.length ?? 0} 张`,
            });
            const tools = el('div', { className: 'wp-eng-row' });
            const refresh = el('button', {
                className: 'wp-eng-btn',
                text: state.busy ? '扫描中…' : '重新扫描',
                style: `background: ${mix(colors.text, -0.86)}; color: ${colors.text}; border: 1px solid ${mix(colors.text, -0.8)};`,
            });
            refresh.addEventListener('click', async () => {
                if (state.busy) {
                    return;
                }
                state.busy = true;
                state.message = '正在扫描 Steam 与 Wallpaper Engine…';
                paint();
                await loadLibrary(true);
                state.busy = false;
                state.message = libraryCache?.ok
                    ? `找到 ${libraryCache.items.length} 张壁纸`
                    : (libraryCache?.error ?? '未找到壁纸库');
                paint();
            });
            tools.append(refresh);
            head.append(title, tools);
            root.append(head);

            // 标签页
            const tabs = el('div', { className: 'wp-eng-tabs', style: `background: ${mix(colors.text, -0.88)};` });
            [['wallpaper', '壁纸'], ['display', '显示']].forEach(([key, text]) => {
                const tab = el('button', {
                    className: 'wp-eng-tab',
                    text,
                    style: state.tab === key
                        ? `background: ${mix(colors.text, -0.72)}; color: ${colors.text};`
                        : `color: ${colors.muted};`,
                });
                tab.addEventListener('click', () => {
                    state.tab = key;
                    paint();
                });
                tabs.append(tab);
            });
            root.append(tabs);

            if (state.message) {
                root.append(el('div', { className: 'wp-eng-hint', text: state.message }));
            }

            if (state.tab === 'wallpaper') {
                paintWallpaperTab(colors, settings);
            } else {
                paintDisplayTab(colors, settings);
            }
        };

        /* 场景加载失败的常驻提示：背景上的按钮点不到时，这里也能导出日志 */
        const paintErrorBanner = (colors) => {
            const report = lastErrorReport;
            if (!report) {
                return;
            }
            const box = el('div', {
                style: `border: 1px solid ${mix(colors.text, -0.72)}; background: ${mix(colors.text, -0.9)}; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;`,
            });
            box.append(el('div', {
                style: `font-size: 12px; font-weight: 600; color: ${colors.text};`,
                text: '场景壁纸加载失败',
            }));
            box.append(el('div', {
                className: 'wp-eng-hint',
                text: `${report.title}：实时渲染、合成静态图、单张原画都失败了。${report.diag.length} 条诊断已记录。`,
            }));
            const actions = el('div', { className: 'wp-eng-row' });
            const exportBtn = el('button', {
                className: 'wp-eng-btn',
                text: '导出错误日志',
                style: `background: ${mix(colors.text, -0.78)}; color: ${colors.text};`,
            });
            const issueBtn = el('button', {
                className: 'wp-eng-btn',
                text: '提交 Issue',
                style: `background: transparent; color: ${colors.text}; border: 1px solid ${mix(colors.text, -0.72)};`,
            });
            const dismiss = el('button', {
                className: 'wp-eng-btn',
                text: '收起',
                style: `background: transparent; color: ${colors.muted};`,
            });
            exportBtn.addEventListener('click', () => {
                state.message = downloadErrorLog(report) ? '日志已导出到下载文件夹' : '导出失败';
                paint();
            });
            issueBtn.addEventListener('click', () => {
                state.message = openIssuePage(report)
                    ? '已打开仓库的 issue 页面，请把日志文件拖进去'
                    : '打开失败，可手动访问仓库的 Issues';
                paint();
            });
            dismiss.addEventListener('click', () => {
                lastErrorReport = null;
                paint();
            });
            actions.append(exportBtn, issueBtn, dismiss);
            box.append(actions);
            root.append(box);
        };

        const paintWallpaperTab = (colors, settings) => {
            // 先选来源：壁纸引擎库，还是自己添加的图片 / 视频
            const sources = [
                ['we', '壁纸引擎库'],
                ['custom', '我的文件'],
            ];
            const sourceSeg = el('div', { className: 'wp-eng-seg', style: `background: ${mix(colors.text, -0.88)};` });
            sources.forEach(([value, text]) => {
                const button = el('button', {
                    text,
                    style: (settings.library ?? 'we') === value
                        ? `background: ${mix(colors.text, -0.72)}; color: ${colors.text};`
                        : `color: ${colors.muted};`,
                });
                button.addEventListener('click', () => {
                    panelContext.settings.set({ library: value });
                    paint();
                });
                sourceSeg.append(button);
            });
            root.append(sourceSeg);

            paintErrorBanner(colors);

            if ((settings.library ?? 'we') === 'custom') {
                paintCustomTab(colors, settings);
                return;
            }

            const modes = [
                ['random', '伪随机'],
                ['fixed', '指定'],
                ['desktop', '跟随桌面'],
            ];
            const segmented = el('div', { className: 'wp-eng-seg', style: `background: ${mix(colors.text, -0.88)};` });
            modes.forEach(([value, text]) => {
                const button = el('button', {
                    text,
                    style: value === settings.mode
                        ? `background: ${mix(colors.text, -0.72)}; color: ${colors.text};`
                        : `color: ${colors.muted};`,
                });
                button.addEventListener('click', () => {
                    panelContext.settings.set({ mode: value });
                    paint();
                });
                segmented.append(button);
            });
            root.append(segmented);

            if (settings.mode === 'fixed') {
                paintPicker(colors, settings);
            } else if (settings.mode === 'desktop') {
                const current = libraryCache?.items?.find((item) => item.id === libraryCache?.currentId);
                root.append(el('div', {
                    className: 'wp-eng-hint',
                    text: current
                        ? `跟随 Wallpaper Engine 当前桌面壁纸：${current.title}（在 Wallpaper Engine 里换壁纸后重新扫描即可同步）`
                        : 'Wallpaper Engine 里没有读到当前桌面壁纸，会临时改用伪随机。',
                }));
            } else {
                paintRandomControls(colors, settings);
            }
        };

        const paintRandomControls = (colors, settings) => {
            const box = el('div', { style: 'display: flex; flex-direction: column; gap: 10px;' });

            const reshuffleRow = el('div', { className: 'wp-eng-row', style: 'justify-content: space-between;' });
            reshuffleRow.append(el('span', { style: 'font-size: 11.5px; opacity: .85;', text: '重新抽取时机' }));
            const select = el('select', {
                style: `background: ${mix(colors.text, -0.86)}; color: ${colors.text}; border: 1px solid ${mix(colors.text, -0.78)}; border-radius: 8px; padding: 5px 8px; font-size: 11.5px;`,
            });
            [['song', '每次切歌'], ['hour', '每小时'], ['session', '每次启动']].forEach(([value, text]) => {
                const option = el('option', { text, attrs: { value } });
                option.value = value;
                if (settings.reshuffle === value) {
                    option.selected = true;
                }
                select.append(option);
            });
            select.addEventListener('change', () => {
                panelContext.settings.set({ reshuffle: select.value });
            });
            reshuffleRow.append(select);
            box.append(reshuffleRow);

            const seedRow = el('div', { className: 'wp-eng-row', style: 'justify-content: space-between;' });
            seedRow.append(el('span', { style: 'font-size: 11.5px; opacity: .85;', text: '随机种子' }));
            const seed = el('input', {
                attrs: { type: 'number', min: '0', step: '1' },
                style: `width: 112px; background: ${mix(colors.text, -0.86)}; color: ${colors.text}; border: 1px solid ${mix(colors.text, -0.78)}; border-radius: 8px; padding: 5px 8px; font-size: 11.5px; text-align: right;`,
            });
            seed.value = String(settings.seed ?? 0);
            seed.addEventListener('change', () => {
                panelContext.settings.set({ seed: Number(seed.value) || 0 });
                notify();
            });
            seedRow.append(seed);
            box.append(seedRow);

            const liveRow = el('div', { className: 'wp-eng-row', style: 'justify-content: space-between;' });
            liveRow.append(el('span', { style: 'font-size: 11.5px; opacity: .85;', text: '只从动态壁纸里抽' }));
            liveRow.append(toggle(colors, settings.liveOnly, (value) => {
                panelContext.settings.set({ liveOnly: value });
                paint();
            }));
            box.append(liveRow);

            box.append(el('div', {
                className: 'wp-eng-hint',
                text: `同一首歌 + 同一种子 = 同一张壁纸。当前会从 ${libraryCache?.items?.filter((item) => (settings.liveOnly ? item.live : true)).length ?? 0} 张里抽。`,
            }));
            root.append(box);
        };

        const paintPicker = (colors, settings) => {
            const items = libraryCache?.items ?? [];
            if (items.length === 0) {
                root.append(el('div', {
                    className: 'wp-eng-empty',
                    text: libraryCache?.error
                        ? `没读到壁纸库：${libraryCache.error}`
                        : '没有扫描到壁纸。确认 Wallpaper Engine 至少订阅或导入过一张壁纸。',
                }));
                return;
            }

            const search = el('input', {
                attrs: { type: 'search', placeholder: '搜索壁纸名…' },
                style: `width: 100%; background: ${mix(colors.text, -0.88)}; color: ${colors.text}; border: 1px solid ${mix(colors.text, -0.8)}; border-radius: 8px; padding: 6px 9px; font-size: 11.5px;`,
            });
            search.value = state.query;
            search.addEventListener('input', () => {
                state.query = search.value;
                renderGrid();
            });
            root.append(search);

            const grid = el('div', { className: 'wp-eng-grid' });

            const renderGrid = () => {
                grid.replaceChildren();
                const keyword = state.query.trim().toLowerCase();
                const filtered = items.filter((item) => !keyword || item.title.toLowerCase().includes(keyword));
                if (filtered.length === 0) {
                    grid.append(el('div', { className: 'wp-eng-empty', text: '没有匹配的壁纸' }));
                    return;
                }
                filtered.forEach((item) => {
                    const card = el('div', {
                        className: 'wp-eng-card',
                        style: `border-color: ${item.id === readSelectionId() ? colors.accent : 'transparent'};`,
                        attrs: { title: `${item.title}${item.tags.length ? `\n${item.tags.join(' · ')}` : ''}` },
                    });
                    const previewSrc = httpUrl(libraryCache, item, item.preview) ?? toFileUrl(item.absPreview);
                    if (previewSrc) {
                        const image = el('img', { attrs: { src: previewSrc, loading: 'lazy' } });
                        image.addEventListener('error', () => image.remove(), { once: true });
                        card.append(image);
                    }
                    card.append(el('div', {
                        className: 'wp-eng-kind',
                        text: item.live === 'video' ? '视频' : item.live === 'web' ? '网页' : '场景',
                    }));
                    card.append(el('div', { className: 'wp-eng-name', text: item.title }));
                    card.addEventListener('click', () => {
                        writeState({ wallpaperId: item.id }).then(() => {
                            if (panelContext.settings.get().mode !== 'fixed') {
                                panelContext.settings.set({ mode: 'fixed' });
                            }
                            paint();
                        });
                    });
                    grid.append(card);
                });
            };

            renderGrid();
            root.append(grid);
            root.append(el('div', {
                className: 'wp-eng-hint',
                text: '「场景」是 Wallpaper Engine 的多层 2.5D 壁纸，画面封在 scene.pkg 里。这里按原图层顺序把各层贴图叠回完整画面（4K 级），叠加角色与前景都在；只有特效/着色器那一层无法还原。',
            }));
        };

        /*
         * 「我的文件」页：添加 / 删除自己的图片与视频。
         * 文件通过宿主的系统对话框选择，模组只拿到会话 URL 与可跨重启恢复的 grantId，
         * 看不到真实路径；文件被移走后，下次挂载会把对应条目自动剪掉。
         */
        const paintCustomTab = (colors, settings) => {
            const box = el('div', { style: 'display: flex; flex-direction: column; gap: 10px;' });

            const actions = el('div', { className: 'wp-eng-row' });
            const addImage = el('button', {
                className: 'wp-eng-btn',
                text: '添加图片',
                style: `background: ${mix(colors.text, -0.8)}; color: ${colors.text};`,
            });
            const addVideo = el('button', {
                className: 'wp-eng-btn',
                text: '添加视频',
                style: `background: ${mix(colors.text, -0.8)}; color: ${colors.text};`,
            });
            const busy = () => state.busy;
            addImage.addEventListener('click', () => pickCustom('image'));
            addVideo.addEventListener('click', () => pickCustom('video'));
            const addOther = el('button', {
                className: 'wp-eng-btn',
                text: '其他格式',
                style: `background: transparent; color: ${colors.muted}; border: 1px solid ${mix(colors.text, -0.78)};`,
                attrs: { title: 'bmp / svg / ico 等对话框里没有列出的扩展名' },
            });
            addOther.addEventListener('click', () => pickCustom('any'));
            actions.append(addImage, addVideo, addOther);
            box.append(actions);

            const grid = el('div', { className: 'wp-eng-grid' });
            box.append(grid);
            root.append(box);

            const entries = customCache ?? [];
            if (entries.length === 0) {
                grid.append(el('div', {
                    className: 'wp-eng-empty',
                    text: '还没有添加文件。\n点上面的按钮选图片或视频；它们会作为背景直接铺满播放页。',
                }));
            }

            entries.forEach((entry) => {
                const selected = entry.grantId === readSelection().customId;
                const card = el('div', {
                    className: 'wp-eng-card',
                    style: `border-color: ${selected ? colors.accent : 'transparent'};`,
                    attrs: { title: entry.name },
                });

                if (entry.kind === 'video') {
                    const video = el('video', { attrs: { muted: '', playsinline: '', preload: 'metadata' } });
                    video.muted = true;
                    video.src = entry.url;
                    card.append(video);
                } else {
                    const image = el('img', { attrs: { src: entry.url, loading: 'lazy' } });
                    image.addEventListener('error', () => image.remove(), { once: true });
                    card.append(image);
                }

                card.append(el('div', { className: 'wp-eng-kind', text: entry.kind === 'video' ? '视频' : '图片' }));
                card.append(el('div', { className: 'wp-eng-name', text: entry.name }));

                const del = el('button', { className: 'wp-eng-del', text: '×', attrs: { title: '移除这个文件' } });
                del.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    del.disabled = true;
                    await removeCustomFile(entry.grantId);
                    await resolveCustom(true);
                    if (readSelection().customId === entry.grantId) {
                        await writeState({ customId: null });
                    }
                    state.message = `已移除 ${entry.name}`;
                    paint();
                });
                card.append(del);

                card.addEventListener('click', async () => {
                    await writeState({ customId: entry.grantId });
                    if (panelContext.settings.get().mode !== 'fixed') {
                        panelContext.settings.set({ mode: 'fixed' });
                    }
                    paint();
                });
                grid.append(card);
            });

            const modeHint = settings.mode === 'fixed'
                ? '当前是「指定」：点一张卡片就用它。'
                : settings.mode === 'desktop'
                    ? '「跟随桌面」只对 Wallpaper Engine 有意义，这里会按伪随机抽。'
                    : '当前是「伪随机」：按种子和切歌抽，点卡片可改成指定这一张。';
            root.append(el('div', { className: 'wp-eng-hint', text: modeHint }));
            root.append(el('div', {
                className: 'wp-eng-hint',
                text: '图片：PNG / JPG / WebP / GIF / AVIF（「其他格式」还能选 BMP / SVG / ICO / TIFF）；视频：MP4 / M4V / WebM / MOV / MKV（「其他格式」还能选 AVI / WMV / FLV / TS，能否播放取决于浏览器解码器）。文件只按路径引用，移动或删除后需要重新添加。',
            }));
        };

        const pickCustom = async (kind) => {
            if (state.busy) {
                return;
            }
            state.busy = true;
            state.message = '';
            paint();
            let added = null;
            try {
                added = await addCustomFile(kind);
            } catch (error) {
                state.message = `添加失败：${error && error.message ? error.message : error}`;
            }
            state.busy = false;
            if (added) {
                await resolveCustom(true);
                await writeState({ customId: added.grantId });
                if (panelContext.settings.get().mode !== 'fixed') {
                    panelContext.settings.set({ mode: 'fixed' });
                }
                state.message = `已添加 ${added.name}`;
            }
            paint();
        };

        const paintDisplayTab = (colors, settings) => {
            const schema = panelContext.settings.schema ?? [];
            const skipped = new Set(['library', 'mode', 'seed', 'reshuffle', 'liveOnly']);
            const box = el('div', { style: 'display: flex; flex-direction: column; gap: 12px;' });

            schema.filter((field) => !skipped.has(field.key)).forEach((field) => {
                const value = settings[field.key];
                if (field.type === 'number') {
                    const row = el('div', { className: 'wp-eng-field' });
                    row.append(el('label', { text: i18nText(field.label, field.key) }));
                    const readout = el('span', { className: 'wp-eng-value', text: String(value) });
                    row.append(readout);
                    const range = el('input', {
                        attrs: { type: 'range', min: String(field.min ?? 0), max: String(field.max ?? 1), step: String(field.step ?? 0.01) },
                        style: `accent-color: ${colors.accent};`,
                    });
                    range.value = String(value);
                    range.addEventListener('input', () => {
                        readout.textContent = range.value;
                    });
                    range.addEventListener('change', () => {
                        panelContext.settings.set({ [field.key]: Number(range.value) });
                    });
                    row.append(range);
                    box.append(row);
                } else if (field.type === 'boolean') {
                    const row = el('div', { className: 'wp-eng-row', style: 'justify-content: space-between;' });
                    const labelWrap = el('div', { style: 'display: flex; flex-direction: column; gap: 2px;' });
                    labelWrap.append(el('span', { style: 'font-size: 11.5px; opacity: .85;', text: i18nText(field.label, field.key) }));
                    const description = field.description ? i18nText(field.description, '') : '';
                    if (description) {
                        labelWrap.append(el('span', { className: 'wp-eng-hint', text: description }));
                    }
                    row.append(labelWrap);
                    row.append(toggle(colors, value === true, (next) => {
                        panelContext.settings.set({ [field.key]: next });
                        paint();
                    }));
                    box.append(row);
                } else if (field.type === 'select') {
                    const row = el('div', { className: 'wp-eng-row', style: 'justify-content: space-between;' });
                    row.append(el('span', { style: 'font-size: 11.5px; opacity: .85;', text: i18nText(field.label, field.key) }));
                    const select = el('select', {
                        style: `background: ${mix(colors.text, -0.86)}; color: ${colors.text}; border: 1px solid ${mix(colors.text, -0.78)}; border-radius: 8px; padding: 5px 8px; font-size: 11.5px;`,
                    });
                    (field.options ?? []).forEach((option) => {
                        const node = el('option', { text: i18nText(option.label, option.value) });
                        node.value = option.value;
                        if (value === option.value) {
                            node.selected = true;
                        }
                        select.append(node);
                    });
                    select.addEventListener('change', () => {
                        panelContext.settings.set({ [field.key]: select.value });
                    });
                    row.append(select);
                    box.append(row);
                }
            });

            const reset = el('button', {
                className: 'wp-eng-btn',
                text: '恢复默认显示设置',
                style: `align-self: flex-start; background: ${mix(colors.text, -0.86)}; color: ${colors.muted}; border: 1px solid ${mix(colors.text, -0.8)};`,
            });
            reset.addEventListener('click', () => {
                panelContext.settings.reset();
                paint();
            });
            box.append(reset);
            root.append(box);
        };

        const toggle = (colors, on, onChange) => {
            const button = el('button', {
                attrs: { type: 'button', role: 'switch' },
                style: `width: 40px; height: 22px; border-radius: 999px; border: 1px solid ${mix(colors.text, -0.75)}; background: ${on ? colors.accent : mix(colors.text, -0.86)}; position: relative; cursor: pointer; transition: background 160ms ease;`,
            });
            const knob = el('span', {
                style: `position: absolute; top: 2px; left: ${on ? '20px' : '2px'}; width: 16px; height: 16px; border-radius: 50%; background: ${on ? mix(colors.surface, 0) : mix(colors.text, -0.55)}; transition: left 160ms ease;`,
            });
            button.append(knob);
            button.addEventListener('click', () => onChange(!on));
            return button;
        };

        const i18nText = (value, fallback) => {
            if (value && typeof value === 'object') {
                const locale = panelContext.locale ?? 'zh-CN';
                return value[locale] ?? value['zh-CN'] ?? value.en ?? fallback ?? '';
            }
            return typeof value === 'string' ? value : (fallback ?? '');
        };

        let selectionId = null;
        let customId = null;
        const readSelectionId = () => selectionId;
        const readSelection = () => ({ wallpaperId: selectionId, customId });

        const syncSelection = async () => {
            const stored = await readState();
            selectionId = stored.wallpaperId ?? null;
            customId = stored.customId ?? null;
        };

        const onExternal = () => {
            readState().then((stored) => {
                selectionId = stored.wallpaperId ?? null;
                customId = stored.customId ?? null;
                paint();
            }).catch(() => paint());
        };
        panelListeners.add(onExternal);

        (async () => {
            await loadLibrary(false);
            await syncSelection();
            // 打开面板时强制恢复一次：顺手把「文件已经不在了」的条目剪掉
            await resolveCustom(true);
            if (!libraryCache?.items?.length) {
                state.message = libraryCache?.error
                    ? `没读到壁纸库：${libraryCache.error}`
                    : '没扫描到壁纸。确认 Wallpaper Engine 装好、并且至少有一张壁纸。';
            }
            paint();
        })().catch(() => paint());

        return () => {
            panelListeners.delete(onExternal);
            style.remove();
            root.remove();
        };
    };

    folium.registries.backgrounds.register({
        id: 'wallpaper-engine',
        label: t('壁纸引擎', 'Wallpaper Engine'),
        order: 120,
        settings: SETTINGS,
        settingsPanel: mountSettingsPanel,
        mount: mountWallpaper,
    });

    // 主进程扫描完会把端口推过来，这里顺手把缓存清了，第一次打开面板就是新数据
    try {
        folium.rpc.on('ready', () => {
            libraryCache = null;
        });
    } catch {
        /* 非主窗口上下文没有 rpc.on */
    }
}
