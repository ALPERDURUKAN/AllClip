// ==UserScript==
// @name         AllClip
// @namespace    http://tampermonkey.net/
// @version      3.0.2
// @license      AllClip Use-Only License 1.0; https://github.com/ALPERDURUKAN/AllClip/blob/main/LICENSE
// @homepageURL  https://github.com/ALPERDURUKAN/AllClip
// @supportURL   https://github.com/ALPERDURUKAN/AllClip/issues
// @updateURL    https://raw.githubusercontent.com/ALPERDURUKAN/AllClip/main/AllClip.user.js
// @downloadURL  https://raw.githubusercontent.com/ALPERDURUKAN/AllClip/main/AllClip.user.js
// @description  Save a page, article, selection, or element with media and optional AI titles and summaries.
// @author       Alper Durukan
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @connect      openrouter.ai
// @connect      integrate.api.nvidia.com
// @connect      ai-gateway.kilo.ai
// @connect      api.openai.com
// @connect      api.anthropic.com
// @connect      generativelanguage.googleapis.com
// @connect      api.groq.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==

(() => {
    'use strict';
    if (window.top !== window.self) return;
    const STORE = 'uwcs3.';
    const DAY = 86400000;
    const MiB = 1024 * 1024;
    const PRESETS = {
        openrouter: {name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', publicList: true},
        nvidia: {name: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1', publicList: true},
        kilo: {name: 'Kilo Code Gateway', base: 'https://ai-gateway.kilo.ai/api/v1', publicList: true},
        openai: {name: 'OpenAI', base: 'https://api.openai.com/v1'},
        anthropic: {name: 'Anthropic', base: 'https://api.anthropic.com/v1', auth: 'anthropic', chat: 'messages'},
        gemini: {name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', auth: 'google'},
        groq: {name: 'Groq', base: 'https://api.groq.com/openai/v1'},
        ollama: {name: 'Ollama (local)', base: 'http://localhost:11434', models: 'api/tags', chat: 'v1/chat/completions', auth: 'none'}
    };
    const baseSettings = {format: 'md', automatic: 'article', backgrounds: true, ai: false, ttl: 24, sample: 12000, assetMB: 32, totalMB: 128};
    const get = (key, fallback) => GM_getValue(STORE + key, fallback);
    const set = (key, value) => GM_setValue(STORE + key, value);
    const settings = () => ({...baseSettings, ...get('settings', {})});
    const chain = () => get('chain', []);
    const customIds = () => get('customIds', []);
    const providers = () => [...Object.keys(PRESETS), ...customIds()];
    const provider = id => ({id, auth: 'bearer', models: 'models', chat: 'chat/completions', key: '', rev: '0', ...PRESETS[id], ...get('provider.' + id, {})});
    const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clamp = (v, min, max, fallback) => Number.isFinite(Number(v)) && String(v).trim() ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fallback;
    const textOnly = v => typeof v === 'string' ? v.trim() : '';
    function migrate() {
        if (get('migrated', false)) return;
        const key = GM_getValue('openrouter_api_key', '');
        const model = GM_getValue('selected_model', '');
        if (key && !get('provider.openrouter', null)) set('provider.openrouter', {key, rev: uid()});
        if ((key || model) && !get('chain', null)) set('chain', [{id: 'openrouter', model: model || 'openrouter/free'}]);
        if (key && !get('settings', null)) set('settings', {...baseSettings, ai: true});
        set('migrated', true);
    }
    function endpoint(p, path) {
        const base = new URL(p.base);
        const local = ['localhost','127.0.0.1','[::1]'].includes(base.hostname) || base.hostname.endsWith('.localhost');
        if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) throw Error('Use HTTPS, or HTTP on localhost.');
        if (base.username || base.password || base.search || base.hash) throw Error('Put the API key in the key field. Use a base URL without a query or fragment.');
        const u = new URL(path, base.href.replace(/\/?$/, '/'));
        if (u.origin !== base.origin || u.username || u.password || u.hash) throw Error('The API path must stay on the configured origin.');
        for (const k of u.searchParams.keys()) if (/^(?:api[-_]?key|key|access[-_]?token|token|authorization)$/i.test(k)) throw Error('Store credentials in the API key field.');
        return u;
    }
    function headersFor(p) {
        const h = {};
        if (p.auth === 'anthropic') h['anthropic-version'] = '2023-06-01';
        if (!p.key || p.auth === 'none') return h;
        if (p.auth === 'bearer') h.Authorization = 'Bearer ' + p.key;
        else if (p.auth === 'google') h['x-goog-api-key'] = p.key;
        else if (p.auth === 'anthropic') {
            h['x-api-key'] = p.key;
            h['anthropic-dangerous-direct-browser-access'] = 'true';
        } else if (p.auth === 'header') {
            if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(p.header || '') || /^(?:cookie|host|origin|referer|proxy-|sec-)/i.test(p.header)) throw Error('Enter a valid API key header name.');
            h[p.header] = p.key;
        }
        return h;
    }
    function failure(message, status = 0, stop = false) {
        return Object.assign(new Error(message), {status, stop});
    }
    function requestJSON(p, url, {body, signal, timeout = 25000} = {}) {
        const target = endpoint(p, url.toString());
        const headers = headersFor(p);
        if (body) headers['Content-Type'] = 'application/json';
        return new Promise((resolve, reject) => {
            let request, timer, settled = false;
            function finish(fn, arg) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                fn(arg);
            }
            function stop(reason) { finish(reject, reason); request?.abort?.(); }
            function cancel() { stop(failure('Canceled', 0, true)); }
            if (signal?.aborted) return cancel();
            signal?.addEventListener('abort', cancel, {once: true});
            timer = setTimeout(() => stop(failure('Timed out')), timeout);
            try {
                request = GM_xmlhttpRequest({
                    method: body ? 'POST' : 'GET', url: target.href, headers, anonymous: true, redirect: 'error',
                    data: body ? JSON.stringify(body) : undefined, timeout,
                    onload(r) {
                        if (r.finalUrl && new URL(r.finalUrl).origin !== target.origin) return finish(reject, failure('Unexpected redirect'));
                        if (r.status < 200 || r.status >= 300) return finish(reject, failure(`HTTP ${r.status}`, r.status));
                        try {
                            const data = JSON.parse(r.responseText);
                            if (data?.error) {
                                const code = String(data.error.code || '');
                                return finish(reject, failure('Provider returned an error', Number(code) || 0, /content_filter|safety/i.test(code)));
                            }
                            finish(resolve, data);
                        } catch { finish(reject, failure('Invalid JSON response')); }
                    },
                    ontimeout: () => stop(failure('Timed out')), onabort: () => finish(reject, failure('Request aborted')),
                    onerror: () => finish(reject, failure('Network or connection permission error'))
                });
            } catch { finish(reject, failure('Request could not start')); }
        });
    }
    function catalogURL(p, query) {
        const u = endpoint(p, p.models);
        if (p.id === 'openrouter') u.searchParams.set('output_modalities', 'all');
        if (p.id === 'gemini') u.searchParams.set('pageSize', '1000');
        if (p.id === 'anthropic') u.searchParams.set('limit', '1000');
        for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
        return endpoint(p, u.href);
    }
    function nextPage(data, current, p) {
        const next = new URL(current);
        if (data.nextPageToken) next.searchParams.set('pageToken', data.nextPageToken);
        else if (data.has_more && (data.last_id || data.data?.at(-1)?.id)) next.searchParams.set('after_id', data.last_id || data.data.at(-1).id);
        else if (typeof (data.next || data.links?.next) === 'string') return endpoint(p, new URL(data.next || data.links.next, current).href);
        else if (data.has_more) throw Error('The catalog has another page but supplied no cursor.');
        else return null;
        return next;
    }
    function modelId(row, p) {
        const name = textOnly(row.id) || textOnly(row.model) || textOnly(row.name);
        return p.id === 'gemini' ? name.replace(/^models\//, '') : name;
    }
    async function catalog(p, {force = false, query = '', signal} = {}) {
        if (!p.base) throw Error('Save the endpoint first.');
        const url = catalogURL(p, query);
        const signature = JSON.stringify([p.rev, url.href]);
        const slot = 'catalog.' + p.id + (query ? '.query' : '');
        const old = get(slot, null);
        const cached = old?.signature === signature ? old : null;
        if (!force && cached && Date.now() - cached.time < settings().ttl * 3600000) return {...cached, cached: true};
        try {
            if (!p.publicList && p.auth !== 'none' && !p.key) throw Error('Save an API key first.');
            let page = url;
            const seen = new Set(), byId = new Map();
            while (page) {
                if (seen.has(page.href)) throw Error('The provider repeated a catalog cursor.');
                seen.add(page.href);
                const data = await requestJSON(p, page, {signal});
                const rows = Array.isArray(data) ? data : data.data ?? data.models;
                if (!Array.isArray(rows)) throw Error('The catalog has no model list.');
                for (const item of rows) {
                    const row = typeof item === 'string' ? {id: item} : item;
                    if (!row || typeof row !== 'object') continue;
                    const id = modelId(row, p);
                    if (id) byId.set(id, row);
                }
                page = nextPage(data, page, p);
            }
            const result = {signature, time: Date.now(), rows: Array.from(byId.values())};
            if (provider(p.id).rev === p.rev && !signal?.aborted) {
                try { set(slot, result); } catch { /* Storage quota does not invalidate a live response. */ }
            }
            return result;
        } catch (error) {
            if (cached && !signal?.aborted) return {...cached, stale: error.message};
            throw error;
        }
    }

    // Keep all scalar metadata, including new nested fields introduced by a provider.
    function fieldsFor(row, p) {
        const values = new Map();
        function add(k, value) {
            if (!values.has(k)) values.set(k, []);
            values.get(k).push(value);
        }
        function visit(k, v) {
            if (Array.isArray(v)) {
                if (!v.length) values.set(k, []);
                for (const x of v) visit(k, x);
            } else if (v && typeof v === 'object') {
                for (const [field, x] of Object.entries(v)) visit(k ? k + '.' + field : field, x);
            } else if (k && v != null) add(k, v);
        }
        visit('', row);
        const id = modelId(row, p);
        const context = row.context_length ?? row.context_window ?? row.max_context_length ?? row.inputTokenLimit ?? row.max_input_tokens;
        if (context != null) add('Context (tokens)', context);
        const numeric = v => v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
        const input = numeric(row.pricing?.prompt), output = numeric(row.pricing?.completion), fixed = numeric(row.pricing?.request);
        if (input != null) add('Input USD / 1M tokens', input * 1e6);
        if (output != null) add('Output USD / 1M tokens', output * 1e6);
        const free = row.isFree ?? row.is_free;
        let price = 'Unreported';
        if (input > 0 || output > 0 || fixed > 0 || free === false) price = 'Paid';
        else if ((input === 0 && output === 0) || free === true || (['openrouter','kilo'].includes(p.id) && id.endsWith(':free'))) price = 'Free';
        add('Text pricing', price);
        if (id.includes('/')) add('ID prefix', id.split('/')[0]);
        return values;
    }
    const numericValue = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v));
    function matchesRule(fields, rule) {
        const vals = fields.get(rule.field);
        if (rule.op === 'present') return !!vals;
        if (rule.op === 'missing') return !vals;
        if (!vals) return false;
        const target = rule.value.toLowerCase();
        if (rule.op === 'is not') return vals.every(v => String(v).toLowerCase() !== target);
        return vals.some(v => {
            const str = String(v).toLowerCase();
            if (rule.op === 'is') return str === target;
            if (rule.op === 'contains') return str.includes(target);
            if (!numericValue(v) || !numericValue(target)) return false;
            return rule.op === 'at least' ? Number(v) >= Number(target) : Number(v) <= Number(target);
        });
    }
    function canSummarize(row) {
        const outputs = row.architecture?.output_modalities;
        if (Array.isArray(outputs) && !outputs.includes('text')) return false;
        if (Array.isArray(row.endpoints) && !row.endpoints.some(x => typeof x === 'string' && x.endsWith('/chat/completions'))) return false;
        if (Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) return false;
        if (row.capabilities?.completion_chat === false || row.active === false) return false;
        return !['embedding','embeddings','rerank','reranker','asr','tts'].includes(String(row.model_type || '').toLowerCase());
    }
    const own = new WeakSet();
    const knownDocs = new WeakSet();
    const activeDialogs = new Set();
    const mainSelectors = ['article','[role="main"]','main','.post-content','.article-content','.entry-content','[data-testid="primaryColumn"]','.content','.post','.article','.story','.post-body','.entry','.single','.page-content'];
    const blockTags = new Set('article aside section main header footer nav address p div h1 h2 h3 h4 h5 h6 blockquote ul ol li dl dt dd pre figure figcaption table thead tbody tfoot tr th td caption details summary hr br strong em b i s del ins u small sub sup code kbd samp var mark abbr cite q time ruby rt rp bdi bdo span'.split(' '));
    const excluded = new Set('script style noscript template head meta link base title input textarea select option button'.split(' '));
    const fileTypes = /\.(?:pdf|epub|docx?|xlsx?|pptx?|od[stp]|rtf|txt|csv|tsv|json|ipynb|zip|gz|7z|rar|mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|mkv|m4v|mpd|m3u8|vtt|srt|png|jpe?g|gif|webp|svg|avif|tiff?|bmp)$/i;
    function webURL(raw, base, media = false) {
        if (!raw || !String(raw).trim()) return '';
        try {
            const url = new URL(String(raw).trim(), base);
            if (url.username || url.password) return '';
            if (['http:','https:'].includes(url.protocol)) return url.href;
            if (media && (url.protocol === 'blob:' || (url.protocol === 'data:' && /^data:(?:image\/|audio\/|video\/|text\/vtt[;,]|application\/(?:pdf|octet-stream)[;,])/i.test(url.href)))) return url.href;
        } catch { /* A missing or invalid URL has no capture target. */ }
        return '';
    }
    function mainElement(doc) {
        for (const sel of mainSelectors) {
            const candidates = [...doc.querySelectorAll(sel)].filter(el => !el.hidden && !own.has(el));
            const best = candidates.sort((a,b) => b.textContent.length - a.textContent.length)[0];
            if (best && (best.textContent.trim().length >= 100 || best.querySelector('img,video,audio,canvas,svg,math'))) return best;
        }
        return doc.body || doc.documentElement;
    }
    function activeContext() {
        let root = document, doc = document, focused, item;
        while ((item = root.activeElement)) {
            focused = item;
            if (item.shadowRoot?.activeElement) { root = item.shadowRoot; continue; }
            if (item.localName === 'iframe' || item.localName === 'frame') {
                try { if (item.contentDocument?.documentElement) { root = doc = item.contentDocument; continue; } } catch { /* Other origin. */ }
            }
            break;
        }
        return {root, doc, focused};
    }
    function selectedScope() {
        const {root, doc, focused} = activeContext();
        if (focused?.matches('textarea,input')) {
            if (!focused.matches('textarea,input:not([type]),input[type="text" i],input[type="search" i],input[type="url" i],input[type="tel" i]')) return null;
            const {selectionStart: start, selectionEnd: end, value} = focused;
            return end > start ? {text: value.slice(start, end), doc, scope: 'Selection'} : null;
        }
        const sel = root.getSelection?.() || doc.getSelection?.();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        let ranges = Array.from({length: sel.rangeCount}, (_, i) => sel.getRangeAt(i).cloneRange()).filter(r => !r.collapsed);
        // Chromium can retarget Shadow DOM ranges to the host. Request real boundaries when available.
        if (sel.getComposedRanges && sel.rangeCount === 1) {
            const roots = [];
            function collect(parent) {
                for (const el of parent.querySelectorAll('*')) if (el.shadowRoot && !own.has(el)) { roots.push(el.shadowRoot); collect(el.shadowRoot); }
            }
            collect(doc);
            if (roots.length) {
                try {
                    const [sr] = sel.getComposedRanges({shadowRoots: roots});
                    if (sr && sr.startContainer.getRootNode() === sr.endContainer.getRootNode()) {
                        const r = doc.createRange();
                        r.setStart(sr.startContainer, sr.startOffset); r.setEnd(sr.endContainer, sr.endOffset);
                        if (!r.collapsed) ranges = [r];
                    } else if (sr) return sel.toString() ? {text: sel.toString(), doc, scope: 'Selection'} : null;
                } catch { /* Use the native ranges on older browsers. */ }
            }
        }
        if (ranges.length) return {ranges, selectedText: sel.toString(), doc, scope: 'Selection'};
        return sel.toString() ? {text: sel.toString(), doc, scope: 'Selection'} : null;
    }
    // URL tokens in srcset may contain commas, especially data URLs. Descriptors delimit candidates.
    function srcsetURLs(input) {
        const out = [];
        let i = 0;
        while (i < input.length) {
            while (i < input.length && /[\s,]/.test(input[i])) i++;
            let start = i;
            while (i < input.length && !/\s/.test(input[i])) i++;
            const token = input.slice(start, i);
            if (!token) break;
            if (token.endsWith(',')) { out.push({url: token.replace(/,+$/, ''), descriptor: ''}); continue; }
            start = i;
            let depth = 0;
            while (i < input.length) {
                const ch = input[i];
                if (ch === ',' && !depth) break;
                if (ch === '(') depth++;
                if (ch === ')') depth = Math.max(0, depth - 1);
                i++;
            }
            out.push({url: token, descriptor: input.slice(start, i).trim()});
            i++;
        }
        return out;
    }
    function cleanVector(node) {
        const clone = node.cloneNode(true);
        for (const el of [clone, ...clone.querySelectorAll('*')]) {
            if (['script','style','foreignobject','animate','animatemotion','animatetransform','set','iframe','embed','object','a','annotation-xml','discard','handler'].includes(el.localName.toLowerCase()) || !['http://www.w3.org/2000/svg','http://www.w3.org/1998/Math/MathML'].includes(el.namespaceURI)) {
                el.remove(); continue;
            }
            for (const attr of [...el.attributes]) {
                const name = attr.localName.toLowerCase(), v = attr.value;
                if (/^on/.test(name) || ['style','class','src','base','action','tabindex'].includes(name) ||
                    (name === 'href' && !v.startsWith('#')) || (/url\s*\(/i.test(v) && !/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(v))) el.removeAttributeNode(attr);
            }
        }
        return clone;
    }
    function capture(scope, prefs) {
        const out = document.implementation.createHTMLDocument('');
        const root = out.createElement('main');
        const assets = [], lookup = new Map(), notes = new Set(), inFrame = new Set(), movies = new Map();
        function markMovie(raw, base, label, anchor) {
            const id = youtubeID(raw, base);
            if (!id) return;
            if (!movies.has(id)) movies.set(id,{id,label:label || 'YouTube video',embed:false,include:false});
            anchor.dataset.youtube = id;
        }
        const element = (tag, parent, value) => {
            const el = out.createElement(tag); parent.append(el);
            if (value !== undefined) el.textContent = value;
            return el;
        };
        function addAsset(raw, source, kind, label, mime = '', variant = '') {
            const url = webURL(raw, source.baseURI, true);
            if (!url) return null;
            let asset = lookup.get(url);
            if (!asset) {
                asset = {id: assets.length + 1, url, kind, label: label || kind, mime, uses: [], status: 'linked'};
                assets.push(asset); lookup.set(url, asset);
            }
            const use = [kind, label, variant].filter(Boolean).join(' / ');
            if (!asset.uses.includes(use)) asset.uses.push(use);
            return asset;
        }
        function ref(parent, a, display = 'link', label = '') {
            if (!a) return;
            const e = element(display === 'image' ? 'img' : 'a', parent);
            const text = label || a.label;
            if (display === 'image') e.alt = text;
            else e.textContent = text;
            e.dataset.asset = String(a.id);
            return e;
        }
        function localCandidates(node, target, kind, label) {
            const seen = new Map();
            function add(raw, source, desc, mime = '', image = false) {
                const a = addAsset(raw, source, kind, label, mime, desc);
                if (!a || seen.has(a.id)) return;
                const role = image ? 'image' : 'link';
                if (seen.size) target.append(' ');
                ref(target, a, role, image ? label : [label, desc].filter(Boolean).join(' · '));
                seen.set(a.id, true);
            }
            const img = kind === 'Image';
            const attrs = img ? ['data-original','data-lazy-src','data-src','src'] : ['src','data-src'];
            // Prefer a real lazy image over the commonly used one-pixel placeholder.
            const lazy = img && attrs.slice(0,-1).map(k => node.getAttribute(k)).find(Boolean);
            const current = node.currentSrc;
            if (lazy && (!current || current.startsWith('data:') || node.naturalWidth <= 1)) add(lazy, node, 'lazy source', '', true);
            if (current) add(current, node, 'current', node.type || '', img && !seen.size);
            for (const k of attrs) add(node.getAttribute(k), node, k, node.type || '', img && !seen.size);
            const sourceNodes = img && node.parentElement?.localName === 'picture' ? [...node.parentElement.querySelectorAll(':scope > source'), node] : [node, ...node.querySelectorAll(':scope > source')];
            for (const s of sourceNodes) {
                if (s !== node) add(s.getAttribute('src'), s, [s.getAttribute('label'),s.getAttribute('res'),s.getAttribute('data-quality'),s.media,s.type].filter(Boolean).join(' ') || 'source', s.type || '', img && !seen.size);
                for (const attr of ['srcset','data-srcset','data-lazy-srcset']) {
                    for (const c of srcsetURLs(s.getAttribute(attr) || '')) add(c.url, s, [c.descriptor,s.media].filter(Boolean).join(' '), s.type || '', img && !seen.size);
                }
            }
            if (!seen.size) {
                element('span', target, `[${label}: source unavailable]`);
                notes.add(`${kind} has no accessible source URL.`);
            }
        }
        function paintBackground(node, dest) {
            if (!prefs.backgrounds || !node.ownerDocument.defaultView) return;
            let bg = '';
            try { bg = node.ownerDocument.defaultView.getComputedStyle(node).backgroundImage; } catch { return; }
            if (!bg || bg === 'none') return;
            for (const match of bg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
                const a = addAsset(match[1] ?? match[2] ?? match[3], node, 'Background', node.getAttribute('aria-label') || 'Background image');
                if (a) { dest.append(' '); ref(dest, a); }
            }
        }
        function visit(node, parent, range = null) {
            if (!node || own.has(node)) return;
            if (range && !range.intersectsNode(node)) return;
            if (node.nodeType === 3) {
                const start = range?.startContainer === node ? range.startOffset : 0;
                const end = range?.endContainer === node ? range.endOffset : node.length;
                parent.append(out.createTextNode(node.data.slice(start, end)));
                return;
            }
            if (node.nodeType === 11) { for (const ch of node.childNodes) visit(ch, parent, range); return; }
            if (node.nodeType !== 1) return;
            const tag = node.localName.toLowerCase();
            if (excluded.has(tag) || node.hidden || node.getAttribute('aria-hidden') === 'true' && !['svg','math'].includes(tag)) return;
            const textLabel = node.getAttribute('aria-label') || node.getAttribute('title') || '';
            if (tag === 'svg' || tag === 'math' || tag === 'canvas') {
                if (range && node.contains(range.startContainer) && node.contains(range.endContainer) && !range.collapsed && range.toString()) {
                    parent.append(range.toString()); return;
                }
                if (tag === 'math') { parent.append(out.importNode(cleanVector(node), true)); return; }
                const label = textLabel || node.querySelector('title')?.textContent || (tag === 'svg' ? 'SVG graphic' : 'Canvas');
                try {
                    if (tag === 'canvas' && (!node.width || !node.height || node.width * node.height > 32000000)) throw Error('Canvas size');
                    const data = tag === 'canvas' ? node.toDataURL('image/png') : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(cleanVector(node)));
                    const asset = addAsset(data, node, tag === 'canvas' ? 'Canvas' : 'SVG', label, tag === 'canvas' ? 'image/png' : 'image/svg+xml');
                    if (!asset) throw Error('Unavailable');
                    ref(parent, asset, 'image');
                } catch { element('span', parent, `[${label}: pixels unavailable]`); notes.add('A canvas could not be read at this size or origin.'); }
                return;
            }
            if (tag === 'img') { localCandidates(node, parent, 'Image', node.getAttribute('alt') || textLabel || 'Image'); return; }
            if (tag === 'video' || tag === 'audio') {
                const box = element('figure', parent);
                const kind = tag === 'video' ? 'Video' : 'Audio';
                box.dataset.player = tag;
                element('figcaption', box, textLabel || kind);
                localCandidates(node, box, kind, textLabel || kind);
                if (node.poster) { box.append(' '); ref(box, addAsset(node.poster, node, 'Poster', 'Video poster'), 'image'); }
                for (const t of node.querySelectorAll('track')) {
                    const label = [t.kind || 'Captions',t.label || t.srclang].filter(Boolean).join(' ');
                    box.append(' ');
                    const trackRef = ref(box, addAsset(t.getAttribute('src'), t, 'Track', label, 'text/vtt'));
                    if (trackRef) { trackRef.dataset.trackKind = t.kind; trackRef.dataset.lang = t.srclang || ''; }
                }
                for (const track of Array.from(node.textTracks || [])) {
                    try {
                        for (const c of Array.from(track.cues || [])) if (c.text) element('p', box, `[${Number(c.startTime).toFixed(2)}s] ${c.text}`);
                    } catch { /* The track URL remains in the manifest. */ }
                }
                for (const ch of node.childNodes) if (!['source','track'].includes(ch.localName)) visit(ch, box, range);
                return;
            }
            if (tag === 'source' || tag === 'track') {
                if (!range && node.parentElement?.localName === 'picture') return;
                const a = addAsset(node.getAttribute('src'), node, tag === 'track' ? 'Track' : 'Source', textLabel || tag, node.type);
                ref(parent, a);
                for (const c of srcsetURLs(node.getAttribute('srcset') || '')) ref(parent, addAsset(c.url, node, 'Image', c.descriptor || 'Source image', node.type));
                return;
            }
            if (['iframe','frame','object','embed'].includes(tag)) {
                const box = element('section', parent);
                const url = webURL(node.getAttribute(tag === 'object' ? 'data' : 'src'), node.baseURI, true);
                let doc;
                try { doc = node.contentDocument; } catch { /* Only accessible documents can be traversed. */ }
                const file = url && (fileTypes.test(new URL(url).pathname) || node.type === 'application/pdf');
                if (file) ref(box, addAsset(url, node, 'Document', textLabel || 'Embedded file', node.type));
                else if (url) { const link = element('a', box, textLabel || 'Embedded page'); link.href = url; markMovie(url,node.baseURI,textLabel,link); }
                if (doc?.body && !inFrame.has(doc) && !file) {
                    inFrame.add(doc); visit(doc.body, box); inFrame.delete(doc);
                } else if (!file) {
                    if (!url) element('span', box, textLabel || 'Embedded content');
                    notes.add('An embedded document was inaccessible. Its source link was kept when available.');
                    for (const ch of node.childNodes) visit(ch, box, range);
                }
                return;
            }
            let dest = parent;
            if (tag === 'a') {
                const url = webURL(node.getAttribute('href'), node.baseURI, true);
                if (url) {
                    dest = element('a', parent);
                    const path = new URL(url).pathname;
                    if (node.hasAttribute('download') || node.getAttribute('type')?.split(';')[0] === 'application/pdf' || fileTypes.test(path) || /^(?:blob|data):/.test(url)) {
                        const asset = addAsset(url, node, 'Attachment', node.textContent.trim() || node.getAttribute('download') || 'Attachment', node.getAttribute('type') || '');
                        dest.dataset.asset = String(asset.id);
                    } else { dest.href = url; markMovie(url,node.baseURI,range ? textLabel : node.textContent.trim() || textLabel,dest); }
                }
            } else if (blockTags.has(tag) || node.getAttribute('role') === 'heading') {
                const heading = clamp(node.getAttribute('aria-level'), 1, 6, 2);
                dest = element(blockTags.has(tag) ? tag : 'h' + heading, parent);
                for (const attr of ['colspan','rowspan','start','value','reversed','open','lang','dir','datetime']) {
                    if (node.hasAttribute(attr)) dest.setAttribute(attr, node.getAttribute(attr));
                }
                if (tag === 'code' && /(?:^|\s)language-([\w+-]+)/.test(node.className)) dest.className = node.className.match(/(?:^|\s)language-([\w+-]+)/)[0].trim();
            }
            if (node.shadowRoot) {
                // Traverse the rendered tree once. Slots below insert their assigned light DOM.
                if (range && (node.contains(range.startContainer) || node.contains(range.endContainer))) {
                    for (const ch of node.childNodes) visit(ch, dest, range);
                } else visit(node.shadowRoot, dest);
            } else if (tag === 'slot') {
                const assigned = node.assignedNodes?.({flatten:true}) || [];
                for (const ch of assigned.length ? assigned : node.childNodes) visit(ch, dest);
            } else {
                for (const ch of node.childNodes) visit(ch, dest, range);
            }
            if (dest.localName === 'a' && dest !== parent && !dest.textContent.trim() && !dest.querySelector('img')) dest.textContent = textLabel || (dest.dataset.asset ? assets[Number(dest.dataset.asset)-1].label : dest.getAttribute('href'));
            if (!range || ['div','span','section','figure','a','i'].includes(tag) && !node.contains(range.startContainer) && !node.contains(range.endContainer)) paintBackground(node, parent);
        }
        if ('text' in scope) element(/\n|\t|^\s|\s$/.test(scope.text) ? 'pre' : 'p', root, scope.text);
        else if (scope.ranges) {
            for (const r of scope.ranges) {
                const section = element('section', root);
                let start = r.commonAncestorContainer;
                if (start.nodeType === 3) start = start.parentElement || start;
                // Preserve a surrounding link or code block without extending the range.
                if (start.closest) start = start.closest('pre,a') || start;
                visit(start, section, r);
            }
        } else {
            inFrame.add(scope.doc);
            visit(scope.node, root);
            if (youtubeID(scope.doc.URL, scope.doc.baseURI) && (scope.scope !== 'Element' || scope.node.localName === 'video')) {
                const link=element('a',root,'Watch on YouTube');link.href=scope.doc.URL;markMovie(scope.doc.URL,scope.doc.baseURI,scope.doc.title,link);
            }
            if (scope.scope === 'Full page' && scope.doc.contentType === 'application/pdf') ref(root, addAsset(scope.doc.URL, scope.node, 'Document', scope.doc.title || 'PDF', 'application/pdf'));
        }
        return {root, assets, notes, youtube:[...movies.values()], selectedText: scope.text ?? scope.selectedText, scope: scope.scope, url: scope.doc.URL === 'about:srcdoc' || scope.doc.URL === 'about:blank' ? location.href : scope.doc.URL,
            title: scope.doc.title || document.title || 'Web capture', time: new Date().toISOString()};
    }
    function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
    function resolveAssets(cap, offline = false, players = false) {
        const copy = cap.root.cloneNode(true);
        if (players) for (const figure of copy.querySelectorAll('[data-player]')) {
            const player = copy.ownerDocument.createElement(figure.dataset.player);
            player.controls = true; player.preload = 'none';
            for (const link of figure.querySelectorAll('[data-asset]')) {
                const a = cap.assets[Number(link.dataset.asset) - 1];
                if (offline && !a.path) continue;
                const url = (offline && a.path) || a.url;
                if (link.dataset.trackKind !== undefined) {
                    const track = copy.ownerDocument.createElement('track');
                    track.src = url; track.kind = link.dataset.trackKind || 'captions'; track.label = link.textContent; track.srclang = link.dataset.lang;
                    player.append(track);
                } else if (link.localName === 'img') player.setAttribute('poster', url);
                else {
                    const source = copy.ownerDocument.createElement('source');
                    source.src = url; if (a.mime) source.type = a.mime; player.append(source);
                }
            }
            if (player.querySelector('source')) figure.insertBefore(player, figure.querySelector('figcaption')?.nextSibling || null);
        }
        for (const el of copy.querySelectorAll('[data-asset]')) {
            const a = cap.assets[Number(el.dataset.asset) - 1];
            const url = (offline && a.path) || (players && a.inline) || a.url;
            el.setAttribute(el.localName === 'img' ? 'src' : 'href', url);
            el.removeAttribute('data-asset');
            if (players && a.embedPDF && isPDF(a) && (a.inline || a.path) && el.localName === 'a') {
                const pdf=copy.ownerDocument.createElement('object');
                pdf.type='application/pdf';pdf.data=url;pdf.width='100%';pdf.height='640';pdf.setAttribute('aria-label',a.label);
                pdf.append(el.cloneNode(true));el.after(pdf);
                el.setAttribute('download',assetName(a,'application/pdf').split('/').at(-1));
            }
        }
        const shown=new Set();
        for (const anchor of copy.querySelectorAll('[data-youtube]')) {
            const movie=cap.youtube.find(m=>m.id===anchor.dataset.youtube);anchor.removeAttribute('data-youtube');
            if (!movie || shown.has(movie.id)) continue;
            shown.add(movie.id);
            if (movie.path && offline) {
                const link=copy.ownerDocument.createElement('a');link.href=movie.path;link.textContent='Download '+movie.format.label;link.download='';
                anchor.after(' ',link);
                if (players) {
                    const player=copy.ownerDocument.createElement(movie.format.audio?'audio':'video');
                    player.src=movie.path;player.controls=true;player.preload='none';link.after(player);
                }
            } else if (players && movie.embed) {
                const frame=copy.ownerDocument.createElement('iframe');
                frame.src='https://www.youtube-nocookie.com/embed/'+movie.id;frame.title=movie.label;frame.width='560';frame.height='315';
                frame.loading='lazy';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
                anchor.after(frame);
            }
        }
        return copy;
    }
    const longestTicks = s => Math.max(0, ...(s.match(/`+/g) || []).map(t => t.length));
    const mdText = s => s.replace(/([\\`*_~\[\]<>])/g, '\\$1');
    const mdUrl = url => '<' + String(url).replace(/[\s<>\\]/g, c => encodeURIComponent(c)) + '>';
    function markdown(root) {
        const literals = [];
        const marker = '\uE000' + uid() + ':';
        function protect(s) { const index = literals.push(s) - 1; return marker + index + '\uE001'; }
        function walk(node, level = 0) {
            if (node.nodeType === 3) return mdText(node.data.replace(/\s+/g, ' '));
            if (node.nodeType !== 1) return '';
            const tag = node.localName;
            const inner = () => Array.from(node.childNodes, n => walk(n, level)).join('');
            if (tag === 'pre') {
                const raw = node.textContent, fence = '`'.repeat(Math.max(3, longestTicks(raw) + 1));
                const lang = node.querySelector('code')?.className.replace(/^language-/, '') || '';
                return '\n\n' + protect(`${fence}${lang}\n${raw}${raw.endsWith('\n') ? '' : '\n'}${fence}`) + '\n\n';
            }
            if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
                const raw = node.textContent;
                const fence = '`'.repeat(longestTicks(raw) + 1);
                const pad = /^`|`$|^ | $/.test(raw) ? ' ' : '';
                return protect(fence + pad + raw + pad + fence);
            }
            if (tag === 'math') {
                const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
                return protect(tex ? (node.getAttribute('display') === 'block' ? `\n$$\n${tex}\n$$\n` : `$${tex}$`) : node.outerHTML);
            }
            if (tag === 'img') return `![${mdText(node.alt || 'Image')}](${mdUrl(node.getAttribute('src') || '')})`;
            if (tag === 'a') return node.hasAttribute('href') ? `[${inner().trim() || 'Link'}](${mdUrl(node.getAttribute('href'))})` : inner();
            if (tag === 'table') {
                const rows = [...node.rows];
                if (!rows.length) return inner();
                if (node.querySelector('[rowspan]:not([rowspan="1"]),[colspan]:not([colspan="1"]),table')) return '\n\n' + protect(node.outerHTML) + '\n\n';
                const grid = rows.map(r => [...r.cells].map(cell => [...cell.childNodes].map(n => walk(n)).join('').trim().replace(/\n+/g,'<br>').replace(/\|/g,'\\|')));
                const width = Math.max(...grid.map(row => row.length));
                if (!width) return inner();
                const line = row => '| ' + Array.from({length:width}, (_, i) => row[i] || ' ').join(' | ') + ' |';
                const hasHead = [...rows[0].cells].some(cell => cell.localName === 'th');
                const head = hasHead ? grid.shift() : [];
                return '\n\n' + (node.caption ? walk(node.caption).trim() + '\n\n' : '') + [line(head),line(Array(width).fill('---')),...grid.map(line)].join('\n') + '\n\n';
            }
            if (tag === 'ul' || tag === 'ol') {
                const items = Array.from(node.children).filter(el => el.localName === 'li');
                const step = node.hasAttribute('reversed') ? -1 : 1;
                let num = node.hasAttribute('start') ? Number(node.getAttribute('start')) : step < 0 ? items.length : 1;
                const lines = [];
                for (const li of items) {
                    if (li.hasAttribute('value')) num = Number(li.getAttribute('value'));
                    const prefix = tag === 'ol' ? `${num}. ` : '- ';
                    const pad = ' '.repeat(prefix.length);
                    const body = [...li.childNodes].map(n => walk(n, level+1)).join('').trim();
                    lines.push(prefix + body.split('\n').join('\n' + pad));
                    num += step;
                }
                return (level ? '\n' : '\n\n') + lines.join('\n') + (level ? '\n' : '\n\n');
            }
            if (tag === 'br') return '  \n';
            if (tag === 'hr') return '\n\n---\n\n';
            const s = inner();
            if (!s.trim()) return s.includes(' ') ? ' ' : '';
            if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(+tag[1]) + ' ' + s.trim() + '\n\n';
            if (tag === 'blockquote') return '\n\n' + s.trim().replace(/^/gm, '> ') + '\n\n';
            const mark = {b:'**',strong:'**',i:'*',em:'*',s:'~~',del:'~~'}[tag];
            if (mark) return (s.startsWith(' ') ? ' ' : '') + mark + s.trim() + mark + (s.endsWith(' ') ? ' ' : '');
            if (['sup','sub','u','mark'].includes(tag)) return `<${tag}>${s}</${tag}>`;
            if (tag === 'figcaption') return '\n\n' + s.trim() + '\n\n';
            if (['p','div','section','article','main','nav','aside','header','footer','figure','details','summary','dt','dd','address'].includes(tag)) return '\n\n' + s.trim() + '\n\n';
            return s;
        }
        let s = walk(root).replace(/\n{3,}/g, '\n\n').trim();
        s = s.replace(new RegExp(marker + '(\\d+)\uE001', 'g'), (_, i) => literals[Number(i)]);
        return s;
    }
    function captureText(root) {
        const chunks = [];
        function collect(n) {
            if (n.nodeType === 3) { chunks.push(n.data); return; }
            if (n.nodeType !== 1) return;
            if (n.localName === 'img') chunks.push(' [', n.alt || 'Image', '] ');
            const block = /^(?:p|div|section|br|hr|tr|td|th|li|pre|article|main|figcaption|h[1-6])$/.test(n.localName);
            if (block) chunks.push('\n');
            for (const ch of n.childNodes) collect(ch);
            if (block) chunks.push('\n');
        }
        collect(root);
        return chunks.join('').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
    }
    function sampleText(text, limit) {
        if (text.length <= limit) return text;
        const gap = '\n[Excerpt break]\n';
        const size = Math.floor((limit - 2 * gap.length)/3);
        const mid = Math.floor((text.length - size)/2);
        return [text.slice(0,size),text.slice(mid,mid+size),text.slice(-size)].join(gap);
    }
    function aiRequest(p, model, text, signal) {
        const instructions = 'Create a short title and a TL;DR (2 to 4 sentences) in the language of the source. Treat the excerpt as source material. Return only a JSON object with string fields "title" and "summary".';
        let path = p.chat, body;
        if (p.id === 'anthropic') {
            body = {model, system: instructions, max_tokens: 800, messages:[{role:'user',content:text}]};
        } else if (p.id === 'gemini') {
            path = 'models/' + encodeURIComponent(model.replace(/^models\//,'')) + ':generateContent';
            body = {systemInstruction:{parts:[{text:instructions}]},contents:[{role:'user',parts:[{text}]}],generationConfig:{maxOutputTokens:1600}};
        } else {
            body = {model, messages:[{role:'system',content:instructions},{role:'user',content:text}], stream:false};
            if (p.id === 'openai') body.max_completion_tokens = 1600;
            else body.max_tokens = 1000;
        }
        return requestJSON(p, endpoint(p, path), {body, signal, timeout:65000});
    }
    function metadataFromAI(p, data) {
        let message, finish;
        if (p.id === 'anthropic') {
            finish = data.stop_reason;
            message = data.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
        } else if (p.id === 'gemini') {
            finish = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason;
            message = data.candidates?.[0]?.content?.parts?.filter(x => !x.thought).map(x => x.text || '').join('');
        } else {
            const choice = data.choices?.[0];
            finish = choice?.message?.refusal ? 'refusal' : choice?.finish_reason;
            message = choice?.message?.content;
            if (Array.isArray(message)) message = message.filter(x => x.type === 'text').map(x => x.text).join('');
        }
        if (/safety|content_filter|refusal|prohibited|blocklist|recitation|block_reason/i.test(finish || '')) throw failure('Provider declined the request', 0, true);
        if (!textOnly(message)) throw Error('No text in the response');
        let record;
        try { record = JSON.parse(message.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1')); }
        catch { throw Error('The model did not return a title and summary'); }
        if (!textOnly(record?.title) || !textOnly(record?.summary)) throw Error('Incomplete title or summary');
        return {title:record.title.replace(/\s+/g,' ').trim().slice(0,200), summary:record.summary.trim().slice(0,6000)};
    }
    async function enrich(cap, prefs, signal, notify) {
        const text = captureText(cap.root);
        const first = cap.root.querySelector('h1,h2')?.textContent.trim();
        const title = ((cap.scope === 'Selection' || cap.scope === 'Element') ? first || text.split('\n')[0] : cap.title) || cap.title;
        const result = {title:title.slice(0,140), summary:'', model:null, attempts:[], sampled:false};
        if (!prefs.ai || !text || !chain().length) return result;
        const sample = sampleText(text, prefs.sample);
        result.sampled = sample !== text;
        const skip = new Set();
        for (const {id,model} of chain()) {
            if (signal.aborted) throw failure('Canceled', 0, true);
            if (!providers().includes(id) || skip.has(id)) continue;
            const p = provider(id);
            if (p.auth !== 'none' && !p.key) { skip.add(id); result.attempts.push({provider:p.name, model, error:'No API key'}); continue; }
            notify(`${p.name} · ${model}`);
            try {
                const response = await aiRequest(p, model, sample, signal);
                Object.assign(result, metadataFromAI(p,response), {model:{provider:p.name,id:model}});
                result.attempts.push({provider:p.name, model, ok:true});
                return result;
            } catch (e) {
                if (signal.aborted) throw e;
                result.attempts.push({provider:p.name,model,error:e.message});
                if (e.stop) break;
                if ([401,402].includes(e.status)) skip.add(id);
            }
        }
        return result;
    }
    function printableURL(a) {
        return a.url.startsWith('data:') ? `inline:${a.id}` : a.url;
    }
    function manifest(cap, meta, body) {
        return {version:1,scope:cap.scope,title:meta.title,source:cap.url,capturedAt:cap.time,summary:meta.summary || null,model:meta.model,
            aiAttempts:meta.attempts,summaryUsesExcerpts:!!meta.model && meta.sampled,notes:[...cap.notes],
            assets:cap.assets.map(a => ({id:a.id,kind:a.kind,label:a.label,url:printableURL(a),mime:a.mime || null,uses:a.uses,status:a.status,
                ...(a.path ? {path:a.path,bytes:a.bytes} : {}), ...(a.reason ? {reason:a.reason} : {})})),
            youtube:cap.youtube.map(m=>({id:m.id,title:m.label,url:'https://www.youtube.com/watch?v='+m.id,onlineEmbed:m.embed,quality:m.format?.label,path:m.path,bytes:m.bytes,error:m.error})),
            ...(cap.selectedText === undefined ? {} : {selectedText:cap.selectedText}), ...(body === undefined ? {} : {markdown:body})};
    }
    function buildExports(cap, meta, offline) {
        const rendered = resolveAssets(cap, offline);
        const body = markdown(rendered), summaryLabel = meta.sampled ? 'TL;DR (from excerpts)' : 'TL;DR';
        const notes = [...cap.notes];
        const summary = meta.summary ? `## ${summaryLabel}\n\n${mdText(meta.summary)}\n\n` : '';
        const md = `---\ntitle: ${JSON.stringify(meta.title)}\nurl: ${JSON.stringify(cap.url)}\ndate: ${JSON.stringify(cap.time)}\nscope: ${JSON.stringify(cap.scope)}\ntags: [web-clip]\n---\n\n# ${mdText(meta.title)}\n\n${summary}${body}\n\n---\n\nSource: ${mdUrl(cap.url)}\n` +
            (notes.length ? '\n## Capture notes\n\n' + notes.map(n => '- ' + n).join('\n') + '\n' : '');
        const origins = offline ? "'self' file: data: blob:" : "'self' data: blob: https: http:";
        const embeds = cap.youtube.some(m=>m.embed&&!m.path) ? 'https://www.youtube-nocookie.com' : "'none'";
        const objects = cap.assets.some(a=>a.embedPDF&&(a.inline||a.path)) ? (offline ? "'self' file:" : 'data:') : "'none'";
        const policy = `default-src 'none'; img-src ${origins}; media-src ${origins}; object-src ${objects}; frame-src ${embeds}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
        const htmlBody = resolveAssets(cap, offline, true);
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(meta.title)}</title><style>body{max-width:76ch;margin:3rem auto;padding:0 1rem;font:17px/1.6 system-ui,sans-serif;color:#20262a}img,svg,video,audio{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f3f5f6;padding:1rem}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:.35rem}a{overflow-wrap:anywhere}blockquote{border-inline-start:3px solid #899;padding-inline-start:1rem}</style></head><body><header><h1>${esc(meta.title)}</h1><p><a href="${esc(cap.url)}">Source</a> · ${esc(cap.scope)} · ${esc(cap.time)}</p></header>${meta.summary ? `<h2>${summaryLabel}</h2><p>${esc(meta.summary)}</p>` : ''}${htmlBody.outerHTML}${notes.length ? '<h2>Capture notes</h2><ul>' + notes.map(n=>`<li>${esc(n)}</li>`).join('') + '</ul>' : ''}</body></html>`;
        return {md, html, body};
    }
    function filename(s) {
        let name = s.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'-').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'').slice(0,96).replace(/[. ]+$/g,'');
        if (!name) name = 'Web capture';
        return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
    }
    function youtubeID(raw, base) {
        try {
            const u = new URL(raw,base);
            if (!['https:','http:'].includes(u.protocol)) return '';
            const host = u.hostname.toLowerCase();
            const path = u.pathname.split('/').filter(Boolean);
            let id = '';
            if (host === 'youtu.be') id = path[0];
            else if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','www.youtube-nocookie.com','youtube-nocookie.com'].includes(host)) {
                id = path[0] === 'watch' ? u.searchParams.get('v') : ['shorts','embed','live','v'].includes(path[0]) ? path[1] : '';
            }
            return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : '';
        } catch { return ''; }
    }
    function isPDF(a) {return a.mime?.split(';')[0].toLowerCase()==='application/pdf' || /\.pdf(?:$|[?#])/i.test(a.url) || /^data:application\/pdf[;,]/i.test(a.url);}
    function dataURL(bytes,type) {
        return new Promise((resolve,reject)=>{
            const reader=new FileReader();
            reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(Error('Could not embed this file.'));
            reader.readAsDataURL(new Blob([bytes],{type}));
        });
    }
    function helperCall(path,body,signal,file=false) {
        const token=get('mediaToken','');
        if(!token)return Promise.reject(Error('Start web_saver_media.py and enter its pairing code.'));
        const url='http://127.0.0.1:47831/'+path;
        return new Promise((resolve,reject)=>{
            let req,timer,done=false;
            function finish(fn,value){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);fn(value);}
            function cancel(){finish(reject,Error('Canceled'));req?.abort?.();}
            if(signal?.aborted)return cancel();signal?.addEventListener('abort',cancel,{once:true});
            timer=setTimeout(()=>{finish(reject,Error('The local helper timed out.'));req?.abort?.();},path==='formats'||file?120000:20000);
            try{req=GM_xmlhttpRequest({method:'POST',url,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
                data:JSON.stringify(body),anonymous:true,redirect:'error',responseType:file?'arraybuffer':'text',
                onload:r=>{
                    if(r.status===403)return finish(reject,Error('The pairing code has changed. Enter the code from the helper window.'));
                    if(r.finalUrl&&r.finalUrl!==url)return finish(reject,Error('Unexpected helper redirect.'));
                    if(file&&r.status===200)return finish(resolve,new Uint8Array(r.response));
                    let data={};try{data=JSON.parse(r.responseText);}catch{/* Non-JSON error response. */}
                    if(r.status!==200)return finish(reject,Error(data.message||`Helper HTTP ${r.status}`));
                    finish(resolve,data);
                },onerror:()=>finish(reject,Error('Cannot reach the local helper. Start web_saver_media.py.')),onabort:()=>finish(reject,Error('Helper request canceled.'))});
            }catch{finish(reject,Error('Cannot contact the local helper.'));}
        });
    }
    async function youtubeDownload(movie,keep,limit,signal,notify) {
        if(!movie.format)throw Error('List the available qualities and select one first.');
        const {job}=await helperCall('download',{video:movie.id,format:movie.format.id,keep,limit},signal);
        const cancel=()=>{helperCall('cancel',{job}).catch(()=>{});};
        if(signal.aborted){cancel();throw Error('Canceled');}
        signal.addEventListener('abort',cancel,{once:true});
        try{
            while(!signal.aborted){
                const status=await helperCall('status',{job},signal);
                if(status.state==='failed')throw Error(status.error||'Video download failed.');
                if(status.state==='done'){
                    if(keep)return status;
                    if(status.bytes>limit)throw Error('Video exceeds the remaining archive limit.');
                    const bytes=await helperCall('file',{job},signal,true);
                    if(bytes.length!==status.bytes||bytes.length>limit)throw Error('Incomplete video file.');
                    return {...status,bytes};
                }
                notify(`Downloading ${movie.format.label} · ${((status.bytes||0)/MiB).toFixed(1)} MiB`);
                await new Promise(ok=>setTimeout(ok,900));
            }
            throw Error('Canceled');
        }finally{signal.removeEventListener('abort',cancel);}
    }
    function mediaReview(cap,prefs,signal) {
        return new Promise(resolve=>{
            const host=document.createElement('div');own.add(host);activeDialogs.add(host);
            const shadow=host.attachShadow({mode:'closed'}), dialog=el('dialog',{'aria-label':'Media options'});
            const content=el('main'), message=el('div',{class:'status',role:'status'});
            const localAbort=new AbortController(), report=s=>message.textContent=s;
            let finished=false, jobs=0;
            const fmt=select([['md','Markdown'],['zip','ZIP with media files'],['html','Single HTML file'],['json','JSON']],prefs.format);
            function finish(ok){
                if(finished)return;finished=true;
                localAbort.abort();activeDialogs.delete(host);signal.removeEventListener('abort',cancel);
                if(dialog.open)dialog.close();host.remove();resolve(ok);
            }
            const cancel=()=>finish(false);signal.addEventListener('abort',cancel,{once:true});
            const save=btn('Save capture',()=>{prefs.format=fmt.value;finish(true);},true);
            async function action(button,fn) {
                button.disabled=true;jobs++;save.disabled=true;
                try{await fn();}catch(e){report(e.message);}
                finally{button.disabled=false;jobs--;save.disabled=!!jobs;}
            }
            content.append(row(field('Format for this capture',fmt)),hint('HTML can contain PDF bytes and online players. ZIP can also store playable video files. Markdown and JSON keep media references.'));
            const pdfs=cap.assets.filter(isPDF), videos=cap.assets.filter(a=>['Audio','Video'].includes(a.kind));
            for(const a of pdfs){
                const toggle=check('Download and embed this PDF',!!a.embedPDF,v=>{a.embedPDF=v;if(v&&!['html','zip'].includes(fmt.value))fmt.value='zip';});
                const saveFile=btn('Download PDF',()=>action(saveFile,async()=>{
                    const {bytes,type}=await assetBytes(a,prefs.assetMB*MiB,localAbort.signal);
                    const result=await download(new Blob([bytes],{type:type||'application/pdf'}),assetName(a,'application/pdf').split('/').at(-1));report(result);
                }));
                content.append(details(a.label+' · PDF',hint(printableURL(a)),toggle,row(saveFile,externalLink('Open original PDF',a.url))));
            }
            if(videos.length){
                const options=select(videos.map(a=>[String(a.id),[a.label,...a.uses].join(' · ')]));
                const current=()=>videos.find(a=>a.id===Number(options.value));
                const open=externalLink('Open source file',current().url);
                options.onchange=()=>open.href=current().url;
                const getFile=btn('Download selected source',()=>action(getFile,async()=>{
                    const a=current();
                    const {bytes,type}=await assetBytes(a,prefs.assetMB*MiB,localAbort.signal);
                    report(await download(new Blob([bytes],{type}),assetName(a,type).split('/').at(-1)));
                }));
                const only=check('Include only this audio/video source in ZIP',false,()=>{});
                const restrict=()=>{for(const a of videos)a.omit=only.querySelector('input').checked&&a!==current();};
                only.addEventListener('change',restrict);options.addEventListener('change',restrict);
                content.append(details('Direct video and audio sources',field('Source or published quality',options),only,row(getFile,open)));
            }
            if(cap.youtube.length){
                const key=el('input',{type:'password',autocomplete:'off',placeholder:get('mediaToken','')?'Paired. Enter a new code if needed.':'Code printed by web_saver_media.py'});
                const pair=btn('Pair helper',()=>action(pair,async()=>{
                    if(key.value.trim())set('mediaToken',key.value.trim());
                    await helperCall('ping',{},localAbort.signal);key.value='';report('Media helper connected.');
                }));
                content.append(el('h2',{text:'YouTube'}),details('Connect the optional download helper',hint('Start web_saver_media.py on this computer. Paste its pairing code here. Online embeds work without the helper.'),row(field('Pairing code',key),pair)));
                for(const m of cap.youtube){
                    const cho=select([]), quality=field('Download quality',cho);
                    const block=el('details',{},el('summary',{text:m.label+' · '+m.id}),externalLink('Open on YouTube','https://www.youtube.com/watch?v='+m.id));
                    const embed=check('Embed online player',m.embed,v=>{m.embed=v;if(v&&!['html','zip'].includes(fmt.value))fmt.value='html';});
                    const local=check('Include selected quality in ZIP',false,v=>{m.include=v;if(v)fmt.value='zip';});
                    local.querySelector('input').disabled=true;
                    const stand=btn('Download separately',()=>action(stand,async()=>{
                        const status=await youtubeDownload(m,true,0,localAbort.signal,report);
                        report('Saved by the helper: '+status.filename);
                    }));
                    stand.disabled=true;let options=[];
                    const list=btn('List qualities',()=>action(list,async()=>{
                        const data=await helperCall('formats',{video:m.id},localAbort.signal);
                        options=data.formats||[];if(!options.length)throw Error('No downloadable qualities returned.');
                        cho.replaceChildren(...options.map(f=>new Option(f.label,f.id)));cho.selectedIndex=0;
                        m.format=options[0];stand.disabled=false;local.querySelector('input').disabled=false;
                        report(`${options.length} available formats for ${data.title}.`);
                    }));
                    cho.onchange=()=>{m.format=options.find(f=>f.id===cho.value);};
                    block.append(embed,row(list),quality,local,row(stand));content.append(block);
                }
            }
            if(!pdfs.length&&!videos.length&&!cap.youtube.length)content.append(hint('This scope contains no PDF, audio source, or recognized YouTube video.'));
            content.append(row(save,btn('Cancel capture',cancel)));
            dialog.addEventListener('cancel',e=>{e.preventDefault();cancel();});
            for(const ev of ['keydown','keyup','input','change','paste'])dialog.addEventListener(ev,e=>e.stopPropagation());
            dialog.append(el('header',{},el('h1',{text:'Media options'})),message,content);
            shadow.append(el('style',{text:style}),dialog);document.documentElement.append(host);dialog.showModal();
        });
    }
    function externalLink(label,href){return el('a',{text:label,href,target:'_blank',rel:'noopener noreferrer'});}
    const mimeExt = {'image/jpeg':'jpg','image/png':'png','image/svg+xml':'svg','image/gif':'gif','image/webp':'webp','image/avif':'avif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/mpeg':'mp3','audio/ogg':'ogg','audio/mp4':'m4a','audio/wav':'wav','audio/flac':'flac','audio/aac':'aac','text/vtt':'vtt','application/pdf':'pdf','application/zip':'zip','text/csv':'csv','application/json':'json','application/vnd.apple.mpegurl':'m3u8','application/x-mpegurl':'m3u8','application/dash+xml':'mpd'};
    async function assetBytes(asset, limit, signal) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        if (signal.aborted) throw Error('Canceled');
        signal.addEventListener('abort', cancel, {once:true});
        const timer = setTimeout(cancel, 20000);
        try {
            if (asset.url.startsWith('data:') && asset.url.length > limit * 4 + 1024) throw Error('File exceeds the byte limit');
            let response;
            try { response = await fetch(asset.url, {credentials:'same-origin',signal:controller.signal, referrerPolicy:'no-referrer'}); }
            catch { throw Error(controller.signal.aborted ? 'Fetch canceled or timed out' : 'Unavailable to this page (network or cross-origin access)'); }
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            // Some sites return an HTML sign-in or error page with HTTP 200 for a media URL.
            const type = (response.headers.get('content-type') || asset.mime || '').split(';')[0].toLowerCase();
            if (type === 'text/html' && asset.mime !== 'text/html') throw Error('The source returned an HTML page');
            if (Number(response.headers.get('content-length')) > limit) throw Error('File exceeds the byte limit');
            const reader = response.body?.getReader();
            if (!reader) throw Error('The browser did not provide a readable stream');
            const parts = [];
            let length = 0;
            while (true) {
                const {value,done} = await reader.read();
                if (done) break;
                length += value.length;
                if (length > limit) { await reader.cancel(); throw Error('File exceeds the byte limit'); }
                parts.push(value);
            }
            const bytes = new Uint8Array(length);
            let at = 0;
            for (const part of parts) { bytes.set(part, at); at += part.length; }
            return {bytes,type};
        } finally {
            controller.abort(); clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
        }
    }
    function assetName(a, type) {
        const ext = mimeExt[type];
        let base = '';
        if (/^https?:/.test(a.url)) {
            base = new URL(a.url).pathname.split('/').at(-1);
            try { base = decodeURIComponent(base); } catch { /* Preserve the URL spelling. */ }
        }
        base = filename(base || a.kind.toLowerCase());
        // Keep downloaded files passive when the server supplies an executable file name.
        if (/\.(?:html?|xhtml|m?js|cjs|exe|com|cmd|bat|sh|ps1|lnk|url|desktop|app|msi|vbs|hta)$/i.test(base)) base += '.bin';
        else if (ext && !base.toLowerCase().endsWith('.'+ext) && !(ext === 'jpg' && /\.jpeg$/i.test(base))) base += '.' + ext;
        else if (!/\.[a-z0-9]{1,8}$/i.test(base)) base += '.bin';
        return `media/${String(a.id).padStart(4,'0')}-${base}`;
    }
    // ZIP32 STORE. Blob parts avoid making a second copy of all media in memory.
    const crcTable = Uint32Array.from({length:256}, (_, n) => {
        let v = n;
        for (let i = 0; i < 8; i++) v = (v >>> 1) ^ ((v & 1) ? 0xedb88320 : 0);
        return v >>> 0;
    });
    function zip(files, time) {
        if (files.length > 65535) throw Error('Too many files for ZIP32. Reduce the capture scope.');
        const enc = new TextEncoder(), local = [], central = [];
        const dt = new Date(time);
        const stamp = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >>> 1);
        const date = ((Math.max(1980,dt.getFullYear()) - 1980) << 9) | ((dt.getMonth()+1) << 5) | dt.getDate();
        let offset = 0, centralSize = 0;
        function header(size) {
            const bytes = new Uint8Array(size), data = new DataView(bytes.buffer);
            return {bytes, u16:(pos,v) => data.setUint16(pos,v,true), u32:(pos,v) => data.setUint32(pos,v,true)};
        }
        for (const [path, content] of files) {
            const name = enc.encode(path), bytes = typeof content === 'string' ? enc.encode(content) : content;
            if (offset + name.length + bytes.length + 30 >= 0xffffffff) throw Error('Archive exceeds the ZIP32 size limit.');
            let crc = 0xffffffff;
            for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
            crc = (crc ^ 0xffffffff) >>> 0;
            const h = header(30), c = header(46);
            h.u32(0,0x04034b50); h.u16(4,20); h.u16(6,0x800); h.u16(10,stamp); h.u16(12,date);
            h.u32(14,crc); h.u32(18,bytes.length); h.u32(22,bytes.length); h.u16(26,name.length);
            c.u32(0,0x02014b50); c.u16(4,20); c.u16(6,20); c.u16(8,0x800); c.u16(12,stamp); c.u16(14,date);
            c.u32(16,crc); c.u32(20,bytes.length); c.u32(24,bytes.length); c.u16(28,name.length); c.u32(42,offset);
            local.push(h.bytes,name,bytes); central.push(c.bytes,name);
            offset += 30 + name.length + bytes.length; centralSize += 46 + name.length;
        }
        if (offset + centralSize + 22 >= 0xffffffff) throw Error('Archive exceeds the ZIP32 size limit.');
        const end = header(22);
        end.u32(0,0x06054b50); end.u16(8,files.length); end.u16(10,files.length); end.u32(12,centralSize); end.u32(16,offset);
        return new Blob([...local,...central,end.bytes], {type:'application/zip'});
    }
    async function makeOutput(cap, meta, prefs, signal, notify) {
        const fmt = prefs.format, files = [];
        if (fmt === 'zip' || (fmt==='html' && cap.assets.some(a=>a.embedPDF))) {
            let total = 0;
            for (const asset of cap.assets) {
                if (fmt==='html' && !asset.embedPDF) continue;
                if (asset.omit) {asset.status='link-only';asset.reason='Excluded by selection';continue;}
                if (signal.aborted) throw Error('Canceled');
                notify(`Collecting media ${asset.id} of ${cap.assets.length}`);
                const limit = Math.min(prefs.assetMB * MiB, prefs.totalMB * MiB - total);
                try {
                    if (limit <= 0) throw Error('Archive byte limit reached');
                    const {bytes,type} = await assetBytes(asset,limit,signal);
                    if (signal.aborted) throw Error('Canceled');
                    asset.bytes = bytes.byteLength; asset.mime = type || asset.mime;
                    if(asset.embedPDF && !new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))throw Error('Source did not return PDF bytes');
                    if(asset.embedPDF)asset.mime='application/pdf';
                    if(fmt==='html'){asset.inline=await dataURL(bytes,'application/pdf');asset.status='embedded';}
                    else{asset.path=assetName(asset,asset.mime);asset.status='saved';files.push([asset.path,bytes]);}
                    total += bytes.byteLength;
                    if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(asset.url) || /mpegurl|dash\+xml/.test(type)) cap.notes.add('A streaming playlist was saved as a source file. Its media segments are not in this archive.');
                } catch (e) {
                    if (signal.aborted) throw e;
                    asset.status = 'link-only'; asset.reason = e.message;
                }
            }
            if(fmt==='zip')for(const movie of cap.youtube.filter(m=>m.include)){
                try{
                    const limit=Math.min(prefs.assetMB*MiB,prefs.totalMB*MiB-total);
                    if(limit<=0)throw Error('Archive byte limit reached');
                    const finished=await youtubeDownload(movie,false,limit,signal,notify);
                    if(!/^(?:mp4|webm|m4a|mp3|opus|ogg|mkv)$/.test(finished.ext))throw Error('Unrecognized media container');
                    movie.path='media/youtube-'+movie.id+'.'+finished.ext;movie.bytes=finished.bytes.length;
                    total+=movie.bytes;files.push([movie.path,finished.bytes]);
                }catch(e){if(signal.aborted)throw e;movie.error=e.message;cap.notes.add('YouTube '+movie.id+': '+e.message);}
            }
            const linked = cap.assets.filter(a => a.status === 'link-only').length;
            if (linked) cap.notes.add(fmt==='zip'?`${linked} media resource(s) remain as links. See manifest.json for each reason.`:
                cap.assets.filter(a=>a.status==='link-only').map(a=>a.label+' · '+a.reason).join('\n'));
        } else if (cap.assets.some(a => a.url.startsWith('blob:'))) {
            cap.notes.add('Blob links can expire when the tab closes. Use ZIP while the source tab is open to keep readable bytes.');
        }
        const {md,html,body} = buildExports(cap,meta,fmt === 'zip');
        if (fmt === 'zip') {
            files.unshift(['capture.md',md],['capture.html',html],['manifest.json',JSON.stringify(manifest(cap,meta),null,2)]);
            if (cap.selectedText !== undefined) files.push(['selection.txt',cap.selectedText]);
            return zip(files,cap.time);
        }
        if (fmt === 'html') return new Blob([html],{type:'text/html;charset=utf-8'});
        if (fmt === 'json') return new Blob([JSON.stringify(manifest(cap,meta,body),null,2)],{type:'application/json'});
        return new Blob([md],{type:'text/markdown;charset=utf-8'});
    }
    function download(blob, name) {
        const url = URL.createObjectURL(blob);
        let released = false;
        const release = () => { if (!released) { released = true; URL.revokeObjectURL(url); } };
        return new Promise(resolve => {
            let done = false;
            function success() { if (done) return; done = true; release(); resolve('Downloaded'); }
            function fallback() {
                if (done) return;
                done = true;
                const a = document.createElement('a'); a.download = name; a.href = url; a.hidden = true;
                document.documentElement.append(a); a.click(); a.remove();
                setTimeout(release,60000); resolve('Download requested');
            }
            try {
                if (typeof GM_download !== 'function') return fallback();
                GM_download({url, name, saveAs:false, onload:success, onerror:e => {
                    if (e?.error === 'not_succeeded' && /cancel/i.test(JSON.stringify(e.details || ''))) {
                        if (!done) { done = true; release(); resolve('Download canceled'); }
                    } else fallback();
                }, ontimeout:fallback});
            } catch { fallback(); }
        });
    }
    function el(tag, props = {}, ...children) {
        const n = document.createElement(tag);
        for (const [k,v] of Object.entries(props)) {
            if (k === 'text') n.textContent = v;
            else if (k === 'class') n.className = v;
            else if (k.startsWith('on')) n.addEventListener(k.slice(2),v);
            else if (k in n) n[k] = v;
            else n.setAttribute(k,String(v));
        }
        n.append(...children);
        return n;
    }
    function btn(text, click, primary = false) {
        return el('button',{type:'button',text,class:primary?'primary':'',onclick:e => { if (e.isTrusted) click(e); }});
    }
    const row = (...nodes) => el('div',{class:'row'},...nodes);
    const field = (name,control) => el('label',{class:'field'},el('span',{text:name}),control);
    const hint = text => el('p',{class:'hint',text});
    const select = (pairs, selected) => {
        const ctl = el('select');
        for (const entry of pairs) {
            const [value,label] = Array.isArray(entry) ? entry : [entry,entry];
            ctl.add(new Option(label, value));
        }
        if (selected !== undefined) ctl.value = selected;
        return ctl;
    };
    const details = (title,...content) => el('details',{},el('summary',{text:title}),...content);
    const check = (name,value,change) => {
        const inp = el('input',{type:'checkbox',checked:value});
        inp.addEventListener('change',()=>change(inp.checked));
        return el('label',{class:'check'},inp,el('span',{text:name}));
    };
    function updateSetting(key,value) { set('settings',{...settings(),[key]:value}); }
    const style = `
    :host{all:initial;color-scheme:light dark}[hidden]{display:none!important}
    dialog{font:14px/1.45 "Segoe UI",system-ui,sans-serif;box-sizing:border-box;color:#172e30;background:#fbfcfa;border:1px solid #b5c9c6;border-radius:13px;padding:0;width:min(720px,96vw);max-height:92vh;overflow:auto;box-shadow:0 12px 64px #102a303b}
    dialog::backdrop{background:#12252b70}*{box-sizing:border-box}
    header{padding:15px 20px 11px;display:flex;align-items:center;justify-content:space-between}h1{font-size:20px;margin:0;letter-spacing:-.035em}h2{font-size:16px;margin:18px 0 7px}h3{font-size:14px;margin:16px 0 6px}
    nav{display:flex;gap:4px;flex-wrap:wrap;padding:0 18px;border-bottom:1px solid #d2dfdc}
    nav button{border:0;border-radius:0;border-bottom:3px solid transparent;background:transparent;padding:8px 9px}
    nav button[aria-current=true]{color:#065b51;border-color:#117f72}
    main{padding:4px 20px 20px}.row{display:flex;flex-flow:row wrap;align-items:end;gap:8px;margin:9px 0}
    .row>.field{flex:1 1 150px}.field{display:grid;gap:4px;min-width:0;font-weight:600;margin:6px 0}
    input,select,button,textarea{font:inherit;color:inherit}input:not([type=checkbox]),select,textarea{width:100%;min-width:0;padding:7px 8px;border:1px solid #a6bcb8;background:#fff;border-radius:5px;font-weight:400}
    select[size]{padding:4px;min-height:105px}option{padding:2px 5px}button{cursor:pointer;border:1px solid #a7bcb8;background:#fff;border-radius:5px;padding:6px 10px}
    button:hover{background:#edf4f1}button:disabled{opacity:.5;cursor:default}.primary{background:#096a60;color:white;border-color:#096a60}.primary:hover{background:#07534b}
    :focus-visible{outline:2px solid #087a90;outline-offset:2px}.hint,.status{color:#47605e;font-size:13px}.hint{margin:5px 0}.status{background:#e9f4f0;padding:7px 20px;overflow-wrap:anywhere}.status:empty{display:none}
    details{border-top:1px solid #dae3df;padding:8px 0;margin:8px 0}summary{cursor:pointer;font-weight:600}.check{display:flex;align-items:center;gap:7px;margin:9px 0}
    .chain{padding-left:22px}.chain li{padding:6px 0}.chain button{padding:3px 7px;margin:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font:12px/1.4 ui-monospace,monospace}
    @media(prefers-color-scheme:dark){dialog{background:#172425;color:#e8f2ec;border-color:#48615f}input:not([type=checkbox]),select,textarea,button{background:#243435;border-color:#627775}button:hover{background:#334647}.hint,.status{color:#b5cac4}.status{background:#223f38}nav button[aria-current=true]{color:#9cdecd}.primary{background:#127468}nav button{background:transparent}}`;
    let panel = null, loadAbort = null, busy = null, toastHost, toastBox, toastTimer;
    function toast(message, sticky = false) {
        clearTimeout(toastTimer);
        if (!toastHost?.isConnected) {
            toastHost = document.createElement('div'); own.add(toastHost);
            toastHost.style.cssText = 'all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important;pointer-events:none!important';
            const shadow = toastHost.attachShadow({mode:'closed'});
            toastBox = el('div',{role:'status'});
            toastBox.style.cssText = 'max-width:min(88vw,430px);padding:10px 14px;color:white;background:#124d47;border:1px solid #7ab6a8;border-radius:7px;font:14px/1.45 system-ui;box-shadow:0 3px 20px #0003;overflow-wrap:anywhere';
            shadow.append(toastBox); document.documentElement.append(toastHost);
        }
        toastBox.textContent = message;
        if (!sticky) toastTimer = setTimeout(()=>toastHost?.remove(),5500);
    }
    let status, view, activeTab, tabButtons, frozenSelection;
    const say = text => { if (status) status.textContent = text; };
    function closePanel() {
        if (!panel) return;
        panel.dialog.close();
        panel.host.remove(); activeDialogs.delete(panel.host);
        panel = null; status = null; frozenSelection = null;
        loadAbort?.abort();
    }
    function setTab(tab) {
        loadAbort?.abort();
        activeTab = tab; say('');
        for (const [id,b] of tabButtons) b.setAttribute('aria-current',String(id === tab));
        view.replaceChildren();
        if (tab === 'capture') captureSettings();
        if (tab === 'providers') providerSettings();
        if (tab === 'route') routeSettings();
    }
    function openPanel(tab = 'capture') {
        if (panel) { setTab(tab); return; }
        if (activeDialogs.size) return;
        frozenSelection = selectedScope();
        const host = document.createElement('div'); own.add(host); activeDialogs.add(host);
        const shadow = host.attachShadow({mode:'closed'}), dialog = el('dialog',{'aria-label':'AllClip'});
        panel = {host,dialog}; view = el('main'); status = el('div',{class:'status',role:'status'});
        const nav = el('nav',{'aria-label':'Settings sections'});
        tabButtons = new Map();
        for (const [id,label] of [['capture','Capture'],['providers','Providers & models'],['route','Fallback order']]) {
            const b = btn(label,()=>setTab(id)); nav.append(b); tabButtons.set(id,b);
        }
        dialog.append(el('header',{},el('h1',{text:'AllClip'}),btn('Close',closePanel)),nav,status,view);
        dialog.addEventListener('cancel',e=>{e.preventDefault();closePanel();});
        for (const name of ['keydown','keyup','keypress','input','change','paste']) dialog.addEventListener(name,e=>e.stopPropagation());
        shadow.append(el('style',{text:style}),dialog);
        document.documentElement.append(host); dialog.showModal(); setTab(tab);
    }
    function numField(label,key,min,max) {
        const control = el('input',{type:'number',min,max,step:1,value:settings()[key]});
        control.onchange = () => {control.value = clamp(control.value,min,max,baseSettings[key]);updateSetting(key,+control.value);};
        return field(label,control);
    }
    function captureSettings() {
        const prefs = settings();
        const fmt = select([['md','Markdown (.md)'],['zip','ZIP with media files'],['html','Readable HTML'],['json','JSON with Markdown and media inventory']],prefs.format);
        fmt.onchange = ()=>updateSetting('format',fmt.value);
        const auto = select([['article','Main article'],['full','Full page']], prefs.automatic);
        auto.onchange = ()=>updateSetting('automatic',auto.value);
        const go = kind => {
            const selection = frozenSelection;
            closePanel();
            if (kind === 'element') return startPicker();
            dispatch(kind, selection);
        };
        const sel = btn('Save selection',()=>go('selection')); sel.disabled = !frozenSelection;
        view.append(el('h2',{text:'Save content'}),row(btn('Save full page',()=>go('full'),true),btn('Save article',()=>go('article')),sel,btn('Pick an element',()=>go('element'))),
            row(field('File format',fmt),field('Ctrl+Shift+S with no selection',auto)),hint('Ctrl+Shift+S saves highlighted content first. Ctrl+Shift+A opens the element picker.'),
            check('Include CSS background images',prefs.backgrounds,v=>updateSetting('backgrounds',v)),
            check('Review PDF and video options before each save',!!prefs.reviewMedia,v=>updateSetting('reviewMedia',v)),
            check('Generate an AI title and TL;DR',prefs.ai,v=>{updateSetting('ai',v);if(v&&!chain().length)say('Choose a primary model under Providers & models.');}),
            hint('AI sends captured text and media labels to the models in your fallback order. ZIP saves readable media files. Other formats keep media references.'),
            details('Download and AI limits',row(numField('Max MiB per media file','assetMB',1,512),numField('Max MiB for all media','totalMB',1,1024)),
                row(numField('AI sample (characters)','sample',1000,200000),numField('Refresh catalog after (hours)','ttl',1,168))));
    }
    function routeSettings() {
        const entries = chain(), list = el('ol',{class:'chain'});
        view.append(el('h2',{text:'Fallback order'}),hint('The first entry is primary. A failed request advances to the next configured model. If all models fail, the capture still downloads.'));
        if (!entries.length) view.append(hint('Choose a primary model to enable AI titles and summaries.'));
        entries.forEach((entry,i)=>{
            const p = provider(entry.id);
            function change(direction) {
                const latest = chain(), idx = latest.findIndex(x=>x.id===entry.id && x.model===entry.model);
                if (idx < 0) return setTab('route');
                if (direction === 0) latest.splice(idx,1);
                else if (idx+direction>=0 && idx+direction<latest.length) [latest[idx],latest[idx+direction]]=[latest[idx+direction],latest[idx]];
                set('chain',latest); setTab('route');
            }
            const up=btn('Up',()=>change(-1)), down=btn('Down',()=>change(1));
            up.disabled=!i; down.disabled=i===entries.length-1;
            list.append(el('li',{},el('strong',{text:p.name || entry.id}),document.createTextNode(' · '+entry.model+' '),up,down,btn('Remove',()=>change(0))));
        });
        view.append(list,btn('Choose a model',()=>setTab('providers'),true));
        const history = get('lastAI',[]);
        if (history.length) view.append(details('Last AI request',...history.map(h=>hint(`${h.provider} · ${h.model} · ${h.ok ? 'Success' : h.error}`))));
    }
    function addToChain(p,model,first) {
        if (!model?.trim()) { say('Select a model or enter its ID.'); return; }
        const item = {id:p.id,model:model.trim()};
        const current = chain(), exists = current.some(x=>x.id===item.id && x.model===item.model);
        if (exists && !first) { say('This model is already in the fallback order.'); return; }
        const other = current.filter(x=>x.id!==item.id||x.model!==item.model);
        set('chain',first?[item,...other]:[...other,item]); updateSetting('ai',true);
        say(`${p.name} · ${item.model} ${first || !other.length ? 'is the primary model.' : 'was added as a fallback.'}`);
    }
    function providerSettings() {
        const ids = providers(), previous = get('lastProvider','openrouter');
        const id = ids.includes(previous) ? previous : 'openrouter';
        const p = provider(id), custom = !PRESETS[id];
        const chooser=select(ids.map(x=>[x,provider(x).name]),id);
        chooser.onchange=()=>{set('lastProvider',chooser.value);setTab('providers');};
        const add=btn('Add custom endpoint',()=>{
            const key='custom-'+uid();
            set('provider.'+key,{name:'Custom endpoint',base:'',auth:'bearer',rev:uid()});set('customIds',[...customIds(),key]);set('lastProvider',key);setTab('providers');
        });
        view.append(row(field('Provider',chooser),add));
        const name=el('input',{value:p.name}), base=el('input',{type:'url',value:p.base,placeholder:'https://server.example/v1'});
        const models=el('input',{value:p.models}), chat=el('input',{value:p.chat});
        const auth=select([['bearer','Bearer token'],['header','API key header'],['none','No key']],p.auth);
        const header=el('input',{value:p.header || 'x-api-key'});
        const key=el('input',{type:'password',autocomplete:'off',placeholder:p.key?'Saved. Enter a replacement to change it.':'Enter API key'});
        const keyField=field('API key',key), headerField=field('Header name',header);
        const connection=el('div');
        if (custom) {
            connection.append(row(field('Connection name',name),field('API base URL',base)),row(field('Authentication',auth),headerField),details('OpenAI-compatible API paths',row(field('Model list path',models),field('Chat completions path',chat))));
            const show=()=>{headerField.hidden=auth.value!=='header';keyField.hidden=auth.value==='none';};auth.onchange=show;show();
        } else if (p.id === 'ollama') connection.append(hint(p.base));
        if (p.auth!=='none'||custom) connection.append(keyField);
        function save() {
            try {
                const next=custom?{name:name.value.trim()||'Custom endpoint',base:base.value.trim(),models:models.value.trim()||'models',chat:chat.value.trim()||'chat/completions',auth:auth.value,header:header.value.trim()}: {};
                const changed=custom && p.base!==next.base;
                next.key=(next.auth||p.auth)==='none'?'':key.value.trim()||(changed?'':p.key);
                const checked={...p,...next};
                endpoint(checked,checked.models);endpoint(checked,checked.chat);headersFor(checked);
                set('provider.'+id,{...next,rev:uid()});
                if(id==='openrouter')GM_setValue('openrouter_api_key',next.key);
                setTab('providers');say('Connection saved.');
            }catch(e){say(e.message);}
        }
        if (custom || p.auth!=='none') {
            const actions=row(btn('Save connection',save,true));
            if(p.key)actions.append(btn('Clear key',()=>{set('provider.'+id,{...get('provider.'+id,{}),key:'',rev:uid()});if(id==='openrouter')GM_setValue('openrouter_api_key','');setTab('providers');say('Key cleared.');}));
            if(custom)actions.append(btn('Remove connection',()=>{
                set('customIds',customIds().filter(x=>x!==id));set('chain',chain().filter(x=>x.id!==id));set('provider.'+id,{});set('catalog.'+id,null);set('catalog.'+id+'.query',null);set('filters.'+id,{});set('lastProvider','openrouter');setTab('providers');
            }));
            connection.append(actions);
        }
        view.append(connection);
        catalogSettings(p);
    }
    const serverFields = {
        openrouter:['category','supported_parameters','output_modalities','q','input_modalities','endpoints','context','min_price','max_price','arch','model_authors','providers','distillable','zdr','region','min_output_price','max_output_price','min_age_days','max_age_days','sort',
            ...['intelligence_index','coding_index','agentic_index','finance_and_accounting_index','strategy_and_ops_index','legal_index','healthcare_and_medical_index','engineering_index','economics_index','cyber_index','openness_index','multilingual_index','decision_index','tool_success_rate'].flatMap(k=>['min_'+k,'max_'+k])],
        gemini:['pageSize'],anthropic:['limit']
    };
    function catalogSettings(p) {
        const filterKey='filters.'+p.id;
        const cfg={search:'',price:'',rules:[],sort:'',desc:false,native:'',...get(filterKey,{})};
        const persist=()=>set(filterKey,cfg);
        const section=el('section'), totals=hint(''), stamp=hint(''), result=el('select',{size:6,'aria-label':'Model results'});
        const search=el('input',{type:'search',value:cfg.search,placeholder:'Name, ID, or description'});
        const price=select([['','Any price'],['Free','Free'],['Paid','Paid'],['Unreported','Unreported']],cfg.price);
        const fields=select([]), op=select(['is','contains','at least','at most','is not','present','missing']);
        const sugg=el('datalist',{id:'uwcs-suggestions'}), value=el('input',{placeholder:'Filter value'});
        value.setAttribute('list',sugg.id);
        const ruleList=el('div'), sort=select([]), json=el('pre');
        const manual=el('input',{placeholder:'Exact model ID','aria-label':'Manual model ID'});
        const native=el('input',{value:cfg.native,placeholder:p.id==='openrouter'?'category=science&zdr=true':'name=value&another=value'});
        const sugNative=el('datalist',{id:'uwcs-query-fields'});
        for(const k of serverFields[p.id]||[])sugNative.append(el('option',{value:k}));
        const keyNative=el('input',{placeholder:'Parameter name'}); keyNative.setAttribute('list',sugNative.id);
        const valNative=el('input',{placeholder:'Value'});
        const reload=btn('Refresh catalog',()=>load(true));
        const primary=btn('Use as primary',()=>choose(true),true), fallback=btn('Add fallback',()=>choose(false));
        const source=details('Selected model metadata',json);
        let index=[], rowsById=new Map(), fieldNames=[], currentRequest, autoTimer;
        function choose(first){
            const id=manual.value.trim()||result.value;
            const item=rowsById.get(id);
            if(item && !canSummarize(item.raw))return say('The provider lists this model for a different operation. Choose a text chat model.');
            if(!p.base)return say('Save this connection first.');
            addToChain(p,id,first);
        }
        function selected(){
            const item=rowsById.get(manual.value.trim()||result.value);
            const usable=!!(manual.value.trim()||result.value)&&(!item||canSummarize(item.raw));
            primary.disabled=!usable;fallback.disabled=!usable;
            json.textContent=item?JSON.stringify(item.raw,null,2):'';
            source.hidden=!item;
        }
        function render(){
            const term=cfg.search.trim().toLowerCase(), previous=result.value;
            const filtered=index.filter(m=>(!term||m.search.includes(term))&&(!cfg.price||m.fields.get('Text pricing')?.includes(cfg.price))&&cfg.rules.every(r=>matchesRule(m.fields,r)));
            if(cfg.sort)filtered.sort((a,b)=>{
                const av=a.fields.get(cfg.sort)?.[0],bv=b.fields.get(cfg.sort)?.[0];
                if(av==null||bv==null)return av==null?(bv==null?0:1):-1;
                const order=numericValue(av)&&numericValue(bv)?Number(av)-Number(bv):String(av).localeCompare(String(bv),undefined,{numeric:true});
                return cfg.desc?-order:order;
            });
            const fragment=document.createDocumentFragment();
            for(const m of filtered){
                const c=m.fields.get('Context (tokens)')?.[0];
                const label=m.id+(m.fields.get('Text pricing')?.[0]==='Free'?' · Free':'')+(c?' · '+Number(c).toLocaleString()+' tokens':'')+(!canSummarize(m.raw)?' · Other operation':'');
                fragment.append(new Option(label,m.id));
            }
            result.replaceChildren(fragment);
            if(filtered.some(m=>m.id===previous))result.value=previous;
            else if(filtered.length)result.selectedIndex=0;
            totals.textContent=`${filtered.length} of ${index.length} models`;
            ruleList.replaceChildren();
            for(const [i,r]of cfg.rules.entries())ruleList.append(btn('Remove · '+[r.field,r.op,r.value].filter(Boolean).join(' '),()=>{cfg.rules.splice(i,1);persist();render();}));
            selected();
        }
        function suggestions(){
            const name=fields.value;
            const vals=new Set(index.flatMap(m=>m.fields.get(name)||[]).map(String));
            const fragment=document.createDocumentFragment();
            // Long descriptions and IDs remain fully searchable with a typed value.
            for(const s of [...vals].filter(s=>s.length<=100).sort().slice(0,300))fragment.append(new Option(s,s));
            sugg.replaceChildren(fragment);
            value.disabled=['missing','present'].includes(op.value);
        }
        async function load(force=false){
            clearTimeout(autoTimer);loadAbort?.abort();
            const ac=new AbortController();loadAbort=ac;currentRequest=ac;
            stamp.textContent='Loading catalog…';reload.disabled=true;
            try{
                const data=await catalog(p,{force,query:cfg.native,signal:ac.signal});
                if(ac.signal.aborted||currentRequest!==ac||!section.isConnected)return;
                index=data.rows.map(raw=>{
                    const id=modelId(raw,p);
                    return {id,raw,fields:fieldsFor(raw,p),search:[id,raw.name,raw.displayName,raw.display_name,raw.description].filter(Boolean).join(' ').toLowerCase()};
                });
                rowsById=new Map(index.map(m=>[m.id,m]));
                fieldNames=[...new Set(index.flatMap(m=>[...m.fields.keys()]))].sort((a,b)=>a.localeCompare(b));
                const options=fieldNames.map(k=>new Option(k,k));
                fields.replaceChildren(...options);
                if(fieldNames.includes('owned_by'))fields.value='owned_by';
                sort.replaceChildren(new Option('Provider order',''),...fieldNames.map(k=>new Option(k,k)));
                sort.value=cfg.sort;
                stamp.textContent=(data.stale?'Cached catalog. Refresh failed: '+data.stale+'. ':data.cached?'Cached catalog. ':'Live catalog. ')+'Updated '+new Date(data.time).toLocaleString()+'.';
                suggestions();render();
                const delay=data.stale?Math.max(3600000,settings().ttl*3600000):Math.max(30000,data.time+settings().ttl*3600000-Date.now());
                autoTimer=setTimeout(()=>{if(section.isConnected&&!ac.signal.aborted)load(true);},delay);
                ac.signal.addEventListener('abort',()=>clearTimeout(autoTimer),{once:true});
            }catch(e){
                if(!ac.signal.aborted){index=[];rowsById.clear();fields.replaceChildren();render();stamp.textContent=e.message+'. You can also enter a model ID.';}
            }finally{if(currentRequest===ac)reload.disabled=false;}
        }
        search.oninput=()=>{cfg.search=search.value;persist();render();};
        price.onchange=()=>{cfg.price=price.value;persist();render();};
        fields.onchange=suggestions;op.onchange=suggestions;
        sort.onchange=()=>{cfg.sort=sort.value;persist();render();};
        result.onchange=()=>{manual.value='';selected();};manual.oninput=selected;
        const addRule=btn('Add filter',()=>{
            if(!fields.value)return;
            if(!value.disabled&&!value.value.trim())return say('Enter a filter value.');
            if(['at least','at most'].includes(op.value)&&!numericValue(value.value))return say('Enter a number for this comparison.');
            cfg.rules.push({field:fields.value,op:op.value,value:value.disabled?'':value.value.trim()});value.value='';persist();render();
        });
        const params=details('Provider query parameters',hint('These parameters go to the model list endpoint. Use the provider’s documented names and values.'),
            row(field('Parameter',keyNative),field('Value',valNative),btn('Add parameter',()=>{
                if(!keyNative.value.trim())return;
                const params=new URLSearchParams(native.value);params.set(keyNative.value.trim(),valNative.value.trim());native.value=params.toString();keyNative.value='';valNative.value='';
            })),sugNative,row(field('Query string',native),btn('Apply query',()=>{
                try{catalogURL(p,native.value);cfg.native=native.value.trim();persist();load(true);}catch(e){say(e.message);}
            })));
        section.append(el('h2',{text:'Model catalog'}),row(field('Search models',search),field('Text pricing',price),reload),stamp,
            details('Filter and sort by model fields',hint('Combine filters. Each field comes from this provider’s model records.'),
                row(field('Model field',fields),field('Condition',op),field('Value',value),addRule),sugg,ruleList,
                row(field('Sort by',sort),check('Descending',cfg.desc,v=>{cfg.desc=v;persist();render();})),btn('Clear local filters',()=>{Object.assign(cfg,{search:'',price:'',rules:[],sort:'',desc:false});persist();setTab('providers');})),
            params,totals,result,source,details('Enter a model ID manually',manual),row(primary,fallback,btn('View fallback order',()=>setTab('route'))));
        view.append(section);selected();
        if(p.base)load();else stamp.textContent='Save the endpoint to load its catalog.';
    }
    let picker = null;
    function readableFrames(doc, found = new Set()) {
        if (!doc || found.has(doc)) return found;
        found.add(doc);
        for (const frame of doc.querySelectorAll('iframe,frame')) {
            try { if(frame.contentDocument?.documentElement) readableFrames(frame.contentDocument,found); } catch { /* Foreign frame. */ }
        }
        return found;
    }
    function startPicker() {
        if (busy || picker) return;
        const overlay=document.createElement('div'); own.add(overlay);
        overlay.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483646!important';
        const shadow=overlay.attachShadow({mode:'closed'}), box=el('div');
        box.style.cssText='position:absolute;border:2px solid #087f70;background:#0f938429;box-sizing:border-box';
        shadow.append(box);document.documentElement.append(overlay);
        let target, childStack=[];
        const docs=readableFrames(document);
        function highlight(n) {
            if(!n?.getBoundingClientRect || own.has(n))return;
            target=n;const rect=n.getBoundingClientRect();let x=rect.left,y=rect.top,win=n.ownerDocument.defaultView;
            while(win && win!==window) {
                const f=win.frameElement;if(!f)break;const fr=f.getBoundingClientRect();
                x+=fr.left+f.clientLeft;y+=fr.top+f.clientTop;win=f.ownerDocument.defaultView;
            }
            Object.assign(box.style,{left:x+'px',top:y+'px',width:rect.width+'px',height:rect.height+'px'});
            toast(`Pick <${n.localName}> · Click or Enter to save · ↑ parent · ↓ child · Esc to cancel`,true);
        }
        function clean(){
            for(const d of docs){d.removeEventListener('pointerover',over,true);d.removeEventListener('click',click,true);d.removeEventListener('keydown',key,true);}
            overlay.remove();toastHost?.remove();picker=null;
        }
        function over(e) {if(!e.isTrusted)return;childStack=[];highlight(e.composedPath()[0]);}
        function take(n) {if(!n||own.has(n))return;clean();runCapture({node:n,doc:n.ownerDocument,scope:'Element'});}
        function click(e) {
            if(!e.isTrusted)return;
            e.preventDefault();e.stopImmediatePropagation();take(target||e.composedPath()[0]);
        }
        function key(e) {
            if(!e.isTrusted||!['Escape','ArrowUp','ArrowDown','Enter'].includes(e.key))return;
            e.preventDefault();e.stopImmediatePropagation();
            if(e.key==='Escape'){clean();return;}
            if(e.key==='Enter'){take(target);return;}
            const parent=target?.parentElement || target?.getRootNode()?.host;
            if(e.key==='ArrowUp'&&parent){childStack.push(target);highlight(parent);}
            if(e.key==='ArrowDown'&&childStack.length)highlight(childStack.pop());
        }
        for(const d of docs){d.addEventListener('pointerover',over,true);d.addEventListener('click',click,true);d.addEventListener('keydown',key,true);}
        picker={clean};toast('Click an element to save it. Use ↑ to select its parent. Esc cancels.',true);
    }
    async function runCapture(scope, review = false) {
        if(busy){toast('A capture is in progress.');return;}
        const ac=new AbortController();busy=ac;
        try{
            const prefs=settings();
            toast('Capturing '+scope.scope.toLowerCase()+'…',true);
            const cap=capture(scope,prefs);
            if(!captureText(cap.root).trim()&&!cap.assets.length&&!cap.root.querySelector('math,hr')) throw Error('This scope contains no readable content or media.');
            if(review || prefs.reviewMedia){toastHost?.remove();if(!await mediaReview(cap,prefs,ac.signal)){toast('Capture canceled.');return;}}
            const meta=await enrich(cap,prefs,ac.signal,msg=>toast('Generating title and TL;DR · '+msg,true));
            if(meta.attempts.length)set('lastAI',meta.attempts);
            if(ac.signal.aborted)throw Error('Canceled');
            const blob=await makeOutput(cap,meta,prefs,ac.signal,msg=>toast(msg+' · Esc to cancel',true));
            if(ac.signal.aborted)throw Error('Canceled');
            const dt=new Date(cap.time),date=[dt.getDate(),dt.getMonth()+1,dt.getFullYear()].map(n=>String(n).padStart(2,'0')).join('');
            const ext=['md','html','json','zip'].includes(prefs.format)?prefs.format:'md';
            const state=await download(blob,`${filename(meta.title)}_${date}.${ext}`);
            const saved=prefs.format==='zip'?` · ${cap.assets.filter(a=>a.status==='saved').length}/${cap.assets.length} media files saved`:'';
            const ai=meta.attempts.length&&!meta.model?' · AI unavailable; used the local title':'';
            toast(`${state}: ${scope.scope}${saved}${ai}`);
        }catch(e){toast(ac.signal.aborted?'Capture canceled.':`Capture: ${e.message}`);}
        finally{if(busy===ac)busy=null;}
    }
    function dispatch(mode, selection, review = false) {
        if(panel)closePanel();
        if(picker)picker.clean();
        if(mode==='auto'||mode==='selection'){
            const picked=selection || selectedScope();
            if(picked)return runCapture(picked,review);
            if(mode==='selection'){toast('Highlight text or media on the page first.');return;}
            mode=settings().automatic==='full'?'full':'article';
        }
        const full=mode==='full';
        runCapture({scope:full?'Full page':'Main article',doc:document,node:full?document.body||document.documentElement:mainElement(document)},review);
    }
    function keyboard(e) {
        if(!e.isTrusted||e.defaultPrevented||e.repeat||e.isComposing||activeDialogs.size||picker)return;
        if(e.key==='Escape'&&busy){busy.abort();return;}
        if(!(e.ctrlKey||e.metaKey)||!e.shiftKey||e.altKey)return;
        const k=e.key.toLowerCase();
        if(k!=='s'&&k!=='a')return;
        const target=e.composedPath()[0];
        if(target?.matches?.('input[type="password" i]'))return;
        e.preventDefault();e.stopPropagation();
        if(k==='s')dispatch('auto');else startPicker();
    }
    function bindDoc(doc) {
        if(!doc || knownDocs.has(doc))return;
        knownDocs.add(doc);doc.addEventListener('keydown',keyboard,true);
        function bindFrame(f) {try{if(f?.contentDocument)bindDoc(f.contentDocument);}catch{/* Foreign frame. */}}
        doc.addEventListener('load',e=>{if(e.target?.matches?.('iframe,frame'))bindFrame(e.target);},true);
        for(const f of doc.querySelectorAll('iframe,frame'))bindFrame(f);
    }
    migrate();
    bindDoc(document);
    GM_registerMenuCommand('Save automatically (Ctrl+Shift+S)',()=>dispatch('auto'));
    GM_registerMenuCommand('Save full page',()=>dispatch('full'));
    GM_registerMenuCommand('Save main article',()=>dispatch('article'));
    GM_registerMenuCommand('Save exact selection',()=>dispatch('selection'));
    GM_registerMenuCommand('Save with media options',()=>{const s=selectedScope();dispatch(s?'selection':'full',s,true);});
    GM_registerMenuCommand('Pick an element (Ctrl+Shift+A)',startPicker);
    GM_registerMenuCommand('Settings',()=>openPanel('capture'));
    GM_registerMenuCommand('Providers and models',()=>openPanel('providers'));
    GM_registerMenuCommand('Fallback order',()=>openPanel('route'));
    GM_registerMenuCommand('Cancel active capture',()=>{if(picker)picker.clean();busy?.abort();});
})();
