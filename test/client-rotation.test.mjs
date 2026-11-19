import test from 'node:test';
import assert from 'node:assert/strict';
import activate from '../client.mjs';

class Element extends EventTarget {
    constructor(tag) {
        super(); this.tagName = tag.toUpperCase(); this.children = []; this.style = { setProperty() {} };
        this.className = ''; this.attributes = {}; this.isConnected = true; this.clientWidth = 1280; this.clientHeight = 720;
        this.readyState = 3; this.videoWidth = 640; this.complete = true; this.naturalWidth = 640;
        this.paused = false; this.ended = false; this._text = ''; this.position = 0;
        this.classList = {
            contains: (value) => this.className.split(' ').includes(value),
            add: (...values) => { this.className = [...new Set([...this.className.split(' '), ...values])].join(' '); },
            remove: (...values) => { this.className = this.className.split(' ').filter((x) => !values.includes(x)).join(' '); },
            toggle: (value, on) => { on ? this.classList.add(value) : this.classList.remove(value); },
        };
    }
    get textContent() { return this._text + this.children.map((x) => x.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children.forEach((x) => { x.parent = null; }); this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720 }; }
    querySelectorAll(selector) {
        const choices = selector.split(',').map((x) => x.trim());
        const found = [];
        const walk = (node) => node.children.forEach((child) => {
            if (choices.some((x) => x.startsWith('.') ? child.classList.contains(x.slice(1)) : child.tagName === x.toUpperCase())) found.push(child);
            walk(child);
        });
        walk(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    set src(value) { this._src = value; queueMicrotask(() => this.dispatchEvent(new Event(this.tagName === 'VIDEO' ? 'loadeddata' : 'load'))); }
    get src() { return this._src; }
    set currentTime(value) { this.position = value; this.ended = false; }
    get currentTime() { return this.position; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    finish() { this.ended = true; this.dispatchEvent(new Event('ended')); }
    getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4).fill(128) }) }; }
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const setup = (values = {}, kind = 'video') => {
    let definition;
    const stored = new Map();
    const library = { items: ['a','b'].map((id) => ({ id, title: id, kind,
        live: kind === 'video' ? 'video' : null, file: `${id}.mp4`, preview: kind === 'video' ? null : `${id}.png`,
        absFile: null, absPreview: null, tags: [] })), base: 'http://127.0.0.1/test' };
    const folium = { storage: { get: async (key) => stored.get(key), set: async (key,value) => stored.set(key,value) },
        playback: { getState: () => ({ song: { id: 'same-album-one', title: 'One', album: 'Album' } }) },
        rpc: { on() {}, call: async (name) => name === 'customFiles' ? { items: ['c','d'].map((id) => ({ grantId: id, name: id, kind, url: `http://127.0.0.1/${id}` })) } : library },
        registries: { backgrounds: { register(value) { definition = value; } } } };
    activate(folium);
    const defaults = Object.fromEntries(definition.settings.map((field) => [field.key, field.defaultValue]));
    const settings = { ...defaults, motionAmount: 0, readability: 0, ...values };
    const intervals = new Map();
    const context = { getSettings: () => settings, getCoverUrl: () => 'same-cover', isPaused: () => false,
        getTheme: () => ({ primaryColor: '#ffffff' }), onChange: () => () => {}, onResize: () => () => {},
        every: (ms, fn) => { intervals.set(fn, ms); return () => intervals.delete(fn); } };
    return { definition, settings, intervals, context, folium };
};

test('renderer integrates media loops, wall clock rotation and custom settings', async (t) => {
    const previous = { document: globalThis.document, window: globalThis.window, performance: globalThis.performance };
    let clock = 0;
    globalThis.document = { createElement: (tag) => new Element(tag), body: new Element('body') };
    globalThis.window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {}, removeEventListener() {},
        getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) };
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
    t.after(() => { globalThis.document = previous.document; globalThis.window = previous.window;
        Object.defineProperty(globalThis, 'performance', { configurable: true, value: previous.performance }); });

    await t.test('video ended events reach renderer, change the selected file and clean up polling', async () => {
        const h = setup({ reshuffle: 'media', videoPlayCount: 2 });
        const container = new Element('div');
        const stop = h.definition.mount(container, h.context);
        try {
            await wait();
            const video = container.querySelector('video');
            assert.ok(video); assert.equal(video.loop, false);
            video.finish(); await wait();
            assert.equal(container.querySelectorAll('video').at(-1), video);
            video.finish(); await wait(200);
            const next = container.querySelectorAll('video').at(-1);
            assert.notEqual(next.src, video.src);
            assert.equal(next.loop, false);
            assert.equal([...h.intervals.values()].filter((x) => x === 200).length, 1);
        } finally { stop(); }
        assert.equal(h.intervals.size, 0);
    });

    await t.test('image interval continues within one song and schedules the next wallpaper', async () => {
        const h = setup({ reshuffle: 'interval', intervalValue: 2, intervalUnit: 'seconds', liveOnly: false }, 'image');
        const container = new Element('div'); const stop = h.definition.mount(container, h.context);
        try {
            await wait(); const first = container.querySelector('img').src;
            clock += 2000;
            for (const [fn, ms] of [...h.intervals]) if (ms === 200) fn();
            await wait(200);
            assert.notEqual(container.querySelectorAll('img').at(-1).src, first);
        } finally { stop(); }
    });

    await t.test('my files exposes rotation controls and the media count/duration inputs', async () => {
        const h = setup({ library: 'custom', mode: 'random', reshuffle: 'media' });
        const container = new Element('div');
        const stop = h.definition.settingsPanel(container, { locale: 'zh-CN', settings: {
            get: () => h.settings, set: (patch) => Object.assign(h.settings, patch), schema: h.definition.settings, reset() {} } });
        try {
            await wait();
            assert.match(container.textContent, /壁纸轮换方式/);
            assert.match(container.textContent, /视频完整播放几遍/);
            assert.match(container.textContent, /图片等停留时间/);
            const selectors = container.querySelectorAll('select');
            const policy = selectors.find((node) => node.children.some((option) => option.value === 'interval'));
            policy.value = 'interval'; policy.dispatchEvent(new Event('change'));
            assert.match(container.textContent, /每隔多久更换/);
        } finally { stop(); }
    });
});
