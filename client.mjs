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
    const listeners = new Set();
    const notify = () => listeners.forEach((listener) => {
        try {
            listener();
        } catch (error) {
            console.warn('[壁纸引擎] 订阅者出错', error);
        }
    });

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
            key: 'sceneSource', type: 'select', defaultValue: 'live',
            label: t('场景壁纸还原方式', 'Scene wallpaper rendering'),
            description: t('「实时渲染」用内置的 WebWallGL 引擎真正跑场景（着色器、粒子、视差都在，与 Wallpaper Engine 里一致）；其余三档是静态兜底：合成各层原图 / 只取背景层 / 官方动画预览', '“Live” runs the scene through the bundled WebWallGL engine — shaders, particles and parallax included. The other three are still fallbacks: composited layers, single layer, official preview'),
            options: [
                { value: 'live', label: t('实时渲染（推荐）', 'Live render') },
                { value: 'composite', label: t('合成静态图', 'Composited still') },
                { value: 'art', label: t('单张原画', 'Single layer') },
                { value: 'preview', label: t('动画预览', 'Animated preview') },
            ],
        },
        {
            key: 'sceneFps', type: 'number', defaultValue: 30, min: 15, max: 60, step: 5,
            label: t('场景帧率', 'Scene frame rate'),
            description: t('实时渲染场景的帧率上限；调低可省电、省 GPU', 'Frame-rate cap for live scenes; lower it to save power'),
        },
        {
            key: 'sceneScripts', type: 'boolean', defaultValue: true,
            label: t('运行壁纸脚本', 'Run wallpaper scripts'),
            description: t('场景自带的 SceneScript（时钟、文字动画、属性联动）需要它；关掉更安全，但部分壁纸会僵在原位', 'Scene wallpapers use SceneScript for clocks, text animation and property wiring. Turning it off is safer but freezes those parts'),
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
            key: 'motion', type: 'boolean', defaultValue: true,
            label: t('缓慢推拉', 'Slow pan'),
            description: t('静态壁纸加一点缓慢缩放，避免画面死板', 'A slow zoom on still wallpapers so the frame does not feel dead'),
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
            .wp-eng-media { position: absolute; inset: 0; transform-origin: 50% 50%; will-change: transform, filter; }
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
            @keyframes wp-eng-pan-a { from { transform: scale(1.02) translate3d(0, 0, 0); } to { transform: scale(1.12) translate3d(-1.5%, -1.2%, 0); } }
            @keyframes wp-eng-pan-b { from { transform: scale(1.12) translate3d(1.4%, 1%, 0); } to { transform: scale(1.02) translate3d(0, 0, 0); } }
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
        let panVariant = 0;
        let liveInstance = null;   // WebWallGL 实例（场景实时渲染时才有）
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
                paintReadability(sampleBandLuminance(media));
                return;
            }
            if (media.tagName === 'CANVAS') {
                paintReadability(sampleBandLuminance(media));
                return;
            }
            if (media.tagName === 'VIDEO' && media.readyState >= 2 && media.videoWidth > 0) {
                paintReadability(sampleBandLuminance(media));
            }
        };

        const applyFilters = () => {
            const settings = context.getSettings();
            const blur = Math.max(0, Number(settings.blur) || 0);
            const saturation = Math.max(0, Number(settings.saturation) || 0);
            const scale = blur > 0 ? 1.06 : 1;
            mediaWrap.style.filter = `blur(${blur}px) saturate(${saturation})`;
            mediaWrap.style.transform = `scale(${scale})`;

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

            // 实时场景有自己的相机与视差，别再叠 Ken Burns（会打架）
            if (media && media.tagName !== 'IFRAME' && !liveInstance) {
                mediaWrap.style.animation = settings.motion
                    ? `${panVariant % 2 === 0 ? 'wp-eng-pan-a' : 'wp-eng-pan-b'} 34s ease-in-out infinite alternate`
                    : 'none';
            } else {
                mediaWrap.style.animation = 'none';
            }

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
         * 场景壁纸不是静态图：它是多层 2.5D 场景，每层一张带透明通道的贴图。
         * 主进程把「画幅 + 每层的场景矩形 + 贴图字节区间」整理好，这里按顺序
         * 叠到一张 canvas 上，得到一张分辨率远超官方预览图的完整画面。
         * 逐层加载、画完即释放，避免十几张 4K 位图同时驻留显存。
         */
        const compositeScene = async (item, isCancelled) => {
            if (!library?.base) {
                return false;
            }
            let manifest;
            try {
                const res = await fetch(`${library.base}/i/${encodeURIComponent(item.id)}/scene`, { cache: 'no-store' });
                if (!res.ok) {
                    return false;
                }
                manifest = await res.json();
            } catch {
                return false;
            }
            if (!manifest?.ok || !Array.isArray(manifest.layers) || manifest.layers.length === 0 || !manifest.frame) {
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
                return false;
            }
            let engine;
            try {
                engine = await loadEngine();
            } catch {
                return false;
            }
            if (isCancelled()) {
                return true;
            }

            let poster = null;
            if (item.preview) {
                poster = document.createElement('img');
                poster.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(0.72)';
                const posterUrl = httpUrl(library, item, item.preview);
                if (posterUrl) {
                    poster.src = posterUrl;
                }
                poster.addEventListener('error', () => poster?.remove(), { once: true });
                mediaWrap.append(poster);
            }

            const host = document.createElement('div');
            host.style.cssText = 'position:absolute;inset:0;';
            mediaWrap.append(host);

            let instance;
            try {
                instance = engine.createScene(host, {
                    fit: settings.fit === 'contain' ? 'contain' : settings.fit === 'fill' ? 'stretch' : 'cover',
                    fps: Math.max(15, Math.min(60, Number(settings.sceneFps) || 30)),
                    volume: 0,
                    autoplay: true,
                    // 部分壁纸靠 SceneScript 驱动时钟/文字/属性联动；关掉更安全但会僵住
                    scripts: settings.sceneScripts !== false,
                    onDiagnostic: (message, level) => {
                        if (level === 'error') {
                            console.warn(`[壁纸引擎] ${message}`);
                        }
                    },
                });
            } catch (error) {
                host.remove();
                poster?.remove();
                return false;
            }

            let destroyed = false;
            liveInstance = instance;
            media = host;
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
            // 首帧可能很久（大包解析）；最多等 25 秒，之后让它在后台继续装配
            const timeout = new Promise((resolve) => setTimeout(resolve, 25000));
            try {
                await Promise.race([instance.load(source), timeout]);
            } catch (error) {
                stop();
                host.remove();
                poster?.remove();
                return false;
            }
            if (destroyed) {
                return true;
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
        const attachAudio = (instance) => {
            const audio = context.audio;
            if (!audio || typeof instance.setAudio !== 'function') {
                return;
            }
            const left = new Float32Array(64);
            const right = new Float32Array(64);
            const source = {
                snapshot() {
                    let spectrum = null;
                    try {
                        spectrum = typeof audio.getSpectrum === 'function' ? audio.getSpectrum() : null;
                    } catch {
                        spectrum = null;
                    }
                    if (spectrum && spectrum.length > 0) {
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
                        return { left, right };
                    }
                    // 没频谱时按分频能量铺一条曲线，总比全零好看，也比假跳动诚实
                    let bands = null;
                    let power = 0;
                    try {
                        bands = typeof audio.getBands === 'function' ? audio.getBands() : null;
                        power = typeof audio.getPower === 'function' ? Number(audio.getPower()) || 0 : 0;
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
                    return { left, right };
                },
            };
            try {
                instance.setAudio(source);
            } catch {
                /* 老版本引擎没有 setAudio */
            }
        };

        /*
         * 音频识别 / 正在播放：把 Folia 的当前歌曲喂给引擎。
         * 引擎默认是内置模拟曲目，所以「媒体播放器」类壁纸之前显示的是假歌名、
         * 假进度。folium.playback.getState() 给的是 { song, state, position, duration }。
         * 切歌、播放/暂停、进度漂移过大时重建一次媒体源。
         */
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
                built = { key: `${song?.id ?? ''}|${state?.state ?? ''}`, at: Date.now(), position };
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
                const song = state?.song ?? null;
                const key = `${song?.id ?? ''}|${state?.state ?? ''}`;
                if (!built || key !== built.key) {
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

        const show = (item) => {
            if (!item) {
                return;
            }
            const settings = context.getSettings();
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
                const frame = document.createElement('iframe');
                frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-forms');
                frame.setAttribute('allow', 'autoplay; fullscreen');
                frame.referrerPolicy = 'no-referrer';
                // 底下先垫一张预览图，网页 wallapper 加载不出来时不会露出白板
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
                cleanupMedia = () => {
                    frame.src = 'about:blank';
                };
                refreshReadability();
                return;
            }

            // scene / application：先试合成整场，再退单张原图，最后退官方预览图
            const sources = [];
            if (settings.sceneSource !== 'preview') {
                const sharp = artUrl(library, item);
                if (sharp) {
                    sources.push({ url: sharp, sharp: true });
                }
            }
            const previewOverHttp = httpUrl(library, item, item.preview);
            if (previewOverHttp) {
                sources.push({ url: previewOverHttp, sharp: false });
            }
            const previewOverFile = toFileUrl(item.absPreview);
            if (previewOverFile) {
                sources.push({ url: previewOverFile, sharp: false });
            }
            if (sources.length === 0) {
                // 选了「预览」但这张没有预览图时，原图总比空着强
                const sharp = artUrl(library, item);
                if (sharp) {
                    sources.push({ url: sharp, sharp: true });
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

            if (item.kind === 'scene' && settings.sceneSource !== 'preview' && settings.sceneSource !== 'art') {
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
                    let ready = false;
                    if (settings.sceneSource === 'live') {
                        ready = await liveScene(item, settings, () => cancelled || disposed, (stop) => {
                            if (stopLive) {
                                stopLive.push(stop);
                            } else {
                                stop();
                            }
                        });
                    }
                    if (!ready) {
                        ready = await compositeScene(item, () => cancelled || disposed);
                    }
                    if (!ready && !cancelled && !disposed) {
                        paintStill();
                    }
                };
                run().catch(() => {
                    if (!cancelled && !disposed) {
                        paintStill();
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
            library = await loadLibrary(false);
            if (disposed) {
                return;
            }
            selection = await readState();
            if (disposed) {
                return;
            }
            const settings = context.getSettings();
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
            panVariant = fnv1a(item.id);
            teardownMedia();
            show(item);
            applyFilters();
        };

        const formatCaption = (item, mode) => {
            const kindText = item.live === 'video'
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

        const onSelectionChange = () => {
            render().catch((error) => console.warn('[壁纸引擎] 切换壁纸失败', error));
        };
        listeners.add(onSelectionChange);

        render().catch((error) => console.warn('[壁纸引擎] 挂载失败', error));

        // 设置变了、切歌了、播放/暂停了，宿主都会通过 subscribe 通知：
        // 一次性交给 render —— 它会比对当前壁纸，只做必要的重挂载。
        const stopSettings = typeof context.subscribe === 'function'
            ? context.subscribe(() => {
                render().catch((error) => console.warn('[壁纸引擎] 更新失败', error));
            })
            : null;

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

        const paintWallpaperTab = (colors, settings) => {
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

        const paintDisplayTab = (colors, settings) => {
            const schema = panelContext.settings.schema ?? [];
            const skipped = new Set(['mode', 'seed', 'reshuffle', 'liveOnly']);
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
        const readSelectionId = () => selectionId;

        const syncSelection = async () => {
            const stored = await readState();
            selectionId = stored.wallpaperId ?? null;
        };

        const onExternal = () => {
            readState().then((stored) => {
                selectionId = stored.wallpaperId ?? null;
                paint();
            }).catch(() => paint());
        };
        listeners.add(onExternal);

        (async () => {
            await loadLibrary(false);
            await syncSelection();
            if (!libraryCache?.items?.length) {
                state.message = libraryCache?.error
                    ? `没读到壁纸库：${libraryCache.error}`
                    : '没扫描到壁纸。确认 Wallpaper Engine 装好、并且至少有一张壁纸。';
            }
            paint();
        })().catch(() => paint());

        return () => {
            listeners.delete(onExternal);
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
