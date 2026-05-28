/**
 * SillyTavern Incremental Save — Client Extension
 *
 * Intercepts save requests:
 *   1. If only new messages appended → /api/plugins/incremental-save/save-append (few KB)
 *   2. If old messages modified → gzip compress full body (like CompressedSave)
 *
 * Companion to the server plugin: incremental-save-server.js
 */
(function () {
    'use strict';

    if (window.__IncSaveInstalled) return;
    window.__IncSaveInstalled = true;

    const MODULE = 'IncSave';
    const SAVE_APPEND_URL = '/api/plugins/incremental-save/save-append';
    const GROUP_SAVE_APPEND_URL = '/api/plugins/incremental-save/group/save-append';

    // ---- Config ----
    const DEFAULTS = {
        gzipEnabled: true,
        gzipMinBytes: 102400, // 100KB
        logEnabled: true,
        verbose: true,
        targetPaths: ['/api/chats/save', '/api/chats/group/save'],
    };

    let settings = { ...DEFAULTS };
    try {
        const raw = localStorage.getItem('IncSave.settings.v1');
        if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {}

    function saveSettings() {
        try { localStorage.setItem('IncSave.settings.v1', JSON.stringify(settings)); } catch {}
    }

    // ---- Incremental save state ----
    let lastChatName = null;
    let lastChatLength = 0;
    let lastChatHash = null;
    let lastGroupChatId = null;
    let lastGroupChatLength = 0;
    let lastGroupChatHash = null;

    function computeHash(chatArray, upToIndex) {
        let h = '';
        for (let i = 1; i < upToIndex && i < chatArray.length; i++) {
            const m = chatArray[i];
            h += `${(m.mes || '').length}:${m.swipe_id ?? 0},`;
        }
        return h;
    }

    function getFileName(body) {
        try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            return parsed?.file_name || parsed?.id || null;
        } catch { return null; }
    }

    function getChatFromContext() {
        try {
            return SillyTavern?.getContext?.()?.chat || [];
        } catch { return []; }
    }

    function getCharactersFromContext() {
        try {
            return SillyTavern?.getContext?.()?.characters || {};
        } catch { return {}; }
    }

    function getThisChid() {
        try {
            return SillyTavern?.getContext?.()?.characterId || undefined;
        } catch { return undefined; }
    }

    // ---- Gzip (CompressionStream API) ----
    async function gzip(data) {
        const input = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array(data);
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(input);
        writer.close();
        return { input, output: await new Response(cs.readable).arrayBuffer() };
    }

    function fmtBytes(n) {
        if (!n) return '—';
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1048576).toFixed(2)} MB`;
    }

    /**
     * Determine if this save can be incremental.
     * Returns { canAppend, canHeaderOnly, newMessages, header, expectedLines } or null.
     */
    function tryIncremental(url, body) {
        const isGroup = url.includes('/group/');
        const chatName = isGroup ? getFileName(body) : getFileName(body);
        if (!chatName) return null;

        const chatArray = getChatFromContext();
        if (!chatArray.length) return null;

        const lastName = isGroup ? lastGroupChatId : lastChatName;
        const lastLen  = isGroup ? lastGroupChatLength : lastChatLength;
        const lastHash = isGroup ? lastGroupChatHash : lastChatHash;

        if (chatName !== lastName || lastLen <= 0) return null;

        const isSameLength = chatArray.length === lastLen;
        const hasNewMessages = chatArray.length > lastLen;
        const oldHash = computeHash(chatArray, lastLen);
        const oldUnchanged = oldHash === lastHash;

        // Parse body to extract header (first element of chat array)
        let header = null;
        try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            if (parsed?.chat && Array.isArray(parsed.chat) && parsed.chat.length > 0) {
                header = parsed.chat[0];
            }
        } catch {}

        if (!header) return null;

        const canAppend = hasNewMessages && oldUnchanged;
        const canHeaderOnly = isSameLength && oldUnchanged;

        if (!canAppend && !canHeaderOnly) return null;

        const newMessages = canAppend ? chatArray.slice(lastLen) : [];

        return {
            canAppend,
            canHeaderOnly,
            newMessages,
            header,
            expectedLines: lastLen + 1,
            avatarUrl: (isGroup ? '' : (getCharactersFromContext()[getThisChid()]?.avatar || '')),
        };
    }

    /**
     * Update tracking state after incremental save.
     */
    function updateTracking(url, chatName, result) {
        const isGroup = url.includes('/group/');
        const chatArray = getChatFromContext();

        if (isGroup) {
            lastGroupChatId = chatName;
            lastGroupChatLength = chatArray.length;
            lastGroupChatHash = computeHash(chatArray, chatArray.length);
        } else {
            lastChatName = chatName;
            lastChatLength = chatArray.length;
            lastChatHash = computeHash(chatArray, chatArray.length);
        }
    }

    // ---- Fetch interceptor ----
    const originalFetch = window.fetch.bind(window);

    async function patchedFetch(url, init) {
        // Normalize Request → url + init
        if (url instanceof Request && !init) {
            init = {
                method: url.method,
                headers: new Headers(url.headers),
                body: await url.clone().text(),
                mode: url.mode,
                credentials: url.credentials,
                cache: url.cache,
                redirect: url.redirect,
                referrer: url.referrer,
                integrity: url.integrity,
            };
            url = url.url;
        }
        init = init || {};

        // Check if we should intercept
        let pathname = '';
        try {
            const u = typeof url === 'string' ? url : url?.url || '';
            pathname = u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
        } catch {}

        const shouldIntercept = settings.targetPaths.some(p => pathname.includes(p));
        if (!shouldIntercept) return originalFetch(url, init);

        const method = (init.method || 'GET').toUpperCase();
        if (method !== 'POST') return originalFetch(url, init);

        // Already has Content-Encoding → skip
        const existingHeaders = new Headers(init.headers || {});
        if (existingHeaders.has('content-encoding')) return originalFetch(url, init);

        const bodyStr = typeof init.body === 'string' ? init.body : null;
        if (!bodyStr) return originalFetch(url, init);

        const t0 = performance.now();

        // ---- Phase 1: Try incremental save ----
        const inc = tryIncremental(pathname, bodyStr);
        if (inc) {
            const endpoint = pathname.includes('/group/') ? GROUP_SAVE_APPEND_URL : SAVE_APPEND_URL;
            const debugAction = inc.canAppend
                ? `appending ${inc.newMessages.length} message(s)`
                : 'header-only';

            const incBody = JSON.stringify({
                file_name: lastChatName || (pathname.includes('/group/') ? getFileName(bodyStr) : ''),
                id: pathname.includes('/group/') ? getFileName(bodyStr) : undefined,
                avatar_url: inc.avatarUrl,
                header: inc.header,
                newMessages: inc.newMessages,
                expectedLines: inc.expectedLines,
            });

            const t1 = performance.now();
            const response = await originalFetch(endpoint, {
                method: 'POST',
                cache: 'no-cache',
                headers: init.headers,
                body: incBody,
            });
            const t2 = performance.now();

            if (response.ok) {
                updateTracking(pathname, getFileName(bodyStr));
                if (settings.logEnabled) {
                    const saved = fmtBytes(incBody.length);
                    const skipped = fmtBytes(bodyStr.length - incBody.length);
                    if (settings.verbose) {
                        console.log(
                            `%c[${MODULE}]%c INCREMENTAL ${debugAction}: ${saved} (saved ${skipped}) · ${(t2 - t1).toFixed(0)}ms`,
                            'color:#4caf50;font-weight:bold', '',
                        );
                    }
                }
                return response;
            }

            // Incremental failed — line mismatch, fall through to full save + gzip
            if (settings.verbose) {
                console.warn(`[${MODULE}] Incremental failed (${response.status}), falling back to full save`);
            }
        }

        // ---- Phase 2: Gzip compress full body ----
        if (!settings.gzipEnabled) return originalFetch(url, init);

        const bodySize = new Blob([bodyStr]).size;
        if (bodySize < settings.gzipMinBytes) return originalFetch(url, init);

        if (typeof CompressionStream === 'undefined') return originalFetch(url, init);

        try {
            const tGzipStart = performance.now();
            const { output: gzBytes } = await gzip(bodyStr);
            const tGzipEnd = performance.now();

            const newHeaders = new Headers(init.headers || {});
            newHeaders.delete('content-length');
            newHeaders.set('content-encoding', 'gzip');

            const response = await originalFetch(url, {
                ...init,
                headers: newHeaders,
                body: gzBytes,
            });

            if (settings.logEnabled && settings.verbose) {
                console.log(
                    `%c[${MODULE}]%c GZIP ${fmtBytes(bodySize)} → ${fmtBytes(gzBytes.byteLength)} ` +
                    `(${(gzBytes.byteLength / bodySize * 100).toFixed(1)}%, ${(tGzipEnd - tGzipStart).toFixed(0)}ms)`,
                    'color:#ff9800;font-weight:bold', '',
                );
            }
            return response;
        } catch (e) {
            if (settings.verbose) console.warn(`[${MODULE}] Gzip failed: ${e.message}, falling back to plain fetch`);
            return originalFetch(url, init);
        }
    }

    // ---- Install ----
    window.fetch = patchedFetch;

    if (settings.verbose) {
        console.log('%c[IncSave]%c Installed — incremental save + gzip fallback', 'color:#4caf50;font-weight:bold', '');
        console.log(`[IncSave] Incremental: ${SAVE_APPEND_URL}`);
        console.log(`[IncSave] Gzip threshold: ${fmtBytes(settings.gzipMinBytes)}`);
    }

    // ---- Settings panel (optional) ----
    // Minimal API: window.__IncSave allows runtime config changes
    window.__IncSave = {
        getSettings: () => settings,
        updateSettings: (partial) => {
            Object.assign(settings, partial);
            saveSettings();
        },
        resetTracking: () => {
            lastChatName = lastGroupChatId = null;
            lastChatLength = lastGroupChatLength = 0;
            lastChatHash = lastGroupChatHash = null;
        },
    };
})();
