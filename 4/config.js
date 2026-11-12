
(function(root) {
    const targets = Object.freeze({
        web: 'https://wz6688.app/',
        app: 'https://wz888.app/',
        web_backup_1: 'https://wzweb.agwiyq.com/',
        app_backup_1: 'https://download.agwiyq.com/',
    });
    const targetURL = value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(targets, value) ? targets[value] : '';
    const defaults = Object.freeze({
        room_code: '',
        entry_url: targets.web,
        entry_target: 'web',
        support_target: 'web',
        hero_slogan: '公平 · 公正 · 安全 · 稳定',
        welcome_title: '新人豪礼',
        welcome_prefix: '注册即送',
        welcome_amount: '888',
        welcome_button: '立即领取',
        rebate_title: '每日返水',
        rebate_prefix: '最高',
        rebate_percent: '3.0',
        rebate_button: '立即领取',
        recharge_title: '充值优惠',
        recharge_prefix: '充值即送',
        recharge_amount: '8888',
        recharge_button: '立即领取',
        events_title: '多重活动',
        events_text: '精彩不断 惊喜不停',
        events_button: '查看详情',
    });
    const roomCode = value => typeof value === 'string' && /^[0-9]{6}$/.test(value) ? value : '';

    function entryURL(value) {
        if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^/?#]/i.test(value) || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(value)) return '';
        try {
            if (/[\\\u0000-\u001f\u007f-\u009f]/.test(decodeURIComponent(value)) || value.slice(8).split(/[/?#]/, 1)[0].includes('@')) return '';
            const url = new URL(value);
            return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
        } catch {
            return '';
        }
    }

    function entryForRoom(value, room) {
        const entry = entryURL(value);
        if (!entry || !roomCode(room)) return '';
        const url = new URL(entry);
        const rooms = url.searchParams.getAll('room');
        // The saved room owns this promotion. A configured, different target is
        // a configuration error, never permission to silently replace either room.
        if (rooms.length > 1 || (rooms.length === 1 && rooms[0] !== room) ||
            url.searchParams.has('invite') || url.searchParams.has('ref')) return '';
        url.searchParams.set('room', room);
        return url.href;
    }

    function normalize(input, strict = false) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
        const result = {};
        for (const key of Object.keys(defaults)) {
            // entry_url is a legacy projection, never a caller-controlled destination.
            if (key === 'entry_url') continue;
            if ((key === 'entry_target' || key === 'support_target') && !Object.prototype.hasOwnProperty.call(input, key)) {
                result[key] = defaults[key];
                continue;
            }
            if (strict && !Object.prototype.hasOwnProperty.call(input, key)) return null;
            const value = input[key] === undefined && !strict ? defaults[key] : input[key];
            const parsed = parseField(key, value);
            if (parsed === undefined) return null;
            result[key] = parsed;
        }
        result.entry_url = entryForRoom(targetURL(result.entry_target), result.room_code) || targetURL(result.entry_target);
        if (strict && (!result.room_code || !result.entry_url)) return null;
        return result;
    }

    function parseField(key, value) {
        if (typeof value !== 'string') return undefined;
        if (key === 'room_code') return roomCode(value);
        if (key === 'entry_target' || key === 'support_target') return targetURL(value) ? value : undefined;
        if (key.endsWith('_amount') || key === 'rebate_percent') {
            if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value) || Number(value) > (key === 'rebate_percent' ? 100 : 1000000)) return undefined;
        } else {
            const limit = key === 'events_text' || key === 'hero_slogan' ? 40 : 12;
            if (!value.trim() || [...value].length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
        }
        return value;
    }

    function previewDraft(input, previous = defaults) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
        const config = normalize(previous) || { ...defaults
        };
        const invalidFields = [];
        for (const key of Object.keys(defaults)) {
            if (key === 'entry_url') continue;
            // Older complete drafts have no selectors. Do not inherit selections
            // from the previous room or draft when loading such a snapshot.
            if ((key === 'entry_target' || key === 'support_target') && !Object.prototype.hasOwnProperty.call(input, key)) {
                config[key] = defaults[key];
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
            const value = parseField(key, input[key]);
            if (value === undefined || (key === 'room_code' && !value)) {
                invalidFields.push(key);
                // An incomplete identity or destination must never keep a stale usable entry.
                if (key === 'room_code' || key === 'entry_target' || key === 'support_target') config[key] = '';
            } else config[key] = value;
        }
        config.entry_url = entryForRoom(targetURL(config.entry_target), config.room_code) || targetURL(config.entry_target);
        return {
            config,
            invalidFields
        };
    }

    function requestedRoom(search, pathname = '/4/') {
        // The public URL is /123456. Only the existing template and editor paths
        // may select a room using the older query format instead.
        const pathMatch = /^\/([0-9]{6})\/?$/.exec(pathname) || /^\/([0-9]{6})\.html$/.exec(pathname);
        const pathRoom = pathMatch ? pathMatch[1] : '';
        if (!pathRoom && !/^\/(?:4|landing-template-4)(?:\/(?:index\.html)?)?$/.test(pathname)) return null;
        const params = new URLSearchParams(search);
        // Neither duplicate room parameters nor conflicting aliases may select a different room.
        if (params.getAll('room_code').length > 1 || params.getAll('room').length > 1) return null;
        const code = params.get('room_code');
        const legacy = params.get('room');
        if (code !== null && legacy !== null && code !== legacy) return null;
        const value = code === null ? legacy : code;
        const queryRoom = value === null ? '' : roomCode(value);
        if (value !== null && !queryRoom) return null;
        if (pathRoom && queryRoom && pathRoom !== queryRoom) return null;
        return pathRoom || queryRoom;
    }
    const api = Object.freeze({
        defaults,
        targets,
        targetURL,
        normalize,
        previewDraft,
        roomCode,
        entryURL,
        entryForRoom,
        requestedRoom
    });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LandingTemplate4 = api;
})(typeof window === 'object' ? window : globalThis);