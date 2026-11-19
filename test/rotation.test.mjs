import test from 'node:test';
import assert from 'node:assert/strict';
import { durationMs, trackIdentity, createWallpaperPicker, createWallpaperRotation } from '../rotation.mjs';

class Video {
    constructor() { this.loop = true; this.ended = false; this.plays = 0; this.listeners = new Set(); this.position = 0; }
    addEventListener(name, fn) { if (name === 'ended') this.listeners.add(fn); }
    removeEventListener(name, fn) { if (name === 'ended') this.listeners.delete(fn); }
    set currentTime(value) { this.position = value; this.ended = false; }
    get currentTime() { return this.position; }
    play() { this.plays += 1; return Promise.resolve(); }
    finish() { this.ended = true; [...this.listeners].forEach((fn) => fn()); }
}

const harness = (values = {}, kind = 'image') => {
    let time = 0;
    let state = { settings: { mode: 'random', ...values }, trackKey: 'song-a', paused: false, active: true };
    const reasons = [];
    const rotation = createWallpaperRotation({ now: () => time, onAdvance: (reason) => reasons.push(reason) });
    const video = kind === 'video' ? new Video() : null;
    const update = (patch = {}) => { state = { ...state, ...patch }; rotation.update(state); };
    update();
    rotation.attach({ id: 'first', kind, video, epoch: 0 });
    return { rotation, video, reasons, update,
        tick(ms, patch) { time += ms; update(patch); },
        settings(patch) { update({ settings: { ...state.settings, ...patch } }); },
    };
};

test('seconds, minutes, fractional values and invalid duration fallback', () => {
    assert.equal(durationMs(5, 'seconds', 3), 5000);
    assert.equal(durationMs(2, 'minutes', 3), 120000);
    assert.equal(durationMs(0.5, 'minutes', 3), 30000);
    assert.equal(durationMs(0, 'seconds', 3), 180000);
    assert.equal(durationMs(NaN, 'seconds', 3), 180000);
});

test('song mode advances for a new track with the same album cover, not for elapsed time', () => {
    const a = trackIdentity({ id: 'one', title: 'One', album: 'Same' }, 'same-cover');
    const b = trackIdentity({ id: 'two', title: 'Two', album: 'Same' }, 'same-cover');
    assert.notEqual(a, b);
    const h = harness({ reshuffle: 'song' });
    h.tick(600000);
    assert.equal(h.reasons.length, 0);
    h.update({ trackKey: 'song-b' });
    assert.deepEqual(h.reasons, ['song']);
});

test('fixed interval continues across songs and waits for a newly attached wallpaper', () => {
    const h = harness({ reshuffle: 'interval', intervalValue: 1, intervalUnit: 'seconds' });
    h.tick(500, { trackKey: 'song-b' });
    assert.equal(h.reasons.length, 0);
    h.tick(500);
    assert.deepEqual(h.reasons, ['duration']);
    h.tick(100000);
    assert.equal(h.reasons.length, 1);
    h.rotation.attach({ id: 'next', kind: 'image', epoch: 1 });
    h.tick(1000);
    assert.equal(h.reasons.length, 2);
});

test('images, web pages and scenes use configured still duration in media mode', () => {
    for (const kind of ['image', 'web', 'scene']) {
        const h = harness({ reshuffle: 'media', imageDurationValue: 2, imageDurationUnit: 'seconds' }, kind);
        h.tick(1999);
        assert.equal(h.reasons.length, 0);
        h.tick(1);
        assert.deepEqual(h.reasons, ['duration']);
    }
});

test('video plays once before advancing; media mode ignores image duration for videos', () => {
    const h = harness({ reshuffle: 'media', videoPlayCount: 1, imageDurationValue: 1, imageDurationUnit: 'seconds' }, 'video');
    assert.equal(h.video.loop, false);
    h.tick(600000);
    assert.equal(h.reasons.length, 0);
    h.video.finish();
    assert.deepEqual(h.reasons, ['video-ended']);
    h.video.finish();
    assert.equal(h.reasons.length, 1);
});

test('video repeats exactly N complete plays and unrelated settings do not reset the count', () => {
    const h = harness({ reshuffle: 'media', videoPlayCount: 3 }, 'video');
    h.video.finish();
    h.settings({ blur: 4 });
    h.rotation.attach({ id: 'first', kind: 'video', video: h.video, epoch: 0 });
    h.video.finish();
    assert.equal(h.video.plays, 2);
    assert.equal(h.reasons.length, 0);
    h.video.finish();
    assert.deepEqual(h.reasons, ['video-ended']);
});

test('timed rotation pauses with music and resumes its remaining duration', () => {
    const h = harness({ reshuffle: 'interval', intervalValue: 1, intervalUnit: 'seconds', syncPause: true });
    h.tick(600);
    h.update({ paused: true });
    h.tick(100000);
    h.update({ paused: false });
    h.tick(399);
    assert.equal(h.reasons.length, 0);
    h.tick(1);
    assert.equal(h.reasons.length, 1);
});

test('rotation may continue while music is paused when sync pause is disabled', () => {
    const h = harness({ reshuffle: 'interval', intervalValue: 1, intervalUnit: 'seconds', syncPause: false });
    h.update({ paused: true });
    h.tick(1000);
    assert.equal(h.reasons.length, 1);
});

test('a video ending while paused advances only after resume', () => {
    const h = harness({ reshuffle: 'media' }, 'video');
    h.update({ paused: true });
    h.video.finish();
    assert.equal(h.reasons.length, 0);
    h.update({ paused: false });
    assert.deepEqual(h.reasons, ['video-ended']);
});

test('fixed and desktop modes keep the selected wallpaper and native video looping', () => {
    for (const mode of ['fixed', 'desktop']) {
        const h = harness({ mode, reshuffle: 'media' }, 'video');
        assert.equal(h.video.loop, true);
        h.video.finish(); h.tick(1000000, { trackKey: 'next' });
        assert.equal(h.reasons.length, 0);
    }
});

test('previews never rotate, and leaving media mode restores video looping', () => {
    const h = harness({ reshuffle: 'media' }, 'video');
    h.update({ active: false });
    assert.equal(h.video.loop, true);
    h.video.finish(); h.tick(100000);
    assert.equal(h.reasons.length, 0);
    h.update({ active: true });
    h.settings({ reshuffle: 'interval', intervalValue: 5, intervalUnit: 'seconds' });
    assert.equal(h.video.loop, true);
});

test('reattaching an unchanged media element does not reset its clock', () => {
    const h = harness({ reshuffle: 'interval', intervalValue: 1, intervalUnit: 'seconds' });
    h.tick(700);
    h.rotation.attach({ id: 'first', kind: 'image', epoch: 0 });
    h.tick(300);
    assert.equal(h.reasons.length, 1);
});

test('a single candidate video replays on a new turn; retired video events are ignored', () => {
    const h = harness({ reshuffle: 'media' }, 'video');
    const stale = [...h.video.listeners][0];
    h.video.finish();
    h.rotation.attach({ id: 'first', kind: 'video', video: h.video, epoch: 1 });
    assert.equal(h.video.plays, 1);
    stale();
    assert.equal(h.reasons.length, 1);
    h.video.finish();
    assert.equal(h.reasons.length, 2);
});

test('legacy hourly and session policies work independently of track changes', () => {
    const h = harness({ reshuffle: 'hour' });
    h.tick(3599999, { trackKey: 'next' }); assert.equal(h.reasons.length, 0);
    h.tick(1); assert.equal(h.reasons.length, 1);
    const session = harness({ reshuffle: 'session' });
    session.tick(100000000, { trackKey: 'next' }); assert.equal(session.reasons.length, 0);
});

test('detaching and disposing remove media listeners and prevent later advances', () => {
    const h = harness({ reshuffle: 'media' }, 'video');
    h.rotation.detach(); assert.equal(h.video.listeners.size, 0); assert.equal(h.video.loop, true);
    h.rotation.attach({ id: 'first', kind: 'video', video: h.video });
    h.rotation.dispose(); h.video.finish(); h.tick(100000);
    assert.equal(h.video.listeners.size, 0); assert.equal(h.reasons.length, 0);
});

test('choices are stable during refreshes, avoid immediate repeats, and handle a single item', () => {
    const picker = createWallpaperPicker();
    const items = [{ id: 'a' }, { id: 'b' }];
    let previous = null;
    for (let turn = 0; turn < 50; turn++) {
        const item = picker.choose(items, 123, String(turn));
        assert.notEqual(item.id, previous);
        assert.equal(picker.choose(items, 123, String(turn)), item);
        previous = item.id;
    }
    assert.equal(picker.choose([items[0]], 123, 'single').id, 'a');
});
