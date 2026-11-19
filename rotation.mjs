const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export const durationMs = (value, unit, fallbackMinutes) => {
    const fallback = fallbackMinutes * 60_000;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.max(1000, Math.min(86_400, parsed) * (unit === 'seconds' ? 1000 : 60_000)) : fallback;
};

export const trackIdentity = (song, cover = '') => song
    ? JSON.stringify([song.source ?? '', song.id ?? '', song.title ?? '', song.artist ?? '', song.album ?? ''])
    : `cover:${cover}`;

const hash = (text) => {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value;
};

// Remember a choice across settings/paused/theme refreshes. Only a new turn or
// a changed candidate pool selects again, avoiding immediate repeats when possible.
export const createWallpaperPicker = () => {
    let previousId = null;
    let previousKey = null;
    return {
        choose(items, seed, turn, getId = (item) => item.id) {
            if (!items.length) return null;
            const key = `${seed}|${turn}|${items.map(getId).join('|')}`;
            if (key === previousKey) return items.find((item) => getId(item) === previousId) ?? items[0];
            let index = hash(`${seed}|${turn}`) % items.length;
            if (items.length > 1 && getId(items[index]) === previousId) index = (index + 1) % items.length;
            previousId = getId(items[index]);
            previousKey = key;
            return items[index];
        },
    };
};

const config = (settings) => ({
    mode: settings.mode ?? 'random', trigger: settings.reshuffle ?? 'song',
    interval: durationMs(settings.intervalValue, settings.intervalUnit, 5),
    still: durationMs(settings.imageDurationValue, settings.imageDurationUnit, 3),
    plays: Math.round(number(settings.videoPlayCount, 1, 1, 1000)),
    syncPause: settings.syncPause !== false,
});

// The host owns the polling interval; this controller owns media listeners only.
// No timer or video loop can survive detach/dispose or a move into preview mode.
export const createWallpaperRotation = ({ onAdvance, now = () => performance.now() }) => {
    let settings = config({});
    let signature = null;
    let record = null;
    let active = false;
    let paused = false;
    let lastTime = now();
    let lastTrack = null;
    let elapsed = 0;
    let completed = 0;
    let pending = false;
    let disposed = false;
    let deferredEnd = false;
    const enabled = () => !disposed && active && settings.mode === 'random';
    const stopped = () => paused && settings.syncPause;
    const replay = (video) => {
        try {
            video.currentTime = 0;
            if (!stopped()) Promise.resolve(video.play()).catch(() => {});
        } catch { /* The renderer already reports media decoding/playback errors. */ }
    };
    const advance = (reason) => {
        if (!enabled() || !record || pending) return;
        pending = true;
        elapsed = 0;
        deferredEnd = false;
        onAdvance(reason);
    };
    const applyLoop = () => {
        if (record?.video) record.video.loop = !(enabled() && settings.trigger === 'media');
    };
    const ended = (current) => {
        if (record !== current || !enabled() || settings.trigger !== 'media' || pending) return;
        if (stopped()) { deferredEnd = true; return; }
        deferredEnd = false;
        completed += 1;
        if (completed >= settings.plays) advance('video-ended');
        else replay(current.video);
    };
    const detach = () => {
        if (record?.video) {
            record.video.removeEventListener('ended', record.onEnded);
            record.video.loop = record.originalLoop;
        }
        record = null;
        elapsed = 0;
        completed = 0;
        pending = false;
        deferredEnd = false;
        lastTime = now();
    };
    return {
        update({ settings: value = {}, trackKey = '', paused: isPaused = false, active: isActive = true } = {}) {
            if (disposed) return;
            const time = now();
            if (record && enabled() && !stopped() && !pending) elapsed += Math.max(0, time - lastTime);
            lastTime = time;
            const next = config(value);
            const nextSignature = JSON.stringify(next);
            if (nextSignature !== signature) {
                signature = nextSignature;
                elapsed = 0;
                completed = 0;
                deferredEnd = false;
            }
            settings = next;
            paused = isPaused;
            active = isActive;
            applyLoop();
            const changedTrack = lastTrack !== null && trackKey !== lastTrack;
            lastTrack = trackKey;
            if (!enabled() || stopped() || pending || !record) return;
            if (settings.trigger === 'song' && changedTrack) { advance('song'); return; }
            if (deferredEnd) { ended(record); return; }
            const limit = settings.trigger === 'interval' ? settings.interval
                : settings.trigger === 'hour' ? 3_600_000
                    : settings.trigger === 'media' && !record.video ? settings.still : null;
            if (limit !== null && elapsed >= limit) advance('duration');
        },
        attach({ id, kind, video = null, epoch = 0 }) {
            if (disposed) return;
            if (record && record.id === id && record.video === video && record.epoch === epoch) {
                applyLoop();
                return;
            }
            detach();
            record = { id, kind, video, epoch, originalLoop: video?.loop ?? true };
            const current = record;
            if (video) {
                current.onEnded = () => ended(current);
                video.addEventListener('ended', current.onEnded);
                applyLoop();
                if (video.ended && !stopped()) replay(video);
            }
        },
        detach,
        dispose() { detach(); disposed = true; },
    };
};
