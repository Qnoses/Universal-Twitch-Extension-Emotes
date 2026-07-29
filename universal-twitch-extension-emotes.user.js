// ==UserScript==
// @name         Universal Twitch Extension Emotes (BTTV / FFZ / 7TV)
// @namespace    https://github.com/Qnoses
// @version      2.7
// @description  Renders BetterTTV, FrankerFaceZ and 7TV emotes in any Twitch chat, wherever that chat is rendered — twitch.tv itself, embedded chat iframes on third-party sites, popout chat, OBS browser sources, KapChat, and generic tmi.js chat widgets — by detecting chat structurally rather than by hostname. Also adds the channel's BTTV/FFZ/7TV emotes as sections in Twitch's own emote picker.
// @author       Qnoses
// @license      MIT
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @connect      api.betterttv.net
// @connect      api.frankerfacez.com
// @connect      7tv.io
// @connect      cdn.7tv.app
// @connect      cdn.betterttv.net
// @connect      cdn.frankerfacez.com
// @connect      api.ivr.fi
// @connect      decapi.me
// @homepageURL  https://github.com/Qnoses/Universal-Twitch-Extension-Emotes
// @supportURL   https://github.com/Qnoses/Universal-Twitch-Extension-Emotes/issues
// @downloadURL  https://raw.githubusercontent.com/Qnoses/Universal-Twitch-Extension-Emotes/main/universal-twitch-extension-emotes.user.js
// @updateURL    https://raw.githubusercontent.com/Qnoses/Universal-Twitch-Extension-Emotes/main/universal-twitch-extension-emotes.user.js
// ==/UserScript==
//
// NOTE: there is deliberately no @noframes here. Embedded Twitch chat lives in
// a twitch.tv iframe, so the script MUST be allowed to run in sub-frames — that
// omission is the whole premise. @noframes takes no value: writing
// "@noframes false" still switches it ON and breaks every embed.
/* eslint-disable no-multi-spaces */

/*
 * ARCHITECTURE
 * ────────────────────────────────────────────────────────────────────────────
 * The usual mistake in scripts like this is `@match *://*.twitch.tv/*` plus
 * @noframes. That misses two whole classes of chat:
 *
 *   1. Embedded chat  — <iframe src="https://embed.twitch.tv/?channel=x&parent=y">
 *      The iframe document IS a twitch.tv document, so it is reachable only if
 *      the script is allowed to run in sub-frames. This script therefore does
 *      NOT set @noframes, and every frame independently runs detection.
 *
 *   2. Non-Twitch renderers — KapChat, StreamElements overlays, custom
 *      tmi.js/IRC-over-websocket clients, multi-stream sites, OBS browser
 *      sources. These are ordinary DOM on an unrelated origin. They are found
 *      by a structural detector rather than by hostname.
 *
 * So the match is an all-sites glob and the cost is pushed into a self-limiting
 * detector (see Detector below) that idles out on pages with no chat.
 *
 * PIPELINE
 *   detect chat root → resolve channel login → login → twitch user id →
 *   fetch 6 emote sets in parallel → flatten into one Map<code, Emote> →
 *   MutationObserver on the root → per-message TreeWalker → token replacement
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════
   * 1. CONFIG
   * ════════════════════════════════════════════════════════════════════════ */

  const CONFIG = {
    // Emote size to request from each CDN: '1x' | '2x' | '3x' | '4x'
    size: '2x',
    // Rendered cap in CSS pixels. Twitch's own emotes are 28px tall.
    maxHeight: 28,
    // Providers. Turn any off to skip its network calls entirely.
    providers: { sevenTV: true, bttv: true, ffz: true },
    // Later entries win on code collisions, so channel sets override globals.
    priority: [
      'ffz-global', 'bttv-global', '7tv-global',
      'ffz-channel', 'bttv-channel', '7tv-channel',
    ],
    // Emote list cache lifetime.
    cacheTTL: 30 * 60 * 1000,
    // Structural detection on non-Twitch origins. Set false to restrict the
    // script to Twitch-served documents (main site + embed/popout iframes).
    genericDetection: true,
    // Hovering an emote shows a small card with its name and provider,
    // matching the chat box preview. false falls back to a plain tooltip.
    hoverCard: true,
    // Add provider sections to Twitch's native emote picker (twitch.tv only).
    pickerSections: true,
    // Also list the three global sets in the picker, not just channel sets.
    pickerIncludeGlobals: false,
    // Add a category icon per provider to the picker's right-hand nav rail.
    pickerNavIcons: true,
    // Emote counts, channel, and the set/reload controls, shown in the picker.
    pickerPanel: true,
    // Draw emotes over their codes in the chat input as you type.
    composerPreview: true,
    // Show a preview card above the input for the code under the caret.
    composerBubble: true,
    // Per-host channel overrides, for sites where the channel isn't inferable.
    // e.g. 'chat.example.com': 'forsen'
    channelOverrides: {},
    // Hosts to never touch.
    blocklist: ['docs.google.com', 'mail.google.com'],
    debug: false,
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * 2. PLATFORM SHIMS
   * ════════════════════════════════════════════════════════════════════════ */

  // Display names. Never show the internal provider keys: "bttv channel" is
  // not a thing anyone calls it.
  const PROVIDER_LABEL = {
    '7tv-channel': '7TV',          '7tv-global': '7TV Global',
    'bttv-channel': 'BetterTTV',   'bttv-global': 'BetterTTV Global',
    'ffz-channel': 'FrankerFaceZ', 'ffz-global': 'FrankerFaceZ Global',
  };

  const log = (...a) => CONFIG.debug && console.log('%c[UTE]', 'color:#8b5cf6', ...a);
  const warn = (...a) => console.warn('[UTE]', ...a);

  const gmGet = (k, d) => {
    try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) { /* noop */ }
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
  };
  const gmSet = (k, v) => {
    try { if (typeof GM_setValue === 'function') return GM_setValue(k, v); } catch (e) { /* noop */ }
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ }
  };

  const xhr = (typeof GM_xmlhttpRequest === 'function')
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : null;

  /**
   * Cross-origin GET. Uses GM_xmlhttpRequest so it is immune to the page's
   * CSP connect-src and to CORS — which matters, because twitch.tv's CSP
   * would otherwise block plain fetch() to betterttv.net.
   */
  function request(url, { json = true, responseType } = {}) {
    return new Promise((resolve, reject) => {
      if (!xhr) {
        // Last resort: works only if the page's CSP permits the origin.
        fetch(url, { credentials: 'omit' })
          .then(r => (r.ok ? (json ? r.json() : r.text()) : Promise.reject(new Error(r.status))))
          .then(resolve, reject);
        return;
      }
      xhr({
        method: 'GET',
        url,
        timeout: 15000,
        responseType,
        onload: r => {
          if (r.status < 200 || r.status >= 300) return reject(new Error(`${r.status} ${url}`));
          if (responseType) return resolve(r.response);
          try { resolve(json ? JSON.parse(r.responseText) : r.responseText); }
          catch (e) { reject(e); }
        },
        onerror: () => reject(new Error(`network ${url}`)),
        ontimeout: () => reject(new Error(`timeout ${url}`)),
      });
    });
  }

  function addStyle(css) {
    try { if (typeof GM_addStyle === 'function') return GM_addStyle(css); } catch (e) { /* noop */ }
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 3. EMOTE PROVIDERS
   *
   * Each returns Emote[]:
   *   { code, url, srcset, provider, zeroWidth, width, height }
   * ════════════════════════════════════════════════════════════════════════ */

  const SIZE_INDEX = { '1x': 0, '2x': 1, '3x': 2, '4x': 3 };
  const sizeIdx = () => SIZE_INDEX[CONFIG.size] ?? 1;

  // ── 7TV ──────────────────────────────────────────────────────────────────
  // v3 REST. `emote.flags & 1` is the ActiveEmote ZeroWidth bit (per-set
  // override); `emote.data.flags & 256` is the emote-level ZeroWidth bit.
  const SevenTV = {
    global: () => request('https://7tv.io/v3/emote-sets/global')
      .then(d => SevenTV.parse(d.emotes || [], '7tv-global')),

    channel: id => request(`https://7tv.io/v3/users/twitch/${id}`)
      .then(d => SevenTV.parse((d.emote_set && d.emote_set.emotes) || [], '7tv-channel')),

    parse(list, provider) {
      const out = [];
      for (const e of list) {
        const data = e.data || e;
        const host = data.host;
        if (!host || !host.url) continue;
        const base = host.url.startsWith('//') ? 'https:' + host.url : host.url;
        const files = host.files || [];
        // Prefer webp; fall back to whatever variant of that scale exists.
        const at = n => {
          const w = files.find(f => f.name === `${n}x.webp`);
          if (w) return { url: `${base}/${n}x.webp`, w: w.width, h: w.height };
          const any = files.find(f => f.name.startsWith(`${n}x.`) && f.format !== 'AVIF');
          return any ? { url: `${base}/${any.name}`, w: any.width, h: any.height } : null;
        };
        const scales = [at(1), at(2), at(3), at(4)];
        const chosen = scales[sizeIdx()] || scales.filter(Boolean).pop() || scales.find(Boolean);
        if (!chosen) continue;
        out.push({
          code: e.name || data.name,
          provider,
          url: chosen.url,
          srcset: scales.filter(Boolean).map((s, i) => `${s.url} ${i + 1}x`).join(', '),
          width: chosen.w, height: chosen.h,
          zeroWidth: ((e.flags | 0) & 1) === 1 || ((data.flags | 0) & 256) === 256,
        });
      }
      return out;
    },
  };

  // ── BetterTTV ────────────────────────────────────────────────────────────
  // CDN only serves 1x/2x/3x, so 4x clamps to 3x.
  const BTTV_ZW_CODES = new Set([
    'SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'CandyCane', 'ReinDeer',
    'cvMask', 'cvHazmat',
  ]);

  const BTTV = {
    global: () => request('https://api.betterttv.net/3/cached/emotes/global')
      .then(d => BTTV.parse(d || [], 'bttv-global')),

    channel: id => request(`https://api.betterttv.net/3/cached/users/twitch/${id}`)
      .then(d => BTTV.parse([...(d.channelEmotes || []), ...(d.sharedEmotes || [])], 'bttv-channel')),

    parse(list, provider) {
      const n = Math.min(sizeIdx() + 1, 3);
      return list.filter(e => e && e.id && e.code).map(e => ({
        code: e.code,
        provider,
        url: `https://cdn.betterttv.net/emote/${e.id}/${n}x.webp`,
        srcset: [1, 2, 3].map(i => `https://cdn.betterttv.net/emote/${e.id}/${i}x.webp ${i}x`).join(', '),
        width: null, height: null,
        zeroWidth: BTTV_ZW_CODES.has(e.code),
      }));
    },
  };

  // ── FrankerFaceZ ─────────────────────────────────────────────────────────
  // The room endpoint doubles as a login→twitch_id resolver, which is why it
  // is fetched first in the pipeline.
  const FFZ = {
    global: () => request('https://api.frankerfacez.com/v1/set/global')
      .then(d => FFZ.parseSets(d.sets, d.default_sets, 'ffz-global')),

    room: login => request(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login)}`),

    fromRoom: d => FFZ.parseSets(d.sets, Object.keys(d.sets || {}), 'ffz-channel'),

    parseSets(sets, wanted, provider) {
      const out = [];
      if (!sets) return out;
      const keys = (wanted || Object.keys(sets)).map(String);
      for (const k of keys) {
        const set = sets[k];
        if (!set || !set.emoticons) continue;
        for (const e of set.emoticons) {
          const urls = e.animated && Object.keys(e.animated).length ? e.animated : e.urls;
          if (!urls) continue;
          const norm = u => (u.startsWith('//') ? 'https:' + u : u);
          const scales = ['1', '2', '4'].map(s => (urls[s] ? norm(urls[s]) : null));
          const pick = [scales[0], scales[1], scales[2], scales[2]][sizeIdx()]
            || scales.filter(Boolean).pop();
          if (!pick) continue;
          out.push({
            code: e.name,
            provider,
            url: pick,
            srcset: scales.map((u, i) => (u ? `${u} ${[1, 2, 4][i]}x` : null)).filter(Boolean).join(', '),
            width: e.width || null, height: e.height || null,
            // FFZ "modifier" emotes are its overlay mechanism.
            zeroWidth: !!e.modifier,
          });
        }
      }
      return out;
    },
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * 4. CHANNEL RESOLUTION
   * ════════════════════════════════════════════════════════════════════════ */

  // Twitch paths that are never channel names.
  const TWITCH_RESERVED = new Set([
    'directory', 'settings', 'downloads', 'jobs', 'turbo', 'friends', 'wallet',
    'subscriptions', 'inventory', 'drops', 'store', 'p', 'privacy', 'search',
    'videos', 'u', 'team', 'prime', 'login', 'signup', 'following', 'broadcast',
  ]);

  function channelFromUrl(url = location.href) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }

    // Overlay/embed widgets nearly all take ?channel=
    const q = u.searchParams.get('channel') || u.searchParams.get('channelName')
      || u.searchParams.get('room') || u.searchParams.get('login');
    if (q) return q.replace(/^#/, '').toLowerCase();

    if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;

    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    // /embed/<ch>/chat, /popout/<ch>/chat, /moderator/<ch>
    if (['embed', 'popout', 'moderator'].includes(seg[0]) && seg[1]) return seg[1].toLowerCase();
    if (seg[0] === 'videos' || TWITCH_RESERVED.has(seg[0])) return null;
    if (/^[a-z0-9_]{3,25}$/i.test(seg[0])) return seg[0].toLowerCase();
    return null;
  }

  /**
   * Walk up React's fiber tree looking for a channelLogin prop. Only used on
   * twitch.tv itself. On Firefox, Xray vision hides the page's own expando
   * properties, hence wrappedJSObject.
   */
  function channelFromReact() {
    const seeds = document.querySelectorAll(
      '[data-a-target="chat-input"], .chat-shell, .stream-chat, [data-a-target="chat-scroller"]'
    );
    for (const seed of seeds) {
      let node = seed.wrappedJSObject || seed;
      for (let up = 0; node && up < 20; up++, node = node.parentElement) {
        const key = Object.keys(node).find(
          k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (!key) continue;
        let fiber = node[key];
        for (let i = 0; i < 80 && fiber; i++, fiber = fiber.return) {
          const p = fiber.memoizedProps;
          if (!p) continue;
          const c = p.channelLogin || p.channelName || p.login
            || (p.channel && (p.channel.login || p.channel.name));
          if (typeof c === 'string' && /^[a-z0-9_]{3,25}$/i.test(c)) return c.toLowerCase();
        }
      }
    }
    return null;
  }

  function channelFromDom() {
    // Common data attributes on third-party chat widgets.
    const el = document.querySelector('[data-channel], [data-channel-name], [data-room]');
    if (el) {
      const v = el.dataset.channel || el.dataset.channelName || el.dataset.room;
      if (v) return v.replace(/^#/, '').toLowerCase();
    }
    return null;
  }

  function resolveChannel() {
    const host = location.hostname;
    if (CONFIG.channelOverrides[host]) return CONFIG.channelOverrides[host];

    const manual = gmGet(`ute:manual:${host}${location.pathname}`, null);
    if (manual) return manual;

    return channelFromUrl()
      || (/(^|\.)twitch\.tv$/i.test(host) ? channelFromReact() : null)
      || channelFromDom()
      // Parent frame URL, for same-origin nesting (popout inside a dashboard).
      || (() => { try { return window.parent !== window ? channelFromUrl(document.referrer) : null; } catch (e) { return null; } })();
  }

  /** login → numeric Twitch user id, without needing a Twitch client id. */
  async function resolveTwitchId(login) {
    // Preferred: FFZ's room endpoint returns twitch_id AND the channel's FFZ
    // emote sets, so this single call does double duty.
    try {
      const room = await FFZ.room(login);
      if (room && room.room && room.room.twitch_id) {
        return { id: String(room.room.twitch_id), ffzRoom: room };
      }
    } catch (e) { log('ffz room miss', e.message); }

    try {
      const d = await request(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(login)}`);
      const u = Array.isArray(d) ? d[0] : d;
      if (u && u.id) return { id: String(u.id) };
    } catch (e) { log('ivr miss', e.message); }

    try {
      const t = await request(`https://decapi.me/twitch/id/${encodeURIComponent(login)}`, { json: false });
      if (/^\d+$/.test(t.trim())) return { id: t.trim() };
    } catch (e) { log('decapi miss', e.message); }

    return { id: null };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 5. EMOTE STORE
   * ════════════════════════════════════════════════════════════════════════ */

  /** FNV-1a over code|url pairs: enough to tell "same emotes" from "changed". */
  function emoteSignature(emotes) {
    let h = 0x811c9dc5;
    for (const e of emotes) {
      const s = e.code + '\u0000' + e.url;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    return emotes.length + ':' + (h >>> 0).toString(36);
  }

  const Store = {
    map: new Map(),        // code → Emote
    channel: null,
    channelId: null,
    counts: {},
    signature: '',

    async load(login) {
      const cacheKey = `ute:emotes:${login || '__global__'}`;
      const cached = gmGet(cacheKey, null);
      const age = cached ? Date.now() - cached.ts : Infinity;
      if (cached && age < CONFIG.cacheTTL) {
        this.ingest(cached.emotes);
        this.channel = login;
        log('cache hit', login, this.map.size);
        Menu.register();
        // Only reach out again once the cache is genuinely ageing. Refreshing
        // on every page view meant six API calls per Twitch tab for emotes we
        // already had.
        if (age > CONFIG.cacheTTL / 2) setTimeout(() => this.fetchAll(login, cacheKey), 5000);
        return;
      }
      await this.fetchAll(login, cacheKey);
    },

    async fetchAll(login, cacheKey) {
      const { providers } = CONFIG;
      let ffzRoom = null;
      let channelId = null;

      if (login) {
        const res = await resolveTwitchId(login);
        channelId = res.id;
        ffzRoom = res.ffzRoom || null;
        this.channelId = channelId;
      }

      const jobs = [];
      if (providers.sevenTV) {
        jobs.push(SevenTV.global());
        if (channelId) jobs.push(SevenTV.channel(channelId));
      }
      if (providers.bttv) {
        jobs.push(BTTV.global());
        if (channelId) jobs.push(BTTV.channel(channelId));
      }
      if (providers.ffz) {
        jobs.push(FFZ.global());
        if (ffzRoom) jobs.push(Promise.resolve(FFZ.fromRoom(ffzRoom)));
        else if (login) jobs.push(FFZ.room(login).then(FFZ.fromRoom));
      }

      const settled = await Promise.allSettled(jobs);
      const emotes = [];
      for (const s of settled) {
        if (s.status === 'fulfilled') emotes.push(...s.value);
        else log('provider failed:', s.reason && s.reason.message);
      }

      if (!emotes.length) { warn('no emotes resolved for', login); return; }

      // Slide the cache forward regardless, so a refresh that found nothing
      // new still buys another full TTL of quiet.
      gmSet(cacheKey, { ts: Date.now(), emotes });

      if (this.channel === login && emoteSignature(emotes) === this.signature) {
        log('emotes unchanged; skipping rebuild');
        return;
      }

      this.ingest(emotes);
      this.channel = login;
      log('loaded', this.map.size, 'emotes for', login, this.counts);
      Menu.register();
      Renderer.reprocessAll();
      Picker.refresh();
      Composer.schedule();
    },

    ingest(emotes) {
      this.map.clear();
      this.counts = {};
      const rank = new Map(CONFIG.priority.map((p, i) => [p, i]));
      // Sort ascending by priority so later writes (channel sets) overwrite.
      const sorted = emotes.slice().sort(
        (a, b) => (rank.get(a.provider) ?? 0) - (rank.get(b.provider) ?? 0)
      );
      for (const e of sorted) {
        if (!e.code || !e.url) continue;
        this.map.set(e.code, e);
      }
      for (const e of this.map.values()) {
        this.counts[e.provider] = (this.counts[e.provider] || 0) + 1;
      }
      this.signature = emoteSignature(emotes);
    },
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * 6. RENDERING
   * ════════════════════════════════════════════════════════════════════════ */

  addStyle(`
    .ute-wrap {
      position: relative;
      display: inline-block;
      vertical-align: middle;
      line-height: 0;
    }
    .ute-emote {
      max-height: ${CONFIG.maxHeight}px;
      width: auto;
      vertical-align: middle;
      margin: -2px 1px;
      object-fit: contain;
    }
    .ute-emote.ute-zw {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      margin: 0;
    }
    .ute-emote.ute-broken { display: none; }
  `);

  /**
   * Replaces the browser's `title` tooltip on rendered emotes with the same
   * card the chat box uses, so an emote reads the same wherever you meet it.
   */
  const Tooltip = {
    el: null,

    ensure() {
      if (this.el && this.el.isConnected) return this.el;
      const el = document.createElement('div');
      el.className = 'ute-card ute-tip';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<img alt=""><span class="ute-card-code"></span>' +
                     '<span class="ute-card-src"></span>';
      document.body.appendChild(el);
      this.el = el;
      return el;
    },

    show(img, below) {
      const el = this.ensure();
      el.querySelector('img').src = img.currentSrc || img.src;
      el.querySelector('.ute-card-code').textContent = img.dataset.uteCode || img.alt || '';
      el.querySelector('.ute-card-src').textContent = img.dataset.uteSrc || '';
      el.classList.add('ute-on');            // measure only once it's laid out

      const r = img.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      // In the picker Twitch puts its own tooltip below the emote; in chat
      // there is rarely room below, so that stays above.
      let top = below ? r.bottom + 6 : r.top - el.offsetHeight - 6;
      if (!below && top < 4) top = r.bottom + 6;
      const left = Math.max(4, Math.min(
        r.left + r.width / 2 - el.offsetWidth / 2, vw - el.offsetWidth - 4));
      el.style.top = Math.round(top) + 'px';
      el.style.left = Math.round(left) + 'px';
    },

    hide() { if (this.el) this.el.classList.remove('ute-on'); },
  };

  /**
   * Nothing under these is chat, and some of it is ours. The chat root is the
   * whole chat room, so the composer's own preview card lives inside it: when
   * that card wrote the emote's name into itself, the observer saw a new text
   * node and painted a second copy of the emote over it.
   */
  const NOT_CHAT = 'input, textarea, [contenteditable="true"], ' +
                   '.ute-wrap, .ute-card, .ute-panel, .chat-input';

  const blobCache = new Map();

  /**
   * Some hosts ship a strict img-src CSP that blocks the emote CDNs. Rather
   * than pre-emptively downloading everything, we let the <img> fail and only
   * then re-fetch through GM_xmlhttpRequest as a blob. Self-healing, and free
   * on the 99% of sites where direct loading works.
   */
  function repairViaBlob(img, emote) {
    if (!xhr) { img.classList.add('ute-broken'); return; }
    const cached = blobCache.get(emote.url);
    if (cached) { img.src = cached; return; }
    request(emote.url, { json: false, responseType: 'blob' })
      .then(blob => {
        const objUrl = URL.createObjectURL(blob);
        blobCache.set(emote.url, objUrl);
        img.src = objUrl;
      })
      .catch(() => img.classList.add('ute-broken'));
  }

  function makeImg(emote, isOverlay) {
    const img = document.createElement('img');
    img.className = 'ute-emote' + (isOverlay ? ' ute-zw' : '');
    img.src = emote.url;
    if (emote.srcset) img.srcset = emote.srcset;
    img.alt = emote.code;               // keeps text selection/copy intact
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.uteCode = emote.code;
    img.dataset.uteSrc = PROVIDER_LABEL[emote.provider] || emote.provider;
    if (!CONFIG.hoverCard) img.title = `${emote.code} — ${img.dataset.uteSrc}`;
    if (emote.height) img.style.maxHeight = Math.min(emote.height, CONFIG.maxHeight) + 'px';
    img.addEventListener('error', () => repairViaBlob(img, emote), { once: true });
    return img;
  }

  const Renderer = {
    roots: new Set(),

    /**
     * Replace emote codes inside one text node.
     *
     * Note on React safety: we only ever replace text nodes, never the element
     * that React owns. When React unmounts a chat line it removes the parent
     * element, so it never tries to remove a child we swapped out — which is
     * the usual source of "NotFoundError: failed to remove child" in scripts
     * that rewrite innerHTML.
     */
    replaceTextNode(node) {
      const text = node.nodeValue;
      if (!text || text.length > 2000) return false;

      const parts = text.split(/(\s+)/);
      let hit = false;
      for (const p of parts) { if (p && Store.map.has(p)) { hit = true; break; } }
      if (!hit) return false;

      const frag = document.createDocumentFragment();
      let buf = '';
      let lastWrap = null;
      const flush = () => { if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; } };

      for (const part of parts) {
        const emote = part ? Store.map.get(part) : null;
        if (!emote) {
          buf += part;
          if (part.trim()) lastWrap = null;   // any real text breaks an overlay chain
          continue;
        }
        if (emote.zeroWidth && lastWrap) {
          // The space that separated the overlay from its base emote must not
          // survive, or the line gains a visible double gap.
          if (!buf.trim()) buf = ''; else flush();
          lastWrap.appendChild(makeImg(emote, true));
          continue;
        }
        flush();
        const wrap = document.createElement('span');
        wrap.className = 'ute-wrap';
        wrap.appendChild(makeImg(emote, false));
        frag.appendChild(wrap);
        lastWrap = wrap;
      }
      flush();
      node.parentNode.replaceChild(frag, node);
      return true;
    },

    processMessage(el) {
      if (!(el instanceof Element)) return;
      if (el.dataset.uteDone === '1') return;
      if (!Store.map.size) return;

      // Never touch inputs, links, or the emote nodes we already made. The
      // whole of .chat-input is off limits: the composer owns its own overlay
      // and the emote picker is not chat.
      if (el.closest(NOT_CHAT)) return;

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'A') {
            return NodeFilter.FILTER_REJECT;
          }
          if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (p.closest('.ute-wrap')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const targets = [];
      let n;
      while ((n = walker.nextNode())) targets.push(n);
      for (const t of targets) this.replaceTextNode(t);

      el.dataset.uteDone = '1';
    },

    attach(root, messageSelector) {
      if (this.roots.has(root)) return;
      this.roots.add(root);
      root.dataset.uteRoot = '1';
      log('attached to', root, messageSelector);

      const handle = nodes => {
        for (const node of nodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            if (node.parentElement && !node.parentElement.closest(NOT_CHAT)) {
              this.replaceTextNode(node);
            }
            continue;
          }
          if (!(node instanceof Element)) continue;
          if (messageSelector && node.matches && node.matches(messageSelector)) {
            this.processMessage(node);
          } else if (messageSelector) {
            const inner = node.querySelectorAll(messageSelector);
            if (inner.length) inner.forEach(m => this.processMessage(m));
            else this.processMessage(node);
          } else {
            this.processMessage(node);
          }
        }
      };

      if (CONFIG.hoverCard) {
        const at = e => (e.target && e.target.closest ? e.target.closest('img.ute-emote') : null);
        root.addEventListener('mouseover', e => { const i = at(e); if (i) Tooltip.show(i); });
        root.addEventListener('mouseout', e => { if (at(e)) Tooltip.hide(); });
      }

      // Seed with whatever is already on screen.
      const existing = messageSelector ? root.querySelectorAll(messageSelector) : root.children;
      Array.from(existing).forEach(m => this.processMessage(m));

      const obs = new MutationObserver(muts => {
        // Batch: chat can burst 50 messages in a frame.
        const added = [];
        for (const m of muts) {
          for (const nd of m.addedNodes) added.push(nd);
        }
        if (!added.length) return;
        requestAnimationFrame(() => handle(added));
      });
      obs.observe(root, { childList: true, subtree: true });
      root.__uteObserver = obs;
    },

    reprocessAll() {
      for (const root of this.roots) {
        root.querySelectorAll('[data-ute-done="1"]').forEach(el => delete el.dataset.uteDone);
        Array.from(root.children).forEach(c => this.processMessage(c));
        root.querySelectorAll(':scope > * > *').forEach(c => this.processMessage(c));
      }
    },

    detachAll() {
      for (const root of this.roots) {
        if (root.__uteObserver) root.__uteObserver.disconnect();
        delete root.dataset.uteRoot;
      }
      this.roots.clear();
    },
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * 7. CHAT DETECTION
   * ════════════════════════════════════════════════════════════════════════ */

  const PROFILES = [
    {
      name: 'twitch',
      test: () => /(^|\.)twitch\.tv$/i.test(location.hostname),
      // The message list is not the only place Twitch renders chat text.
      // Pinned messages, hype chat and other community highlights sit in a
      // sibling stack above it, so the root is the whole chat room and
      // .chat-input (composer + emote picker) is excluded per-node instead.
      containers: [
        '.chat-room__content',
        '.chat-scrollable-area__message-container',
        '[data-test-selector="chat-scrollable-area__message-container"]',
        '.chat-list--default .simplebar-content',
        '.chat-room__content .chat-list',
        '[data-a-target="chat-scroller"]',
      ],
      // Every Twitch message form — ordinary lines, notices, pinned cards —
      // marks its text with data-a-target="chat-message-text", so matching
      // that covers forms this script has never seen.
      messages: '.chat-line__message, .chat-line__status, .user-notice-line, .vod-message, ' +
                '[data-a-target="chat-line-message"], [data-a-target="chat-message-text"], ' +
                '.pinned-chat__message, .community-highlight',
    },
    {
      name: 'kapchat',
      test: () => /nightdev\.com$/i.test(location.hostname),
      containers: ['#chat_box', '.chat_box', '#chat_container'],
      messages: '.chat_line',
    },
    {
      name: 'streamelements',
      test: () => /streamelements\.com$/i.test(location.hostname),
      containers: ['.chat-container', '#log', '.main-container'],
      messages: '.message-wrapper, .chat-message, [class*="message"]',
    },
    {
      name: 'streamlabs',
      test: () => /streamlabs\.com$/i.test(location.hostname),
      containers: ['.chat-container', '#chatbox'],
      messages: '.chat-line, .message',
    },
  ];

  /**
   * Structural detector for unknown sites.
   *
   * Rather than guessing from class names (which are minified everywhere), we
   * watch the document for a container that repeatedly receives new element
   * children carrying text. That is the behavioural signature of a chat log,
   * and it distinguishes chat from static markup with "chat" in a class name.
   */
  /**
   * A chat line, on Twitch and on every IRC-style renderer, has one shape a
   * list of articles or notifications does not: a name, a colon, then the
   * message. Requiring it is what separates a chat log from any other
   * container that grows over time — which the old "three text-bearing
   * appends" rule could not do, and which is why a status panel gated on
   * detection used to appear on ordinary sites.
   *
   * A timestamp prefix ("04:31 PM bob: hi") still matches, harmlessly.
   */
  const CHAT_LINE_SHAPE = /^\s*\S[^:\n]{0,60}:\s*\S/;

  const GenericDetector = {
    scores: new Map(),
    observer: null,
    deadline: 0,

    start(onFound) {
      if (!CONFIG.genericDetection) return;
      // scan() runs on every mutation until a chat root is found, so without
      // this guard each call attached another observer over the same document
      // while the previous one kept running: every append was then counted
      // once per accumulated observer, and the promotion thresholds fired
      // early and unpredictably.
      if (this.observer) return;
      this.deadline = Date.now() + 120000; // give SPAs two minutes to boot

      // Fast path: obvious markup, checked once up front.
      const quick = document.querySelector(
        '[class*="chat-messages"], [class*="chat-list"], [class*="chatMessages"], [id*="chat-log"], [class*="chat-log"]'
      );
      if (quick && quick.children.length >= 2 &&
          Array.from(quick.children).some(c => CHAT_LINE_SHAPE.test((c.textContent || '').trim()))) {
        onFound(quick, null);
        return;
      }

      this.observer = new MutationObserver(muts => {
        if (Date.now() > this.deadline) { this.stop(); return; }
        for (const m of muts) {
          const parent = m.target;
          if (!(parent instanceof Element)) continue;
          if (parent.closest('[data-ute-root="1"]')) continue;
          let shaped = 0, plain = 0;
          for (const nd of m.addedNodes) {
            if (nd.nodeType !== Node.ELEMENT_NODE) continue;
            const t = (nd.textContent || '').trim();
            if (!t.length || t.length >= 600) continue;
            plain++;
            if (CHAT_LINE_SHAPE.test(t)) shaped++;
          }
          if (!plain) continue;

          const score = this.scores.get(parent) || { shaped: 0, plain: 0 };
          score.shaped += shaped;
          score.plain += plain;
          this.scores.set(parent, score);

          // Two lines in "name: message" shape is a confident read. The plain
          // fallback is deliberately far higher, and exists only for renderers
          // that draw the separator in CSS so it never reaches textContent —
          // losing real chat is a worse failure than a harmless false match.
          const confident = score.shaped >= 2 && parent.children.length >= 3;
          const fallback = score.plain >= 8 && parent.children.length >= 8;
          if (confident || fallback) {
            log('generic detection:', confident ? 'chat-shaped' : 'volume fallback',
                score.shaped + ' shaped,', score.plain + ' plain');
            this.stop();
            onFound(parent, null);
            return;
          }
        }
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => this.stop(), 120000);
    },

    stop() {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      this.scores.clear();
    },
  };

  function findProfileRoots() {
    const profile = PROFILES.find(p => { try { return p.test(); } catch (e) { return false; } });
    if (!profile) return null;
    for (const sel of profile.containers) {
      const el = document.querySelector(sel);
      if (el) return { root: el, messages: profile.messages, profile: profile.name };
    }
    return { root: null, messages: profile.messages, profile: profile.name };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 8. EMOTE PICKER INTEGRATION  (twitch.tv only)
   *
   * Twitch's picker markup is styled-components output: every visual class is
   * a build hash (bVKCgo, eXryG, AoXTY…) that changes on each deploy. Only the
   * BEM-ish names survive, because Twitch's own tooling keys on them:
   *   .emote-picker  .emote-picker__content-block  .emote-grid
   *   .emote-grid-section__header-title  .emote-button  .emote-picker__image
   *
   * So nothing here hardcodes a hash. The script finds a live native section
   * and a live native emote cell, deep-clones them as templates, and swaps in
   * its own title and images. Whatever classes Twitch is shipping today come
   * along for free, and a restyle can't break the layout.
   *
   * cloneNode copies attributes but not expando properties, so a cloned cell
   * carries no React fiber. React can't see our buttons and won't try to
   * reconcile them; we attach our own click handlers instead.
   * ════════════════════════════════════════════════════════════════════════ */

  const PSEL = {
    picker: '[data-a-target="chat-emote-picker"], .emote-picker',
    header: '.emote-grid-section__header-title',
    grid: '.emote-grid',
    lock: '[data-test-selector="badge-button-lock"]',
    search: 'input[type="search"]',
    nav: '[class*="emote-picker__nav"] [role="toolbar"]',
    input: '[data-a-target="chat-input"][contenteditable="true"], .chat-wysiwyg-input__editor',
    // Twitch's own composer rendering, present only when logged in.
    nativeEmote: '[data-a-target="wysiwyg-chat-input-emote"], [data-slate-void="true"]',
    nativePreview: '[data-a-target="chat-input-emote-preview"]',
  };

  // Colours are chosen for contrast against the picker's dark background.
  // They are not official brand colours, just distinguishable section markers.
  const PICKER_GROUPS = [
    { provider: '7tv-channel',  label: '7TV Channel Emotes',          tag: '7TV',  letter: '7', color: '#3d5a9e' },
    { provider: 'bttv-channel', label: 'BetterTTV Channel Emotes',    tag: 'BTTV', letter: 'B', color: '#8f3030' },
    { provider: 'ffz-channel',  label: 'FrankerFaceZ Channel Emotes', tag: 'FFZ',  letter: 'F', color: '#3f4a63' },
    { provider: '7tv-global',   label: '7TV Global Emotes',           tag: '7TV',  letter: '7', color: '#3d5a9e', global: true },
    { provider: 'bttv-global',  label: 'BetterTTV Global Emotes',     tag: 'BTTV', letter: 'B', color: '#8f3030', global: true },
    { provider: 'ffz-global',   label: 'FrankerFaceZ Global Emotes',  tag: 'FFZ',  letter: 'F', color: '#3f4a63', global: true },
  ];

  function badgeIcon(letter, color) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">' +
      `<rect width="28" height="28" rx="6" fill="${color}"/>` +
      `<text x="14" y="20" font-family="Inter,Roobert,Helvetica,sans-serif" font-size="15" ` +
      `font-weight="700" text-anchor="middle" fill="#ffffff">${letter}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /**
   * The chat box is a Slate editor (data-slate-editor="true"), not a textarea.
   * Assigning textContent would update the DOM while leaving Slate's internal
   * model empty, so the send button would post nothing. Slate listens for
   * beforeinput, which is exactly what execCommand('insertText') produces —
   * deprecated, but it's the one path that drives Slate's model correctly.
   */
  /**
   * The message as actually typed. editor.textContent is not that: it also
   * picks up the zero-width padding Slate inserts and the accessible label
   * inside each committed emote's void node, so a box holding one emote read
   * as the text "Kappa". Only [data-slate-string] spans carry real characters.
   */
  function composerText(editor) {
    let out = '';
    for (const leaf of editor.querySelectorAll('[data-slate-string="true"]')) {
      if (leaf.closest(PSEL.nativeEmote)) continue;
      out += leaf.textContent || '';
    }
    return out.replace(/\uFEFF/g, '');
  }

  /**
   * Put the caret at the end of the message, on a text node Slate owns.
   *
   * Collapsing to the end of the editable's contents is not the same thing:
   * when the message ends in an emote, that lands inside the void node's
   * spacer, and Slate cannot resolve a model position from there — which is
   * where the odd insertion behaviour came from.
   */
  function caretToEnd(editor) {
    const leaves = Array.from(editor.querySelectorAll('[data-slate-node="text"]'))
      .filter(el => !el.closest(PSEL.nativeEmote));
    const range = document.createRange();
    const last = leaves[leaves.length - 1];

    if (last) {
      const walk = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
      let node = null, n;
      while ((n = walk.nextNode())) node = n;
      if (node) range.setStart(node, node.nodeValue.length);
      else range.selectNodeContents(last);
    } else {
      range.selectNodeContents(editor);
    }
    range.collapse(false);

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Hand text to the editor through the one event it can take over.
   *
   * dispatchEvent returns false when something called preventDefault, which is
   * how a modelled editor signals it handled the input itself. If it declines,
   * writing the text anyway would put characters in the DOM that the editor's
   * model has never heard of — and that is precisely the broken state: the
   * placeholder stays up because the model is still empty, the caret sits in
   * the wrong place, backspace deletes from a model that never had the text so
   * the code appears to survive deletion, and the next keystroke re-renders
   * from the model and wipes the lot. So for an editor that declares a model,
   * a refusal is taken as a refusal.
   */
  function commitInsertion(editor, text) {
    const modelled = editor.hasAttribute('data-slate-editor');
    const taken = !editor.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: text, bubbles: true, cancelable: true,
    }));
    if (taken) return true;
    if (modelled) return false;
    try { return document.execCommand('insertText', false, text); } catch (e) { return false; }
  }

  /**
   * Insert an emote code at the end of the message: a space before it unless
   * the box is empty or already ends in whitespace, and always a space after.
   *
   * The work is deferred by a frame because the editor syncs its own selection
   * from the DOM on selectionchange, which lands in a later task. Inserting in
   * the same tick arrives while that selection is still empty — most visibly
   * when the box was empty to begin with, since then there is no earlier
   * selection to fall back on.
   */
  function insertIntoChatInput(code) {
    const editor = document.querySelector(PSEL.input);
    if (!editor || !editor.isConnected) return false;

    editor.focus({ preventScroll: true });
    caretToEnd(editor);

    const attempt = retry => {
      if (!editor.isConnected) return;
      if (document.activeElement !== editor) editor.focus({ preventScroll: true });
      caretToEnd(editor);

      const typed = composerText(editor);
      // A committed emote is not text but is still content, so a code
      // following one needs its separating space.
      const hasContent = typed.length > 0 || !!editor.querySelector(PSEL.nativeEmote);
      const lead = hasContent && !/\s$/.test(typed) ? ' ' : '';

      if (commitInsertion(editor, lead + code + ' ')) return;
      if (retry > 0) { setTimeout(() => attempt(retry - 1), 24); return; }
      warn('the chat editor declined the insertion of', code);
    };

    const soon = () => setTimeout(() => attempt(2), 0);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(soon);
    else soon();
    return true;
  }

  const Picker = {
    hostObserver: null,
    sections: [],
    panel: null,
    query: '',
    activeProvider: null,   // survives the picker being closed and reopened
    queued: false,

    start() {
      if (!CONFIG.pickerSections || this.hostObserver) return;
      if (!/(^|\.)twitch\.tv$/i.test(location.hostname)) return;
      // The balloon is mounted inside .chat-input, a subtree with almost no
      // churn — far cheaper to watch than document.body, which sees every
      // incoming chat message.
      const host = document.querySelector('.chat-input') || document.body;
      if (!host) return;
      this.hostObserver = new MutationObserver(() => this.schedule());
      this.hostObserver.observe(host, { childList: true, subtree: true });
      this.schedule();
    },

    schedule() {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => { this.queued = false; this.check(); });
    },

    refresh() { this.sections = []; this.schedule(); },

    reset() {
      this.sections = [];
      this.panel = null;
      this.suppressed = [];
      this.activeProvider = null;
      if (this.hostObserver) { this.hostObserver.disconnect(); this.hostObserver = null; }
    },

    check() {
      const picker = document.querySelector(PSEL.picker);
      if (!picker) { this.sections = []; return; }
      if (!Store.map.size) return;
      if (this.sections.length && this.sections.every(n => picker.contains(n))) {
        this.reanchor(picker);
        this.injectNav(picker, this.groups());   // no-op once correctly placed
        return;
      }
      this.sections = [];
      try { this.inject(picker); } catch (e) { warn('picker injection failed:', e.message); }
    },

    groups() {
      const byProvider = new Map();
      for (const e of Store.map.values()) {
        if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
        byProvider.get(e.provider).push(e);
      }
      return PICKER_GROUPS
        .filter(g => (CONFIG.pickerIncludeGlobals || !g.global) && byProvider.has(g.provider))
        .map(g => ({
          ...g,
          emotes: byProvider.get(g.provider).sort((a, b) => a.code.localeCompare(b.code)),
        }));
    },

    /** Harvest live markup to clone from, so no build hash is ever written down. */
    templates(picker) {
      // Our sections carry a header and a grid too, so they'd otherwise
      // qualify as templates and as the insertion anchor.
      const headers = Array.from(picker.querySelectorAll(PSEL.header))
        .filter(h => !h.closest('[data-ute-section]'));
      if (!headers.length) return null;

      // Prefer a section whose header carries an avatar — that's the channel
      // section, and its shape is the one we're imitating.
      const blocks = headers.map(h => h.parentElement && h.parentElement.parentElement)
        .filter(b => b && b.querySelector(PSEL.grid));
      if (!blocks.length) return null;
      const block = blocks.find(b => b.querySelector(PSEL.header + ' img')) || blocks[blocks.length - 1];

      const grid = block.querySelector(PSEL.grid);
      const cellSource = grid.firstElementChild;
      if (!cellSource) return null;

      // Subscriber emotes render with a padlock overlay. Ours are never
      // locked, so prefer a clean cell and strip the overlay either way.
      let preferred = cellSource;
      for (const c of picker.querySelectorAll(PSEL.grid + ' > *')) {
        if (!c.querySelector(PSEL.lock)) { preferred = c; break; }
      }
      const cell = preferred.cloneNode(true);
      cell.querySelectorAll(PSEL.lock).forEach(n => n.remove());

      return { block, cell, container: block.parentElement, blocks };
    },

    inject(picker) {
      // refresh() drops our references, but the nodes are still in Twitch's
      // DOM. Without this the sections double on every refresh — and worse,
      // templates() would start cloning our own clones.
      picker.querySelectorAll('[data-ute-section], [data-ute-panel]').forEach(n => n.remove());
      this.panel = null;

      const groups = this.groups();
      if (!groups.length) return;
      const tpl = this.templates(picker);
      if (!tpl || !tpl.container) return;

      let ref = this.anchorFor(picker) || tpl.blocks[tpl.blocks.length - 1];

      if (CONFIG.pickerPanel) {
        const panel = this.buildPanel();
        ref.parentNode.insertBefore(panel, ref.nextSibling);
        this.panel = panel;
        ref = panel;
      }

      for (const group of groups) {
        const node = this.buildSection(tpl, group);
        if (!node) continue;
        ref.parentNode.insertBefore(node, ref.nextSibling);
        group.node = node;
        this.sections.push(node);
        ref = node;
      }

      this.wireSearch(picker);
      this.wireHoverCards(picker);
      this.wireScrollSpy(picker);
      this.injectNav(picker, groups);
      log('picker: added', this.sections.length, 'sections');
    },

    /**
     * The channel's own section is the first one whose header carries an
     * avatar — "Frequently Used" has none, and other channels' sections mount
     * later and further down. Anchoring to it survives the race where the
     * picker's first mutation fires before Twitch has rendered it, which
     * otherwise landed these sections above the channel's own emotes.
     */
    anchorFor(picker) {
      const blocks = [];
      for (const header of picker.querySelectorAll(PSEL.header)) {
        if (header.closest('[data-ute-section]')) continue;
        const block = header.parentElement && header.parentElement.parentElement;
        if (block && block.querySelector(PSEL.grid) && !blocks.includes(block)) blocks.push(block);
      }
      return blocks.find(b => b.querySelector(PSEL.header + ' img')) || blocks[blocks.length - 1] || null;
    },

    /** Twitch mounts sections progressively; keep our position correct. */
    reanchor(picker) {
      const anchor = this.anchorFor(picker);
      if (!anchor || anchor === this.sections[0]) return;
      const head = this.panel || this.sections[0];
      if (head.previousElementSibling === anchor) return;
      let ref = anchor;
      for (const node of [this.panel, ...this.sections]) {
        if (!node) continue;
        ref.parentNode.insertBefore(node, ref.nextSibling);
        ref = node;
      }
      log('picker: re-anchored below the channel section');
    },

    /**
     * The status readout and its controls, hosted here rather than floating
     * over the chat UI where they collided with Twitch's own buttons.
     */
    buildPanel() {
      const panel = document.createElement('div');
      panel.className = 'ute-panel';
      panel.dataset.utePanel = '1';

      const c = Store.counts;
      const total = n => n || 0;
      const counts = document.createElement('span');
      counts.className = 'ute-panel-counts';
      counts.textContent = [
        `7TV ${total(c['7tv-channel']) + total(c['7tv-global'])}`,
        `BetterTTV ${total(c['bttv-channel']) + total(c['bttv-global'])}`,
        `FrankerFaceZ ${total(c['ffz-channel']) + total(c['ffz-global'])}`,
      ].join('  ·  ');

      const channel = document.createElement('span');
      channel.className = 'ute-panel-channel';
      channel.textContent = Store.channel || 'channel not detected';

      const button = (label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
        return b;
      };

      panel.append(
        counts, channel,
        button('Set channel', promptForChannel),
        button('Reload emotes', forceReload),
      );
      return panel;
    },

    buildSection(tpl, group) {
      const block = tpl.block.cloneNode(true);
      block.dataset.uteSection = group.provider;
      block.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

      const header = block.querySelector(PSEL.header);
      if (header) {
        // Drop Twitch's own controls (the report menu and its balloon), which
        // are inert in a clone and would otherwise sit there doing nothing.
        header.querySelectorAll('button, [role="dialog"], [data-toggle-balloon-id]')
          .forEach(el => el.remove());
        const title = header.querySelector('strong');
        if (title) title.textContent = group.label;
        const avatar = header.querySelector('img');
        if (avatar) {
          avatar.src = badgeIcon(group.letter, group.color);
          avatar.removeAttribute('srcset');
          avatar.alt = group.label;
        }
      }

      const grid = block.querySelector(PSEL.grid);
      if (!grid) return null;
      grid.textContent = '';
      // A popular channel can carry several hundred 7TV emotes. Building them
      // all in one go blocks the frame the picker opens on, so only the first
      // screenful is synchronous and the rest arrive during idle time.
      this.fillGrid(grid, tpl.cell, group, 0);
      return block;
    },

    fillGrid(grid, template, group, from) {
      const CHUNK = 150;
      const end = Math.min(from + CHUNK, group.emotes.length);
      const frag = document.createDocumentFragment();
      for (let i = from; i < end; i++) {
        const cell = this.buildCell(template, group.emotes[i], group);
        if (!cell) continue;
        // Late arrivals must respect a search that is already active.
        if (this.query && !cell.dataset.uteCode.includes(this.query)) cell.style.display = 'none';
        frag.appendChild(cell);
      }
      grid.appendChild(frag);

      if (end < group.emotes.length) {
        const next = () => { if (grid.isConnected) this.fillGrid(grid, template, group, end); };
        // 200ms rather than a lazier timeout: on a busy page the idle queue can
        // starve, and six chunks each waiting half a second is a visibly
        // half-filled grid for someone scrolling to find an emote.
        if (typeof requestIdleCallback === 'function') requestIdleCallback(next, { timeout: 200 });
        else setTimeout(next, 16);
      } else if (this.query) {
        this.filter(this.query);
      }
    },

    buildCell(template, emote, group) {
      const cell = template.cloneNode(true);
      const button = cell.querySelector('button');
      const img = cell.querySelector('img');
      if (!button || !img) return null;

      cell.dataset.uteCode = emote.code.toLowerCase();
      button.setAttribute('aria-label', emote.code);
      button.setAttribute('name', emote.code);
      if (!CONFIG.hoverCard) button.setAttribute('title', `${emote.code} — ${group.label}`);
      // Retarget Twitch's own hooks so nothing of theirs tries to claim it.
      button.setAttribute('data-a-target', 'ute-emote-button');
      button.removeAttribute('data-test-selector');

      img.src = emote.url;
      img.alt = emote.code;
      // Deliberately no data-ute-code here: that attribute counts cells, and
      // duplicating it on the image doubled every cell count and search filter.
      // alt already carries the code for the hover card.
      // The section heading beside it already says "Channel Emotes"; the card
      // only needs the provider, and the full label overran the line.
      img.dataset.uteSrc = PROVIDER_LABEL[emote.provider] || group.label;
      if (emote.srcset) img.srcset = emote.srcset; else img.removeAttribute('srcset');

      // Without this the composer is blurred on mousedown, before the click
      // handler runs, and the caret we then place is discarded.
      button.addEventListener('mousedown', ev => ev.preventDefault());
      button.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        insertIntoChatInput(emote.code);
      });
      return cell;
    },

    /** One delegated pair of listeners for every cell in our sections. */
    wireHoverCards(picker) {
      if (!CONFIG.hoverCard || picker.dataset.uteHover === '1') return;
      picker.dataset.uteHover = '1';
      const at = e => {
        if (!e.target || !e.target.closest) return null;
        // Both the cell and its image carry data-ute-code, so closest() may
        // land on either one.
        const hit = e.target.closest('[data-ute-code]');
        if (!hit) return null;
        return hit.tagName === 'IMG' ? hit : hit.querySelector('img');
      };
      picker.addEventListener('mouseover', e => { const i = at(e); if (i) Tooltip.show(i, true); });
      picker.addEventListener('mouseout', e => { if (at(e)) Tooltip.hide(); });
    },

    /**
     * Twitch filters its own sections through React state, which never sees
     * our nodes, so we filter them ourselves off the same input.
     */
    wireSearch(picker) {
      const input = picker.querySelector(PSEL.search);
      if (!input || input.dataset.uteSearch === '1') return;
      input.dataset.uteSearch = '1';
      input.addEventListener('input', () => this.filter(input.value.trim().toLowerCase()));
    },

    filter(query) {
      this.query = query;
      for (const section of this.sections) {
        let shown = 0;
        section.querySelectorAll('[data-ute-code]').forEach(cell => {
          const match = !query || cell.dataset.uteCode.includes(query);
          cell.style.display = match ? '' : 'none';
          if (match) shown++;
        });
        section.style.display = shown ? '' : 'none';
      }
    },

    /**
     * Twitch marks the current tab with aria-current plus a pair of classes
     * whose names are build-specific. Read them off the live active tab rather
     * than hardcoding, so the highlight keeps working across restyles.
     */
    activeTokens(toolbar) {
      const tokens = { wrapper: [], inner: [] };
      const current = toolbar.querySelector('[aria-current="true"]');
      if (!current) return tokens;
      let wrapper = current;
      while (wrapper && wrapper.parentElement !== toolbar) wrapper = wrapper.parentElement;
      if (wrapper) {
        tokens.wrapper = Array.from(wrapper.classList).filter(c => /active/i.test(c));
      }
      for (const el of current.querySelectorAll('*')) {
        for (const c of el.classList) {
          if (/active/i.test(c) && !tokens.inner.includes(c)) tokens.inner.push(c);
        }
      }
      return tokens;
    },

    /**
     * Take Twitch's highlight away, remembering exactly what was taken.
     *
     * Stripping the classes outright was not reversible: React's state still
     * says that tab is current, so clicking it changes nothing and never
     * triggers the re-render that would put the class back. Navigating from
     * one of our sections back to the channel's therefore left nothing lit,
     * and the states compounded from there.
     */
    suppressNative(toolbar) {
      this.restoreNative();
      const tokens = this.tokens || { wrapper: [], inner: [] };
      this.suppressed = [];
      for (const button of toolbar.querySelectorAll('[aria-current="true"]')) {
        if (button.closest('[data-ute-nav]')) continue;
        let wrapper = button;
        while (wrapper && wrapper.parentElement !== toolbar) wrapper = wrapper.parentElement;
        const record = { button, wrapper, wrapperTokens: [], innerTokens: [] };
        if (wrapper) {
          for (const c of tokens.wrapper) {
            if (wrapper.classList.contains(c)) { wrapper.classList.remove(c); record.wrapperTokens.push(c); }
          }
        }
        for (const el of button.querySelectorAll('*')) {
          for (const c of tokens.inner) {
            if (el.classList.contains(c)) { el.classList.remove(c); record.innerTokens.push([el, c]); }
          }
        }
        button.setAttribute('aria-current', 'false');
        this.suppressed.push(record);
      }
    },

    /** Put back precisely what suppressNative took, unless React moved on. */
    restoreNative(toolbar) {
      const moved = toolbar && Array.from(toolbar.querySelectorAll('[aria-current="true"]'))
        .some(b => !b.closest('[data-ute-nav]'));
      for (const r of this.suppressed || []) {
        if (moved) continue;               // Twitch has since lit another tab
        if (r.wrapper && r.wrapper.isConnected) r.wrapperTokens.forEach(c => r.wrapper.classList.add(c));
        for (const [el, c] of r.innerTokens) if (el.isConnected) el.classList.add(c);
        if (r.button && r.button.isConnected) r.button.setAttribute('aria-current', 'true');
      }
      this.suppressed = [];
    },

    /** Highlight one of our tabs, and only one — or none. */
    setActiveTab(toolbar, provider) {
      if (this.activeProvider === provider) return;
      this.activeProvider = provider;
      const tokens = this.tokens || { wrapper: [], inner: [] };
      for (const item of toolbar.querySelectorAll('[data-ute-nav]')) {
        const on = item.dataset.uteNav === provider;
        const button = item.querySelector('button');
        const inner = button && button.firstElementChild;
        tokens.wrapper.forEach(c => item.classList.toggle(c, on));
        if (inner) tokens.inner.forEach(c => inner.classList.toggle(c, on));
        if (button) button.setAttribute('aria-current', on ? 'true' : 'false');
      }
      if (provider) this.suppressNative(toolbar);
      else this.restoreNative(toolbar);
    },

    /**
     * Whichever section is at the top of the scroller owns the highlight,
     * which is how Twitch's own rail behaves. Driving the state from scroll
     * position rather than from clicks keeps the two in step no matter how
     * the user got there.
     */
    wireScrollSpy(picker) {
      if (picker.dataset.uteSpy === '1') return;
      const scroller = picker.querySelector(
        '.emote-picker__scroll-container, .emote-picker__tab-content');
      const toolbar = picker.querySelector(PSEL.nav);
      if (!scroller || !toolbar) return;
      picker.dataset.uteSpy = '1';
      let queued = false;
      scroller.addEventListener('scroll', () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; this.syncActiveTab(scroller, toolbar); });
      }, { passive: true });
    },

    syncActiveTab(scroller, toolbar) {
      if (!this.sections.length) return;
      const edge = scroller.getBoundingClientRect().top + 8;
      let current = null;
      for (const section of this.sections) {
        const r = section.getBoundingClientRect();
        if (r.top <= edge && r.bottom > edge) { current = section.dataset.uteSection; break; }
      }
      this.setActiveTab(toolbar, current);
    },

    /** The channel's own tab: the one avatar-style item we can safely clone. */
    navChannelTab(toolbar) {
      const button = toolbar.querySelector('[data-a-target="CHANNEL_EMOTES"]');
      if (!button) return null;
      let node = button;
      while (node && node.parentElement !== toolbar) node = node.parentElement;
      return node && node.querySelector('img') ? node : null;
    },

    /**
     * Called on every check, not just on injection. The rail is a different
     * React subtree from the sections list, and re-renders on its own — which
     * is why these could vanish while the sections they point at survived.
     *
     * It also has to wait for the channel tab. Cloning whatever happened to be
     * there first produced three copies of the clock icon at the bottom of the
     * rail: the "ghost entries".
     */
    injectNav(picker, groups) {
      if (!CONFIG.pickerNavIcons) return;
      const toolbar = picker.querySelector(PSEL.nav);
      if (!toolbar) return;

      const source = this.navChannelTab(toolbar);
      if (!source) return;                       // too early; retry next check

      this.tokens = this.activeTokens(toolbar);

      // Clicking a native tab means Twitch owns the highlight again.
      if (toolbar.dataset.uteNavWired !== '1') {
        toolbar.dataset.uteNavWired = '1';
        toolbar.addEventListener('click', e => {
          const item = e.target && e.target.closest ? e.target.closest('[role="toolbar"] > *') : null;
          if (item && !item.hasAttribute('data-ute-nav')) this.setActiveTab(toolbar, null);
        }, true);
      }

      const existing = toolbar.querySelectorAll('[data-ute-nav]');
      const placed = existing.length === groups.length
        && existing[0].previousElementSibling === source;
      if (placed) return;                        // already correct, do nothing
      existing.forEach(n => n.remove());

      const avatar = source.querySelector('img');
      let ref = source;                          // sit directly below the channel
      for (const group of groups) {
        const item = source.cloneNode(true);
        item.classList.add('ute-nav-item');
        item.dataset.uteNav = group.provider;
        item.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        // The channel tab may well be the active one, and its active classes
        // would otherwise come along with the clone — which is why every tab
        // looked selected after reopening the picker.
        const strip = el => Array.from(el.classList)
          .filter(c => /active/i.test(c)).forEach(c => el.classList.remove(c));
        strip(item);
        item.querySelectorAll('*').forEach(strip);

        // Reuse the channel's own icon, tagged in the corner, so these read as
        // siblings of Twitch's tabs rather than foreign objects.
        const img = item.querySelector('img');
        if (img) {
          img.src = (avatar && avatar.src) || badgeIcon(group.letter, group.color);
          img.removeAttribute('srcset');
          img.alt = group.label;
        }
        const tag = document.createElement('span');
        tag.className = 'ute-nav-tag';
        tag.textContent = group.tag;
        item.appendChild(tag);

        const button = item.querySelector('button');
        if (button) {
          button.setAttribute('aria-label', group.label);
          button.setAttribute('aria-current', 'false');
          button.setAttribute('data-a-target', 'ute-emote-nav');
          // Resolved at click time: a rebuild replaces the section node, and a
          // reference captured here would point at a detached one.
          button.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            this.setActiveTab(toolbar, group.provider);
            const target = picker.querySelector(`[data-ute-section="${group.provider}"]`);
            if (target && typeof target.scrollIntoView === 'function') {
              // 'instant' rather than 'smooth', and explicit rather than
              // 'auto', so a scroll-behavior rule on the container can't
              // reintroduce the glide. Twitch's own tabs jump.
              target.scrollIntoView({ block: 'start', behavior: 'instant' });
            }
          });
        }
        ref.parentNode.insertBefore(item, ref.nextSibling);
        ref = item;
      }
      // Restore whatever was selected when the picker was last closed. The
      // no-op guard in setActiveTab compares against the remembered provider,
      // so it has to be cleared first or nothing is applied to the new nodes.
      if (this.activeProvider) {
        const restore = this.activeProvider;
        this.activeProvider = null;
        this.suppressed = [];
        this.setActiveTab(toolbar, restore);
      }
      log('picker: nav tabs placed below the channel tab');
    },
  };

  /**
   * Twitch converts every emote it will honour into an inline void node of its
   * own, so a code still sitting as plain text is one Twitch declined. That
   * leaves exactly one question worth asking — do we have a third-party emote
   * for it? — and no need to know anything about Twitch's own catalogue.
   */
  function resolveCode(code) {
    const emote = Store.map.get(code);
    if (!emote) return null;
    return {
      code, url: emote.url, srcset: emote.srcset,
      label: PROVIDER_LABEL[emote.provider] || emote.provider,
    };
  }


  /* ══════════════════════════════════════════════════════════════════════════
   * 9. COMPOSER PREVIEW  (twitch.tv only)
   *
   * Twitch's input is a Slate editor, and when logged in it DOES render its own
   * emotes inline, in two states this script has to stay out of the way of:
   *
   *   committed → <span data-a-target="wysiwyg-chat-input-emote"
   *                     data-slate-inline data-slate-void> holding an <img>
   *   previewed → the still-being-typed word wrapped in
   *               <span data-a-target="chat-input-emote-preview">
   *
   * Logged out, neither appears — which is why a logged-out capture makes it
   * look as though the feature doesn't exist.
   *
   * So Twitch owns its own emotes here and this only paints third-party codes,
   * which Twitch leaves as plain text because it has never heard of them. Text
   * inside either native construct is skipped outright: Twitch is already
   * showing something there, and painting over it would be fighting the UI
   * rather than extending it.
   *
   * The tempting approach is to insert an <img> into the editable, or to reach
   * Slate's editor object through React and insert an inline void node. Both
   * are traps:
   *
   *   - Slate maps DOM positions to model paths using data-slate-* attributes
   *     and text-node offsets. An injected node shifts those offsets, which
   *     surfaces as caret jumps, swallowed keystrokes, and "cannot resolve a
   *     Slate point from DOM point" throws.
   *   - Slate reconciles the editable from its model, so injected nodes are
   *     wiped on the next keystroke anyway.
   *   - Worst: a custom node Twitch's serialiser doesn't recognise gets dropped
   *     when the message is sent. You'd type the emote, see it, press enter,
   *     and the word would silently vanish from what everyone else receives.
   *
   * That last failure is unacceptable — corrupting outgoing messages is far
   * worse than showing no preview at all. So this never touches anything
   * inside the editable. It reads the text, measures each code's box with a
   * Range, and paints an image over that box in a sibling layer. Slate's model
   * is untouched, the sent message is always exactly what was typed, and the
   * worst possible bug is a misaligned picture.
   *
   * Sizing each image to the measured box (rather than to the emote's natural
   * width) is what keeps this honest: the text underneath keeps its original
   * layout, so wrapping and caret positions stay pixel-identical to vanilla.
   * ════════════════════════════════════════════════════════════════════════ */

  addStyle(`
    .ute-composer-layer {
      position: absolute; inset: 0;
      overflow: hidden; pointer-events: none; z-index: 1;
    }
    .ute-composer-token {
      position: absolute;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; border-radius: 2px;
    }
    .ute-composer-token img {
      height: 100%; width: auto;
      max-width: 100%; max-height: 100%;
      object-fit: contain;
    }
    .ute-card {
      display: none; align-items: center; gap: 8px;
      padding: 5px 9px; border-radius: 5px;
      background: rgba(24, 24, 27, .96);
      border: 1px solid rgba(255, 255, 255, .12);
      box-shadow: 0 4px 14px rgba(0, 0, 0, .4);
      font: 12px/1.4 Inter, Roobert, Helvetica, sans-serif;
      color: #efeff1; pointer-events: none; white-space: nowrap;
    }
    .ute-card.ute-on { display: flex; }
    .ute-card img { height: 28px; width: auto; max-width: 64px; object-fit: contain; }
    .ute-card-code { font-weight: 600; }
    .ute-card-src { color: #adadb8; }
    /* above the chat box */
    .ute-bubble { position: absolute; bottom: calc(100% + 6px); inset-inline-start: 10px; z-index: 20; }
    /* beside whatever emote is hovered */
    .ute-tip { position: fixed; z-index: 2147483000; }
    .ute-panel {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
      margin: 4px 0 2px; padding: 6px 10px;
      font: 11px/1.5 Inter, Roobert, Helvetica, sans-serif; color: #adadb8;
    }
    .ute-panel-counts { color: #efeff1; }
    .ute-panel-channel { margin-inline-end: auto; }
    .ute-panel button {
      all: unset; padding: 2px 8px; border-radius: 3px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .14); color: #dedee3; font: inherit;
    }
    .ute-panel button:hover { background: rgba(255, 255, 255, .08); }
    .ute-panel button:focus-visible { outline: 2px solid #bf94ff; outline-offset: 1px; }
    .ute-nav-item { position: relative; }
    .ute-nav-tag {
      position: absolute; bottom: 1px; left: 50%; transform: translateX(-50%);
      padding: 0 3px; border-radius: 2px; white-space: nowrap;
      background: rgba(0, 0, 0, .82); color: #fff;
      font: 700 7px/10px Inter, Roobert, Helvetica, sans-serif;
      letter-spacing: .03em; pointer-events: none;
    }
  `);

  const Composer = {
    editable: null,
    box: null,
    layer: null,
    hostObserver: null,
    contentObserver: null,
    handlers: null,
    queued: false,
    composing: false,

    start() {
      if (!CONFIG.composerPreview || this.hostObserver) return;
      if (!/(^|\.)twitch\.tv$/i.test(location.hostname)) return;
      const host = document.querySelector('.chat-input') || document.body;
      if (!host) return;
      this.hostObserver = new MutationObserver(() => this.attach());
      this.hostObserver.observe(host, { childList: true, subtree: true });
      this.attach();
    },

    attach() {
      const editable = document.querySelector(PSEL.input);
      if (!editable) { this.detach(); return; }
      if (editable === this.editable && this.layer && this.layer.isConnected) return;
      this.detach();

      const box = editable.closest('.chat-wysiwyg-input-box') || editable.parentElement;
      if (!box) return;
      // The layer is a sibling of the editable, never a child of it.
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';

      const layer = document.createElement('div');
      layer.className = 'ute-composer-layer';
      layer.setAttribute('aria-hidden', 'true');
      box.appendChild(layer);

      this.editable = editable;
      this.box = box;
      this.layer = layer;

      if (CONFIG.composerBubble) {
        // Anchored outside the clipping layer, and to .chat-input rather than
        // the text box, so a clipped input can't swallow it.
        const anchor = editable.closest('.chat-input') || box;
        if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
        const bubble = document.createElement('div');
        bubble.className = 'ute-card ute-bubble';
        bubble.setAttribute('aria-hidden', 'true');
        bubble.innerHTML = '<img alt=""><span class="ute-card-code"></span>' +
                           '<span class="ute-card-src"></span>';
        anchor.appendChild(bubble);
        this.bubble = bubble;
      }

      // Read-only observation: Slate re-renders the editable on every
      // keystroke, and clears it on send without firing an input event.
      this.contentObserver = new MutationObserver(() => this.schedule());
      this.contentObserver.observe(editable, {
        childList: true, subtree: true, characterData: true,
      });

      this.handlers = {
        scroll: () => this.schedule(),
        compositionstart: () => { this.composing = true; this.clear(); },
        compositionend: () => { this.composing = false; this.schedule(); },
        selectionchange: () => { if (this.editable === document.activeElement) this.schedule(); },
      };
      editable.addEventListener('scroll', this.handlers.scroll, { passive: true });
      editable.addEventListener('compositionstart', this.handlers.compositionstart);
      editable.addEventListener('compositionend', this.handlers.compositionend);
      document.addEventListener('selectionchange', this.handlers.selectionchange);

      this.schedule();
      log('composer preview attached');
    },

    detach() {
      if (this.contentObserver) { this.contentObserver.disconnect(); this.contentObserver = null; }
      if (this.editable && this.handlers) {
        this.editable.removeEventListener('scroll', this.handlers.scroll);
        this.editable.removeEventListener('compositionstart', this.handlers.compositionstart);
        this.editable.removeEventListener('compositionend', this.handlers.compositionend);
        document.removeEventListener('selectionchange', this.handlers.selectionchange);
      }
      if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
      if (this.bubble && this.bubble.parentNode) this.bubble.parentNode.removeChild(this.bubble);
      this.editable = this.box = this.layer = this.bubble = this.handlers = null;
    },

    reset() {
      this.detach();
      if (this.hostObserver) { this.hostObserver.disconnect(); this.hostObserver = null; }
    },

    schedule() {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => { this.queued = false; try { this.render(); } catch (e) { log('composer', e.message); } });
    },

    clear() {
      if (this.layer) this.layer.replaceChildren();
      this.showBubble(null);
    },

    /**
     * BTTV's speech-bubble: the code under the caret hasn't been committed
     * with a space yet, so it stays editable text and gets a card instead.
     * The same rule that keeps the caret's token unpainted drives this.
     */
    showBubble(info) {
      const bubble = this.bubble;
      if (!bubble) return;
      if (!info) { bubble.classList.remove('ute-on'); return; }
      bubble.querySelector('img').src = info.url;
      bubble.querySelector('img').alt = info.code;
      bubble.querySelector('.ute-card-code').textContent = info.code;
      bubble.querySelector('.ute-card-src').textContent = info.label;
      bubble.classList.add('ute-on');
    },

    /** First non-transparent background above the input, to mask the text. */
    background() {
      let el = this.box;
      for (let i = 0; el && i < 6; i++, el = el.parentElement) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) return c;
      }
      return 'var(--color-background-input, #18181b)';
    },

    /**
     * Token holding the caret is left as text, so a code stays editable.
     *
     * A collapsed selection is not always anchored on a text node: once the
     * editor re-renders, browsers report the anchor as the ELEMENT with an
     * offset counting children. Comparing that against a text node never
     * matched, so the token got painted while the card also showed it — the
     * emote appearing twice.
     */
    caretToken() {
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed || !sel.anchorNode) return null;

      let node = sel.anchorNode;
      let offset = sel.anchorOffset;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const edge = (from, wantLast) => {
          if (!from) return null;
          if (from.nodeType === Node.TEXT_NODE) return from;
          if (from.nodeType !== Node.ELEMENT_NODE) return null;
          const walk = document.createTreeWalker(from, NodeFilter.SHOW_TEXT);
          let found = null, n;
          while ((n = walk.nextNode())) { found = n; if (!wantLast) break; }
          return found;
        };
        // The caret sits between children; prefer the text just before it.
        const previous = edge(node.childNodes[offset - 1], true);
        const next = previous ? null : edge(node.childNodes[offset], false);
        const resolved = previous || next;
        if (!resolved) return null;
        node = resolved;
        offset = previous ? node.nodeValue.length : 0;
      }

      if (!this.editable.contains(node)) return null;
      return { node, offset };
    },

    render() {
      if (!this.editable || !this.layer || this.composing) return;
      if (!Store.map.size) { this.clear(); return; }

      const raw = (this.editable.textContent || '').replace(/\uFEFF/g, '');
      if (!raw.trim()) { this.clear(); return; }

      const boxRect = this.box.getBoundingClientRect();
      const caret = this.caretToken();
      const bg = this.background();
      const frag = document.createDocumentFragment();

      const walker = document.createTreeWalker(this.editable, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.replace(/\uFEFF/g, '').trim()) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p || p.hasAttribute('data-slate-zero-width')) return NodeFilter.FILTER_REJECT;
          // Twitch is already rendering here; don't paint over its own work.
          if (p.closest(PSEL.nativePreview) || p.closest(PSEL.nativeEmote)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let node;
      let caretMatch = null;
      while ((node = walker.nextNode())) {
        const value = node.nodeValue;
        const re = /\S+/g;
        let match;
        while ((match = re.exec(value))) {
          const emote = resolveCode(match[0]);
          if (!emote) continue;

          const start = match.index;
          const end = start + match[0].length;
          if (caret && caret.node === node && caret.offset >= start && caret.offset <= end) {
            caretMatch = emote;
            continue;
          }

          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          const rects = range.getClientRects();
          // A code split across two lines has two rects; leave it as text
          // rather than paint a box in the wrong place.
          if (rects.length !== 1) continue;
          const r = rects[0];
          if (!r.width || !r.height) continue;

          const token = document.createElement('span');
          token.className = 'ute-composer-token';
          token.dataset.uteCode = match[0];
          token.style.left = (r.left - boxRect.left) + 'px';
          token.style.top = (r.top - boxRect.top) + 'px';
          token.style.width = r.width + 'px';
          token.style.height = r.height + 'px';
          token.style.background = bg;

          const img = document.createElement('img');
          img.src = emote.url;
          if (emote.srcset) img.srcset = emote.srcset;
          img.alt = match[0];
          token.appendChild(img);
          frag.appendChild(token);
        }
      }

      this.layer.replaceChildren(frag);
      this.showBubble(caretMatch);
    },
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * 10. MENU COMMANDS
   *
   * The two controls that have to exist everywhere — switch channel, reload
   * emotes — live in the userscript manager's own menu rather than in a
   * floating panel on the page.
   *
   * The panel this replaces was drawn on every page where a chat log was
   * detected, which is not the same set as "pages with chat": the structural
   * detector is deliberately generous, so a semi-transparent pill turned up on
   * ordinary sites. A manager menu has no such failure mode, costs no DOM, and
   * can't overlap anything.
   *
   * Labels carry the state, so there is no status-only entry doing nothing
   * when clicked. On twitch.tv the picker's status row shows the same numbers.
   * ════════════════════════════════════════════════════════════════════════ */

  /** Ask for a channel and remember it for this page. */
  function promptForChannel() {
    const value = prompt('Twitch channel for this page:', Store.channel || '');
    if (!value) return;
    const login = value.trim().replace(/^#/, '').toLowerCase();
    if (!login) return;
    gmSet(`ute:manual:${location.hostname}${location.pathname}`, login);
    Store.load(login);
  }

  /** Drop the cache and refetch, for an emote added mid-stream. */
  function forceReload() {
    gmSet(`ute:emotes:${Store.channel || '__global__'}`, null);
    Store.signature = '';
    Store.load(Store.channel);
  }

  const Menu = {
    ids: [],

    available() { return typeof GM_registerMenuCommand === 'function'; },

    register() {
      if (!this.available()) return;
      this.unregister();
      const channel = Store.channel ? `currently ${Store.channel}` : 'none detected';
      const total = Store.map.size;
      try {
        this.ids.push(GM_registerMenuCommand(`Set channel — ${channel}`, promptForChannel));
        this.ids.push(GM_registerMenuCommand(`Reload emotes — ${total} loaded`, forceReload));
      } catch (e) { log('menu registration failed:', e.message); }
    },

    unregister() {
      if (typeof GM_unregisterMenuCommand !== 'function') { this.ids = []; return; }
      for (const id of this.ids) {
        try { GM_unregisterMenuCommand(id); } catch (e) { /* already gone */ }
      }
      this.ids = [];
    },
  };


  /* ══════════════════════════════════════════════════════════════════════════
   * 11. BOOTSTRAP
   * ════════════════════════════════════════════════════════════════════════ */

  function shouldRunHere() {
    if (CONFIG.blocklist.some(h => location.hostname.endsWith(h))) return false;
    // Skip tracking pixels, ad slots and other tiny frames.
    if (window.top !== window.self) {
      const w = window.innerWidth, h = window.innerHeight;
      if (w < 120 || h < 120) return false;
    }
    return true;
  }

  let booted = false;
  let currentUrl = location.href;

  async function boot(root, messages, profile) {
    if (booted) return;
    booted = true;

    Menu.register();
    Renderer.attach(root, messages);
    if (profile === 'twitch') { Picker.start(); Composer.start(); }

    const login = resolveChannel();
    if (!login) {
      warn('chat found but channel unknown — loading global emotes only. ' +
           'Set it from the userscript manager menu, or add a channelOverrides entry.');
    }
    await Store.load(login);
    Renderer.reprocessAll();
  }

  function scan() {
    if (booted) return;
    const hit = findProfileRoots();
    if (hit && hit.root) { boot(hit.root, hit.messages, hit.profile); return; }
    // Known-host profile exists but container hasn't rendered yet; keep waiting
    // rather than falling through to the generic detector.
    if (hit) return;
    GenericDetector.start((root) => boot(root, null));
  }

  function watchForChat() {
    scan();
    if (booted) return;
    const obs = new MutationObserver(() => {
      if (booted) { obs.disconnect(); return; }
      scan();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Hard stop so idle tabs don't keep an observer alive forever.
    setTimeout(() => obs.disconnect(), 180000);
  }

  // SPA navigation: Twitch swaps channels without a page load.
  function watchUrl() {
    const fire = () => {
      if (location.href === currentUrl) return;
      currentUrl = location.href;
      const next = resolveChannel();
      if (next && next !== Store.channel) {
        log('channel change →', next);
        Renderer.detachAll();
        Picker.reset();
        Composer.reset();
        booted = false;
        setTimeout(watchForChat, 500);
        Store.load(next);
      }
    };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); setTimeout(fire, 0); return r; };
    }
    window.addEventListener('popstate', () => setTimeout(fire, 0));
  }

  if (shouldRunHere()) {
    watchUrl();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', watchForChat, { once: true });
    } else {
      watchForChat();
    }
  }
})();
