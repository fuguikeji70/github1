'use strict';
(() => {
    const rules = window.LandingTemplate4;
    const params = new URLSearchParams(window.location.search);
    const embeddedPreview = document.querySelector('meta[name="landing-editor-preview"]') ?.content === '1';
    const preview = embeddedPreview || params.get('preview') === '1';
    // srcdoc inherits the editor's base URL but has an opaque sandbox origin.
    // Accept updates only from the actual parent at that editor origin.
    const editorOrigin = embeddedPreview ? new URL(document.baseURI).origin : window.location.origin;
    if (embeddedPreview) {
        // A srcdoc #link otherwise resolves against the parent document's base URL
        // and can navigate this frame back to the (non-embeddable) admin page.
        document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', event => {
            event.preventDefault();
            if (!link.hasAttribute('data-entry')) document.getElementById(link.getAttribute('href').slice(1)) ?.scrollIntoView({
                behavior: 'smooth'
            });
        }));
    }
    const requestedRoom = rules.requestedRoom(window.location.search, window.location.pathname);
    const support = document.querySelector('#support');
    if (embeddedPreview) support.querySelector('.close').addEventListener('click', event => {
        // The isolated preview permits scripts, never form submission.
        event.preventDefault();
        support.close();
    });
    const reminder = document.querySelector('#room-reminder');
    const roomNumber = document.querySelector('#room-reminder-number');
    const copyButton = document.querySelector('#room-copy');
    const continueButton = document.querySelector('#room-continue');
    const retryButton = document.querySelector('#room-retry');
    const reminderStatus = document.querySelector('#room-reminder-status');
    const landingStatus = document.querySelector('#landing-status');
    let config = { ...rules.defaults
    };
    let loaded = false;
    let loading = false;
    let error = '';
    let lastEntry = null;
    let pendingTarget = null;
    let reminderGeneration = 0;
    let fetchGeneration = 0;
    let analyticsView = '';
    let analyticsVisitor = '';
    let analyticsViewed = false;
    let analyticsViewRequest = Promise.resolve(null);
    let continuing = false;
    let handoffController = null;
    let analyticsSession = '';
    let activeMS = 0,
        scrollPercent = 0,
        failedReports = 0;
    let activeAt = 0,
        engagementTimer = null,
        lastEngagement = '';
    const analyticsUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    function promotionTag(name, max = 64) {
        const values = params.getAll(name);
        const value = values.length === 1 ? values[0].trim() : '';
        return [...value].length <= max && /^[\p{L}\p{N} _.-]*$/u.test(value) ? value : '';
    }

    function measureEngagement() {
        const now = window.performance.now();
        if (activeAt) activeMS = Math.min(1800000, activeMS + Math.max(0, now - activeAt));
        activeAt = document.hidden ? 0 : now;
        const root = document.documentElement;
        const height = Math.max(root.scrollHeight, document.body.scrollHeight);
        const progress = height <= window.innerHeight ? 100 : Math.round((window.scrollY + window.innerHeight) / height * 100);
        if (!document.hidden) scrollPercent = Math.max(scrollPercent, Math.max(0, Math.min(100, progress)));
    }

    function flushEngagement() {
        if (!analyticsViewed || preview) return;
        try {
            measureEngagement();
            const snapshot = `${Math.floor(activeMS)}:${scrollPercent}:${failedReports}`;
            if (snapshot !== lastEngagement) {
                lastEngagement = snapshot;
                track('engage');
            }
        } catch { /* optional measurement never blocks entry */ }
    }

    function beginEngagement() {
        if (preview || engagementTimer) return;
        activeAt = document.hidden ? 0 : window.performance.now();
        document.addEventListener('visibilitychange', () => {
            flushEngagement();
            activeAt = document.hidden ? 0 : window.performance.now();
        });
        window.addEventListener('pagehide', flushEngagement);
        window.addEventListener('scroll', () => {
            measureEngagement();
        }, {
            passive: true
        });
        engagementTimer = window.setInterval(() => {
            if (!document.hidden) flushEngagement();
        }, 15000);
    }

    function analyticsID() {
        try {
            return window.crypto.randomUUID();
        } catch {
            return '';
        }
    }

    // 纯静态版：不上报任何事件，不向服务器发请求
    function track() {
        return null;
    }

    // 纯静态版：不做 handoff 令牌请求
    async function handoffToken() {
        return 'unknown';
    }

    function sendToEditor(type, fields = {}) {
        if (preview && window.parent !== window) window.parent.postMessage({
            type,
            ...fields
        }, editorOrigin);
    }

    function setStatus(message) {
        landingStatus.textContent = message;
        landingStatus.hidden = !message;
    }

    function render(next) {
        if (preview && (config.room_code !== next.room_code || config.entry_target !== next.entry_target || config.support_target !== next.support_target)) {
            // A confirmation belongs to one exact draft and selected action. A new
            // room or destination requires another deliberate entry click.
            pendingTarget = null;
            reminderGeneration++;
            if (reminder.open) reminder.close();
            if (support.open) support.close();
        }
        config = next;
        document.querySelectorAll('[data-field]').forEach(element => {
            const value = config[element.dataset.field];
            if (typeof value === 'string') element.textContent = value;
        });
        // Defaults belong only to the editor draft; public promotions appear after a verified read.
        document.querySelector('#offers').hidden = false;
        const room = rules.roomCode(config.room_code);
        document.querySelector('.room-banner').hidden = !room;
        document.querySelector('#page-room-code').textContent = room;
        if (reminder.open) renderReminder();
    }

    function renderReminder() {
        const ready = loaded && rules.entryForRoom(rules.targetURL(config[pendingTarget || 'entry_target']), config.room_code);
        const message = loading ? '正在加载房间信息，请稍候。' : error || '房间信息尚未配置，请联系提供链接的人。';
        document.querySelector('#room-reminder-title').textContent = ready ? '请记住房间号' : '暂时无法进入';
        document.querySelector('#room-reminder-description').textContent = ready ? '进入后需要使用，请先记下或复制。' : message;
        roomNumber.textContent = ready ? config.room_code : '';
        roomNumber.hidden = !ready;
        copyButton.hidden = !ready;
        continueButton.hidden = !ready;
        retryButton.hidden = true;
        retryButton.disabled = loading;
        reminderStatus.textContent = '';
        document.querySelector('#room-preview-note').hidden = !preview;
    }

    function openReminder(event) {
        event.preventDefault();
        lastEntry = event.currentTarget;
        pendingTarget = lastEntry.dataset.entry === 'support' ? 'support_target' : 'entry_target';
        track('click', lastEntry.dataset.track || (lastEntry.dataset.entry === 'support' ? 'support' : 'entry'));
        reminderGeneration++;
        if (support.open) support.close();
        renderReminder();
        if (!reminder.open) reminder.showModal();
    }

    document.querySelectorAll('[data-entry]').forEach(link => {
        // Keep a local href even after loading so modified-click/new-tab cannot skip the room reminder.
        link.href = '#room-reminder';
        link.addEventListener('click', openReminder);
        link.addEventListener('auxclick', event => event.preventDefault());
    });
    document.querySelector('[data-room-close]').addEventListener('click', () => reminder.close());
    reminder.addEventListener('close', () => {
        pendingTarget = null;
        reminderGeneration++;
        handoffController ?.abort();
        continuing = false;
        continueButton.disabled = false;
        if (lastEntry) lastEntry.focus();
        lastEntry = null;
    });
    window.addEventListener('pagehide', () => {
        reminderGeneration++;
        handoffController ?.abort();
        continuing = false;
        continueButton.disabled = false;
    });
    continueButton.addEventListener('click', async () => {
        const destination = rules.entryForRoom(rules.targetURL(config[pendingTarget]), config.room_code);
        if (!reminder.open || !loaded || !pendingTarget || !destination || continuing) return;
        if (preview) {
            reminderStatus.textContent = '预览结束，正式页面会在确认后打开入口。';
            sendToEditor('landing-page:continue-preview');
            return;
        }
        // Only a validated saved configuration can provide the destination; URL parameters never can.
        const action = lastEntry ?.dataset.track || (pendingTarget === 'support_target' ? 'support' : 'entry');
        const entered = track('enter', action);
        flushEngagement();
        // 纯静态版：不做 handoff 令牌请求，直接跳转到白名单里的地址。
        const target = new URL(destination);
        // 保留显式邀请参数（?invite= / ?ref=），由目标站自己校验，落地页不自行分配。
        const invitations = [...params.getAll('invite'), ...params.getAll('ref')];
        if (invitations.length) {
            const invite = invitations.length === 1 ? invitations[0].trim().replace(/^u(?=\d{4,5}$)/i, '') : '';
            target.searchParams.set('invite', /^\d{4,5}$/.test(invite) ? invite : '');
        }
        window.location.assign(target.href);
    });
    copyButton.addEventListener('click', async () => {
        if (!loaded || !rules.roomCode(config.room_code)) return;
        const value = config.room_code;
        const generation = reminderGeneration;
        try {
            await navigator.clipboard.writeText(value);
            if (generation === reminderGeneration && config.room_code === value && reminder.open) reminderStatus.textContent = '房间号已复制';
        } catch {
            if (generation === reminderGeneration && config.room_code === value && reminder.open) reminderStatus.textContent = '暂时无法复制，请长按房间号复制或记下。';
        }
    });

    // 纯静态版：房间配置直接读本页内嵌的 <script id="room-data">，不发任何请求。
    function readEmbeddedConfig() {
        const node = document.querySelector('#room-data');
        if (!node) throw new Error('missing');
        const payload = JSON.parse(node.textContent);
        const data = payload && typeof payload === 'object' && payload.data ? payload.data : payload;
        const saved = rules.normalize(data, true);
        if (!saved) throw new Error('invalid');
        return saved;
    }

    async function loadSaved() {
        if (preview || loading) return;
        const generation = ++fetchGeneration;
        loading = true;
        loaded = false;
        error = '';
        if (reminder.open) renderReminder();
        try {
            const saved = readEmbeddedConfig();
            if (generation !== fetchGeneration) return;
            loaded = true;
            render(saved);
            setStatus('');
        } catch {
            if (generation !== fetchGeneration) return;
            // 内嵌配置不完整时，页面仍按 HTML 里的默认文案展示，不隐藏任何区块。
            error = '页面内嵌的房间配置不完整，请检查本页 room-data。';
            setStatus(error);
        } finally {
            if (generation === fetchGeneration) {
                loading = false;
                if (reminder.open) renderReminder();
            }
        }
    }
    retryButton.addEventListener('click', loadSaved);

    if (preview) {
        document.body.classList.add('landing-preview');
        window.addEventListener('message', event => {
            if (event.source !== window.parent || event.origin !== editorOrigin || !event.data || event.data.type !== 'landing-page:preview') return;
            const next = rules.previewDraft(event.data.config, config);
            if (!next) return;
            loaded = Boolean(next.config.room_code && rules.targetURL(next.config.entry_target) && rules.targetURL(next.config.support_target));
            error = loaded ? '' : '请在右侧填写 6 位房间号，并选择有效的按钮和客服跳转地址。';
            render(next.config);
            const labels = {
                room_code: '房间号',
                entry_target: '按钮跳转地址',
                support_target: '客服跳转地址',
                hero_slogan: '品牌标语',
                welcome_title: '新人活动标题',
                welcome_prefix: '新人赠送文案',
                welcome_amount: '新人赠送金额',
                welcome_button: '新人活动按钮',
                rebate_title: '返水活动标题',
                rebate_prefix: '返水说明文案',
                rebate_percent: '每日返水比例',
                rebate_button: '返水活动按钮',
                recharge_title: '充值活动标题',
                recharge_prefix: '充值赠送文案',
                recharge_amount: '充值赠送金额',
                recharge_button: '充值活动按钮',
                events_title: '更多活动标题',
                events_text: '更多活动说明',
                events_button: '更多活动按钮',
            };
            const copyFields = next.invalidFields.filter(key => key !== 'room_code' && key !== 'entry_target' && key !== 'support_target');
            const notices = [];
            if (!loaded) notices.push(error);
            if (copyFields.length) notices.push(`${copyFields.map(key => labels[key]).join('、')}尚未填写完整，预览暂保留上次有效内容；其他修改会即时显示。`);
            setStatus(notices.join(' '));
        });
        document.querySelectorAll('[data-edit-field]').forEach(element => element.addEventListener('click', () => {
            sendToEditor('landing-page:select', {
                field: element.dataset.editField
            });
        }));
        sendToEditor('landing-page:ready');
    } else loadSaved();

    document.querySelectorAll('[data-support]').forEach(button => button.addEventListener('click', event => {
        event.preventDefault();
        if (!support.open) support.showModal();
    }));
    [support, reminder].forEach(dialog => dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }));

    const navigation = [...document.querySelectorAll('.top-nav a')];
    const selectNavigation = current => navigation.forEach(item => {
        item.classList.toggle('active', item === current);
        if (item === current) item.setAttribute('aria-current', 'location');
        else item.removeAttribute('aria-current');
    });
    navigation.forEach(link => link.addEventListener('click', () => selectNavigation(link)));
    const updateNavigation = () => {
        const current = navigation.find(link => link.hash === (window.location.hash || '#top'));
        if (current) selectNavigation(current);
    };
    window.addEventListener('hashchange', updateNavigation);
    updateNavigation();
})();