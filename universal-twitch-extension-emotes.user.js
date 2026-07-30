// ==UserScript==
// @name         Universal Twitch Extension Emotes (BTTV / FFZ / 7TV)
// @namespace    https://github.com/Qnoses
// @version      3.1
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
    // Turn the browser's spellchecker off in Twitch's chat box, so third-party
    // codes stop being underlined as misspellings. This is only the default:
    // the toggle in the picker panel and in the userscript manager's menu
    // remembers its own choice, and once made that choice wins over this line.
    disableSpellcheck: false,
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

  // True in a twitch.tv document, which includes every embed and popout iframe
  // — those are twitch.tv documents too, which is the whole premise up top.
  // The picker, the composer preview and the spellcheck toggle are all gated
  // on this: they key on Twitch's own markup and have nothing to act on
  // anywhere else.
  const isTwitch = () => /(^|\.)twitch\.tv$/i.test(location.hostname);

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
    const ok = c => typeof c === 'string' && /^[a-z0-9_]{3,25}$/i.test(c);

    /**
     * Anything named for a channel is taken at face value. A bare `login` is
     * not, and it is the one prop here that can name the wrong person: the
     * components around a chat input carry the *viewer* as well as the channel
     * — chat identity, badges, the reply composer — and `login` on one of those
     * is your own account, not the one you are watching.
     *
     * So it is demoted rather than trusted or dropped. It stays as a last
     * resort for renderers that expose nothing better, but it is only returned
     * once every seed has been searched for something specific. Taking the
     * first match of either kind, as this did, let a generic hit low in one
     * seed's tree beat a `channelLogin` sitting further up.
     */
    let loose = null;

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
          const named = p.channelLogin || p.channelName
            || (p.channel && (p.channel.login || p.channel.name));
          if (ok(named)) return named.toLowerCase();
          if (!loose && ok(p.login)) loose = p.login.toLowerCase();
        }
      }
    }
    return loose;
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
    counts: {},
    signature: '',

    /**
     * Bumped whenever the page moves to a different channel. A load carries the
     * epoch it started under and is refused if that has moved on since.
     *
     * The signature guard cannot do this job. It asks whether a result is the
     * same as what we already hold, which is the right question for a refresh
     * and the wrong one for a result that arrived too late: a load for the
     * channel you *left* is different from what we hold, so it was accepted and
     * overwrote the channel you are actually on. That is not a narrow window
     * either — request() allows 15s per call and resolveTwitchId tries three
     * resolvers in sequence, so a single load can legitimately stay in flight
     * for the better part of a minute, which is long enough to give up on a
     * page and navigate away.
     */
    epoch: 0,
    retriedFor: -1,

    /** The page has moved on: nothing already in flight may adopt. */
    invalidate() {
      this.epoch++;
      // Cleared as well as invalidated. Leaving it would keep the old name in
      // the panel and the menu, and in the case that actually matters — the new
      // load also failing — it would stay there for good.
      this.channel = null;
    },

    async load(login) {
      const gen = this.epoch;
      const cacheKey = `ute:emotes:${login || '__global__'}`;
      const cached = gmGet(cacheKey, null);
      const age = cached ? Date.now() - cached.ts : Infinity;
      if (cached && age < CONFIG.cacheTTL) {
        log('cache hit', login, cached.emotes.length);
        this.adopt(cached.emotes, login, gen);
        // Only reach out again once the cache is genuinely ageing. Refreshing
        // on every page view meant six API calls per Twitch tab for emotes we
        // already had.
        if (age > CONFIG.cacheTTL / 2) setTimeout(() => this.fetchAll(login, cacheKey, gen), 5000);
        return;
      }
      await this.fetchAll(login, cacheKey, gen);
    },

    /**
     * Make a set of emotes the current one and tell everything drawn from it.
     *
     * This exists because load() has two exits and only one of them used to say
     * so. A fetch ingested, then rebuilt the chat, the picker and the composer;
     * a cache hit ingested and returned. At boot that difference is invisible,
     * since the renderer attaches and seeds itself afterwards either way — but
     * "Set channel" calls load() with nothing following it, so switching to a
     * channel visited inside the half-hour TTL loaded the right emotes into the
     * map and then drew none of them. The bug was not a missing call so much as
     * a second path that quietly did not have to make one.
     *
     * The unchanged-signature guard moved in here with it, and now covers both
     * exits rather than only the fetch. A channel change loads twice — the URL
     * watcher immediately, then boot 500ms later once chat has remounted — and
     * the second of those is now recognised as the no-op it is instead of
     * rebuilding every section a second time.
     */
    adopt(emotes, login, gen = this.epoch) {
      if (gen !== this.epoch) {
        log('discarded a late load for', login, '— the page has moved on');
        return false;
      }
      if (this.channel === login && emoteSignature(emotes) === this.signature) {
        log('emotes unchanged; nothing to rebuild');
        // Still worth a pass: the labels carry the channel, and a first load on
        // a page that resolved the same channel has not written them yet.
        Menu.register();
        Picker.syncPanel();
        return false;
      }
      this.ingest(emotes);
      this.channel = login;
      log('adopted', this.map.size, 'emotes for', login, this.counts);
      Menu.register();
      Renderer.reprocessAll();
      Picker.refresh();
      Picker.syncPanel();
      Composer.schedule();
      return true;
    },

    async fetchAll(login, cacheKey, gen = this.epoch) {
      const { providers } = CONFIG;
      let ffzRoom = null;
      let channelId = null;

      if (login) {
        const res = await resolveTwitchId(login);
        channelId = res.id;
        ffzRoom = res.ffzRoom || null;
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

      if (!emotes.length) {
        warn('no emotes resolved for', login);
        // Without this the script sits with an empty map for the life of the
        // page — no sections, no nav tabs, no control row, and a channel that
        // reads as undetected because Store.channel is only ever written by a
        // successful adopt. Nothing recovers on its own, and a reload during
        // the same blip fails the same way, so the state outlasts its cause.
        //
        // One retry, once per epoch, and only if the page has not moved on.
        if (gen === this.epoch && this.retriedFor !== gen) {
          this.retriedFor = gen;
          setTimeout(() => {
            if (gen === this.epoch) this.fetchAll(login, cacheKey, gen);
          }, 10000);
        }
        return;
      }

      // Slide the cache forward regardless, so a refresh that found nothing
      // new still buys another full TTL of quiet.
      gmSet(cacheKey, { ts: Date.now(), emotes });

      this.adopt(emotes, login, gen);
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
   * Place a card above (or below) a rect, in viewport coordinates, clamped so
   * it can't run off either edge. Shared by the hover tooltip and the composer
   * bubble: both are fixed-position and measured, which is what keeps them out
   * of every clipping and containing-block question in the chat UI.
   */
  function placeCard(el, rect, { below = false, align = 'center' } = {}) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    let top = below ? rect.bottom + 6 : rect.top - el.offsetHeight - 6;
    if (!below && top < 4) top = rect.bottom + 6;
    const x = align === 'start'
      ? rect.left + 10
      : rect.left + rect.width / 2 - el.offsetWidth / 2;
    el.style.top = Math.round(top) + 'px';
    el.style.left = Math.round(Math.max(4, Math.min(x, vw - el.offsetWidth - 4))) + 'px';
  }

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
      const src = img.currentSrc || img.src;
      const pic = el.querySelector('img');
      // Written only when it changes. Assigning the same value to src re-runs
      // the image request, and an animated emote comes back from that at its
      // first frame — so a card refreshed while it is already open shows a
      // still. See Composer.showBubble, where that refresh is constant.
      if (pic.getAttribute('src') !== src) pic.src = src;
      el.querySelector('.ute-card-code').textContent = img.dataset.uteCode || img.alt || '';
      el.querySelector('.ute-card-src').textContent = img.dataset.uteSrc || '';
      el.classList.add('ute-on');            // measure only once it's laid out

      // In the picker Twitch puts its own tooltip below the emote; in chat
      // there is rarely room below, so that stays above.
      placeCard(el, img.getBoundingClientRect(), { below });
    },

    hide() { if (this.el) this.el.classList.remove('ute-on'); },
  };

  /**
   * Nothing under these is chat, and some of it is ours. The chat root is the
   * whole chat room, so our own cards and overlays live inside it: when the
   * composer's preview card wrote the emote's name into itself, the observer
   * saw a new text node and painted a second copy of the emote over it.
   *
   * .chat-input is here because the composer owns its own overlay, the emote
   * picker is not chat, and the surrounding furniture is full of short words
   * — "Chat", "Reply", "Cancel", "Thread" — that a channel could easily have
   * an emote for. Rendering one onto the send button is not an improvement.
   */
  const NOT_CHAT = 'input, textarea, [contenteditable="true"], ' +
                   '.ute-wrap, .ute-card, .ute-panel, .ute-composer-layer, ' +
                   '.emote-picker, [data-a-target="chat-emote-picker"], .chat-input';

  /**
   * The one exception to that. Twitch's reply-thread tray mounts *inside*
   * .chat-input, and the parent message and its replies in there are ordinary
   * chat lines in ordinary chat markup — so the blanket exclusion above was
   * throwing away real chat. Matching the line rather than the tray keeps the
   * carve-out narrow: the tray's own chrome, and every other tray Twitch
   * mounts in that slot (bits, polls, predictions, raids), stays excluded.
   *
   * Deliberately kept in step with the twitch profile's `messages` selector
   * below; both key on the same hooks Twitch's own tooling uses.
   */
  const CHAT_IN_INPUT = '.chat-line__message, .chat-line__status, .user-notice-line, ' +
                        '[data-a-target="chat-line-message"], ' +
                        '[data-a-target="chat-message-text"]';

  /** True when the renderer must not write anywhere inside this element. */
  function offLimits(el) {
    const blocker = el.closest(NOT_CHAT);
    if (!blocker) return false;
    // Anything nearer than .chat-input — the editable, the picker, our own
    // nodes — is off limits outright.
    if (!blocker.matches('.chat-input')) return true;
    return !el.closest(CHAT_IN_INPUT);
  }

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
    // root → messageSelector | null. A Set lost the selector, which left
    // reprocessAll guessing at the shape of the tree it was walking.
    roots: new Map(),

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

      // Never touch inputs, links, or the emote nodes we already made — nor
      // .chat-input, save for the chat lines Twitch's reply-thread tray mounts
      // there. See offLimits.
      if (offLimits(el)) return;

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
      this.roots.set(root, messageSelector || null);
      root.dataset.uteRoot = '1';
      log('attached to', root, messageSelector);

      const handle = nodes => {
        for (const node of nodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            if (node.parentElement && !offLimits(node.parentElement)) {
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

    /**
     * Turn our rendered emotes back into the codes they replaced, so a
     * reprocess starts from the text again. Without this a refresh that
     * changed a set left the old pictures in place: an emote the channel
     * dropped kept rendering, and one whose URL moved kept the stale image.
     *
     * Same React contract as everywhere else — .ute-wrap is ours, so removing
     * it is removing our own node, and React never knew it was there. The
     * codes come back space-joined, which also restores the separator a
     * zero-width overlay swallowed on the way in.
     */
    unwrap(root) {
      for (const wrap of root.querySelectorAll('.ute-wrap')) {
        const codes = Array.from(wrap.querySelectorAll('img.ute-emote'))
          .map(img => img.dataset.uteCode || img.alt)
          .filter(Boolean);
        if (!codes.length) { wrap.remove(); continue; }
        wrap.replaceWith(document.createTextNode(codes.join(' ')));
      }
    },

    /**
     * Deliberately no normalize() on the result: merging text nodes React is
     * tracking separately is the kind of write this script exists to avoid,
     * and splitting on whitespace means a re-split token still matches.
     */
    reprocessAll() {
      for (const [root, selector] of this.roots) {
        this.unwrap(root);
        root.querySelectorAll('[data-ute-done="1"]').forEach(el => delete el.dataset.uteDone);
        if (selector) {
          root.querySelectorAll(selector).forEach(el => this.processMessage(el));
          continue;
        }
        // No profile, so no selector: fall back to walking the top of the tree,
        // which is what the generic detector hands us.
        Array.from(root.children).forEach(c => this.processMessage(c));
        root.querySelectorAll(':scope > * > *').forEach(c => this.processMessage(c));
      }
    },

    detachAll() {
      for (const root of this.roots.keys()) {
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
    // Present in both the category list and the search view, which is what
    // makes it usable as the search view's insertion anchor.
    block: '.emote-picker__content-block',
    grid: '.emote-grid',
    lock: '[data-test-selector="badge-button-lock"]',
    search: 'input[type="search"]',
    nav: '[class*="emote-picker__nav"] [role="toolbar"]',
    input: '[data-a-target="chat-input"][contenteditable="true"], .chat-wysiwyg-input__editor',
    // Twitch's own composer rendering, present only when logged in.
    nativeEmote: '[data-a-target="wysiwyg-chat-input-emote"], [data-slate-void="true"]',
    nativePreview: '[data-a-target="chat-input-emote-preview"]',
  };

  // Twitch heads its search view "Search Results for …", which stops being true
  // of that one block the moment our sections sit below it — those are search
  // results too. Renamed to say which emotes the block actually holds.
  const TWITCH_RESULTS_LABEL = 'Twitch Emotes';

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

  /**
   * Fallback icon for a nav tab, used only when the channel's own tab has an
   * image element with no usable source. Section headers deliberately carry no
   * icon at all — see buildSection.
   */
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
    // Last successful template harvest, for views that offer nothing to clone.
    cache: null,
    // Which view the current sections were built for; see check().
    searching: false,
    query: '',
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
      this.searching = false;
      if (this.hostObserver) { this.hostObserver.disconnect(); this.hostObserver = null; }
    },

    check() {
      const picker = document.querySelector(PSEL.picker);
      if (!picker) { this.sections = []; return; }
      if (!Store.map.size) return;
      // Re-asserted every pass rather than only on injection. The search box
      // sits in a different React subtree from the sections list and re-renders
      // on its own, so a listener attached once is a listener eventually lost —
      // the same failure the nav rail has, and the reason typing in the search
      // box stopped filtering our sections after Twitch re-rendered the input.
      // Both of these are no-ops once correctly attached.
      this.wireSearch(picker);
      this.wireHoverCards(picker);
      this.syncQuery(picker);

      // A non-empty box is exactly what puts Twitch into the search view, so the
      // query is a cheaper and more reliable read of which view we are in than
      // anything in the DOM. It matters because the status row belongs in the
      // category list and not in the search view: crossing between the two needs
      // a rebuild rather than a reposition. Entering search forces one anyway —
      // Twitch unmounts our sections — but leaving it does not, and without this
      // the status row would never come back.
      const searching = !!this.query;
      const intact = this.sections.length && this.sections.every(n => picker.contains(n));
      if (intact && searching === this.searching) {
        this.reanchor(picker);
        this.injectNav(picker, this.groups());   // no-op once correctly placed
        this.relabelResults(picker);             // re-applied after a re-render
        this.matchResultsSpacing(picker);
        return;
      }
      this.sections = [];
      try { this.inject(picker); } catch (e) { warn('picker injection failed:', e.message); }
    },

    /**
     * Equalise the gap between heading and first row across all three groups in
     * the search view. Twitch's results heading sits closer to its grid than a
     * section heading does, so left alone the groups don't line up.
     *
     * The difference is measured, not assumed. It comes from two different
     * styled-components rules, neither of whose values are knowable from the
     * markup, and it moves with Twitch's chat font-size setting — so no fixed
     * number would hold, and measuring closes whatever the discrepancy happens
     * to be rather than a discrepancy we guessed at.
     *
     * This is the second and last place the script writes to Twitch's own DOM:
     * an inline padding on its heading's wrapper. Both sides are cleared before
     * measuring so repeated passes can't compound, and if React re-renders the
     * block the padding goes with it and the next check puts it back.
     */
    matchResultsSpacing(picker) {
      if (!this.searching) return;
      // A section filtered down to nothing is display:none and measures zero.
      const mine = this.sections.find(s => s.style.display !== 'none');
      const block = this.resultsBlock(picker);
      if (!mine || !block) return;

      const ourHead = mine.querySelector(PSEL.header);
      const theirTitle = this.headingOf(block);
      const theirHead = theirTitle && theirTitle.parentElement;
      if (!ourHead || !theirHead) return;

      // Cleared on both sides first, so a previous pass can neither compound nor
      // skew the reading.
      theirHead.style.paddingBottom = '';
      for (const s of this.sections) {
        const h = s.querySelector(PSEL.header);
        if (h) h.style.paddingBottom = '';
      }

      /**
       * Measured from the title's own text down to the grid, not from the header
       * element's box.
       *
       * The first version of this measured box to box and always read zero on
       * both sides, which is why it changed nothing: the space under a heading is
       * padding *inside* that header, and getBoundingClientRect returns the
       * border box — so the header's bottom edge already sits below the gap,
       * flush against the grid. Measuring from the text captures the padding
       * wherever between the two it happens to live. Both grids carry identical
       * classes, so whatever padding they hold of their own cancels out in the
       * difference.
       */
      const gapBelowTitle = (b) => {
        const title = this.headingOf(b);
        const grid = b.querySelector(PSEL.grid);
        if (!title || !grid) return null;
        return grid.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      };

      const ours = gapBelowTitle(mine);
      const theirs = gapBelowTitle(block);
      if (ours === null || theirs === null) return;

      // Clamped: a bad reading should leave the layout alone rather than shove a
      // heading half the picker away from its emotes.
      const delta = Math.max(-24, Math.min(24, Math.round(ours - theirs)));
      log('picker spacing: ours', Math.round(ours), 'twitch', Math.round(theirs),
          'delta', delta);
      if (!delta) return;

      if (delta > 0) {
        theirHead.style.paddingBottom = delta + 'px';
      } else {
        // The other direction, should Twitch ever space its results heading more
        // generously than a section's. Ours are our own nodes to style.
        for (const s of this.sections) {
          const h = s.querySelector(PSEL.header);
          if (h) h.style.paddingBottom = -delta + 'px';
        }
      }
    },
    /**
     * Rename Twitch's search-results heading. The first of the two places this
     * script writes to Twitch's own DOM, and it does so as narrowly as it can:
     * the existing text node's value is set rather than replaced, so the node
     * React tracks stays the node React tracks and a later re-render can still
     * update it — which is also how the label survives, since that re-render
     * brings Twitch's own text back and the next check puts ours in again.
     *
     * The block is found by being a content block that has no section header and
     * does have a grid. Every category section has a header, so this cannot
     * reach one even if the view were misread.
     */
    relabelResults(picker) {
      if (!this.searching || !this.sections.length) return;
      const block = this.resultsBlock(picker);
      if (!block || !block.querySelector(PSEL.grid)) return;
      const title = this.headingOf(block);
      const text = title && title.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) return;
      if (text.nodeValue === TWITCH_RESULTS_LABEL) return;
      text.nodeValue = TWITCH_RESULTS_LABEL;
      // Twitch mirrors the heading into a tooltip; leaving it would show the old
      // wording on hover.
      if (title.hasAttribute('title')) title.setAttribute('title', TWITCH_RESULTS_LABEL);
    },

    /**
     * The input's live value is the authority, not the events we happened to
     * hear. A keystroke that landed while our listener was detached, or a clear
     * Twitch performed itself, would otherwise leave our sections filtered by a
     * query that is no longer in the box.
     */
    syncQuery(picker) {
      const input = picker.querySelector(PSEL.search);
      const query = input ? input.value.trim().toLowerCase() : '';
      if (query !== this.query) this.filter(query);
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

    /**
     * Twitch's own block in the search view: a content block that isn't ours and
     * carries no section header. Preferring one that has a grid keeps this off
     * the lazy placeholder blocks at the foot of the category list, which are
     * header-less too.
     */
    resultsBlock(picker) {
      const blocks = Array.from(picker.querySelectorAll(PSEL.block))
        .filter(b => !b.hasAttribute('data-ute-section') && !b.querySelector(PSEL.header));
      return blocks.find(b => b.querySelector(PSEL.grid)) || blocks.pop() || null;
    },

    /**
     * A block's heading, wherever it keeps it: category sections wrap it in
     * .emote-grid-section__header-title, the search block has a bare <strong>.
     * Cells are excluded so one can never be taken for the heading.
     */
    headingOf(block) {
      return Array.from(block.querySelectorAll('strong'))
        .find(s => !s.closest(PSEL.grid)) || null;
    },

    /**
     * A cell to clone. Subscriber emotes render with a padlock overlay and ours
     * are never locked, so a clean cell is preferred — searched across every
     * grid in the picker, since all of them use the same cell shape and a grid
     * whose first cell happens to be locked would otherwise force a bad
     * template. The overlay is stripped either way, in case none was clean.
     */
    pickCell(picker, grid) {
      const first = grid && grid.firstElementChild;
      if (!first) return null;
      let preferred = first;
      for (const c of picker.querySelectorAll(PSEL.grid + ' > *')) {
        if (c.closest('[data-ute-section]')) continue;   // never clone our own clones
        if (!c.querySelector(PSEL.lock)) { preferred = c; break; }
      }
      const cell = preferred.cloneNode(true);
      cell.querySelectorAll(PSEL.lock).forEach(n => n.remove());
      return cell;
    },

    /**
     * Harvest live markup to clone from, so no build hash is ever written down.
     *
     * The category list gives us a real section, header wrapper and all. The
     * search view gives us none — no `.emote-grid-section__header-title` appears
     * anywhere in it — so every successful harvest is kept and the search view is
     * built from the last one. Its own results block is a content block with a
     * heading and a grid and could be cloned instead, but shouldn't be: that
     * heading is spaced more tightly than a section's, and copying it made our
     * sections look cramped and unlike themselves in the category list.
     */
    templates(picker) {
      // Our sections carry a header and a grid too, so they'd otherwise
      // qualify as templates and as the insertion anchor.
      const headers = Array.from(picker.querySelectorAll(PSEL.header))
        .filter(h => !h.closest('[data-ute-section]'));

      // Prefer a section whose header carries an avatar — that's the channel
      // section, and its shape is the one we're imitating.
      const blocks = headers.map(h => h.parentElement && h.parentElement.parentElement)
        .filter(b => b && b.querySelector(PSEL.grid));

      if (blocks.length) {
        const block = blocks.find(b => b.querySelector(PSEL.header + ' img'))
          || blocks[blocks.length - 1];
        const cell = this.pickCell(picker, block.querySelector(PSEL.grid));
        if (cell) {
          // Detached copies, kept for the search view. Deliberately not cleared
          // by reset(): these are build-artefact shapes, not channel state, and
          // a fresh deploy arrives with a page load.
          this.cache = { block: block.cloneNode(true), cell: cell.cloneNode(true) };
          return { block, cell, container: block.parentElement, blocks };
        }
      }

      // Search view. Nothing here is a section, and cloning Twitch's results
      // block instead was a mistake: its heading sits directly on its grid,
      // tighter than a section heading does, so our sections came out visibly
      // cramped and inconsistent with how they look in the category list. The
      // cached section is the right shape; the gap between it and Twitch's block
      // is closed from the other end, by matchResultsSpacing.
      const results = this.resultsBlock(picker);
      if (!results || !results.parentNode) return null;
      if (!this.cache) return null;
      return {
        block: this.cache.block,
        cell: this.cache.cell,
        container: results.parentNode,
        anchor: results,
      };
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

      let ref = this.anchorFor(picker)
        || tpl.anchor
        || (tpl.blocks && tpl.blocks[tpl.blocks.length - 1]);
      if (!ref || !ref.parentNode) return;

      this.searching = !!this.query;

      // No status row in the search view. It reads as a third result group
      // wedged between Twitch's matches and ours, and the counts it shows are
      // for the whole channel rather than for anything on screen.
      if (CONFIG.pickerPanel && !this.searching) {
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

      this.injectNav(picker, groups);
      this.relabelResults(picker);
      this.matchResultsSpacing(picker);
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

    /**
     * Twitch mounts sections progressively; keep our position correct.
     *
     * This also carries the trip back from the search view. Our sections are
     * inserted there as children of the scroll container, and can survive the
     * results block being unmounted — so on the pass where the category list
     * reappears, they are strays a level too high, and this puts them back
     * below the channel section.
     */
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
     * The panel's controls, hosted here rather than floating over the chat UI
     * where they collided with Twitch's own buttons.
     *
     * Three buttons on one row, each carrying its own state in its label. The
     * separate readouts this replaces — the channel name as bare text beside a
     * "Set channel" button, and a line of per-provider counts — said in two
     * lines what a label can say in one, and the counts in particular read as a
     * third thing to parse before reaching a control. Both now sit on the
     * button they describe.
     */
    buildPanel() {
      const panel = document.createElement('div');
      panel.className = 'ute-panel';
      panel.dataset.utePanel = '1';

      const button = (mark, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset[mark] = '1';
        b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
        return b;
      };

      panel.append(
        button('uteChannel', promptForChannel),
        button('uteSpellcheck', () => Spellcheck.toggle()),
        button('uteReload', forceReload),
      );
      this.labelPanel(panel);
      return panel;
    },

    /**
     * Every label in one place, so changing one needs no rebuild and the two
     * callers cannot drift apart.
     *
     * Each button's tooltip and accessible name carry what the label has no
     * room for — which for the channel is the part of the name the label had to
     * cut, and for the other two is what the control actually does.
     */
    labelPanel(panel) {
      const at = k => panel.querySelector(`[data-ute-${k}]`);

      const channel = at('channel');
      if (channel) {
        // Cut in script rather than by max-width and text-overflow, because the
        // limit is a number of characters and CSS has no unit for that: `ch` is
        // the width of a zero, and in a proportional face a run of narrow
        // letters would survive well past the cut while a run of wide ones
        // would be clipped short of it.
        const name = Store.channel;
        const shown = !name ? 'N/A'
          : name.length > 7 ? name.slice(0, 7) + '…'
          : name;
        channel.textContent = `Channel: ${shown}`;
        const hint = name
          ? `Emotes are loaded for ${name}. Click to use a different channel.`
          : 'No channel could be detected for this page. Click to set one manually.';
        channel.title = hint;
        channel.setAttribute('aria-label', hint);
      }

      const spell = at('spellcheck');
      if (spell) Spellcheck.labelButton(spell);

      const reload = at('reload');
      if (reload) {
        // Summed off PICKER_GROUPS rather than from a second list of provider
        // keys written out here: it already pairs every key with the short tag
        // the nav rail uses, so the abbreviations in the label and the ones in
        // the picker cannot drift, and a provider added there is counted here
        // without being mentioned twice. Channel and global sets fold together
        // because they share a tag.
        const c = Store.counts;
        const sums = new Map();
        for (const g of PICKER_GROUPS) {
          sums.set(g.tag, (sums.get(g.tag) || 0) + (c[g.provider] || 0));
        }
        reload.textContent = 'Reload: ' +
          Array.from(sums, ([tag, count]) => `${tag} ${count}`).join(' · ');
        const hint = 'Refetch every emote set.';
        reload.title = hint;
        reload.setAttribute('aria-label', hint);
      }
    },

    /**
     * Re-label an open panel in place.
     *
     * Deliberately not refresh(): that drops every section and rebuilds them,
     * which for a channel with several hundred 7TV emotes is thousands of cells
     * discarded to change one word. Nothing a label reports touches the emote
     * grid, so nothing about the emote grid needs rebuilding.
     */
    syncPanel() {
      if (this.panel) this.labelPanel(this.panel);
    },

    buildSection(tpl, group) {
      const block = tpl.block.cloneNode(true);
      block.dataset.uteSection = group.provider;
      // querySelectorAll never returns the root, so the clone's own id has to
      // go separately. Twitch's content blocks carry none today; duplicating
      // one if that changes would be our bug, not theirs.
      block.removeAttribute('id');
      block.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

      const grid = block.querySelector(PSEL.grid);
      if (!grid) return null;

      const title = this.headingOf(block);
      if (title) {
        title.textContent = group.label;
        // Twitch mirrors its heading into a tooltip; a clone would carry the
        // wrong one.
        if (title.hasAttribute('title')) title.setAttribute('title', group.label);
      }

      const header = block.querySelector(PSEL.header);
      if (header) {
        // Drop Twitch's own controls (the report menu and its balloon), which
        // are inert in a clone and would otherwise sit there doing nothing.
        header.querySelectorAll('button, [role="dialog"], [data-toggle-balloon-id]')
          .forEach(el => el.remove());
        // No avatar. The channel section we clone from carries one, and a
        // generated stand-in read as a foreign object next to Twitch's real
        // profile pictures. "Frequently Used" proves a section needs no image,
        // so the slot goes entirely...
        header.querySelectorAll('.emote-grid-section__header-image').forEach(el => el.remove());
        // ...along with the layout divs that spaced it and held the report
        // control, which are now empty and would otherwise leave the title
        // indented by a gap with nothing in it. Matched by being empty rather
        // than by class, since those classes are per-deploy build hashes.
        for (const el of Array.from(header.querySelectorAll('div')).reverse()) {
          if (!el.firstElementChild && !(el.textContent || '').trim()) el.remove();
        }
      }

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
        // Only the cell carries data-ute-code — buildCell deliberately keeps it
        // off the image, since that attribute is what counts cells and drives
        // the search filter. So closest() lands on the cell and the image is
        // one step down; the IMG branch is there in case that ever changes.
        const hit = e.target.closest('[data-ute-code]');
        if (!hit) return null;
        return hit.tagName === 'IMG' ? hit : hit.querySelector('img');
      };
      picker.addEventListener('mouseover', e => { const i = at(e); if (i) Tooltip.show(i, true); });
      picker.addEventListener('mouseout', e => { if (at(e)) Tooltip.hide(); });
    },

    /**
     * Twitch filters its own sections through React state, which never sees
     * our nodes, so we filter them ourselves off the same input. Marked so a
     * re-check doesn't stack a second listener on the same element — and
     * re-attached automatically when Twitch replaces the element, since a fresh
     * one arrives without the mark.
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
      // Nothing to do about the status row here: it exists only while the box is
      // empty, so a query can never be hiding one. inject() owns its presence.
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
     * Deliberately absent: any attempt to move the rail's selected-tab
     * highlight onto these tabs. React owns that state and we can neither read
     * nor write it, so every version of that synchronisation leaked into an
     * invalid state after enough clicks. Left alone, Twitch's own scroll spy
     * keeps the channel tab lit while our sections are in view — they sit
     * inside its range — which is both correct and free. These tabs scroll to
     * their section and claim nothing.
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
        item.removeAttribute('id');
        item.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        // The channel tab may well be the active one, and its active classes
        // would otherwise come along with the clone — which is why every tab
        // looked selected after reopening the picker. This is the only
        // highlight-related work left, and it is done on our own clone.
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
    /* above the chat box — measured, see Composer.showBubble */
    .ute-bubble { position: fixed; z-index: 2147483000; }
    /* beside whatever emote is hovered */
    .ute-tip { position: fixed; z-index: 2147483000; }
    .ute-panel {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px;
      margin: 4px 0 0; padding: 6px 10px 0;
      font: 11px/1.5 Inter, Roobert, Helvetica, sans-serif; color: #adadb8;
    }
    .ute-panel button {
      all: unset; display: inline-block; white-space: nowrap;
      padding: 2px 8px; border-radius: 3px; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, .14); color: #dedee3; font: inherit;
    }
    /* No max-width or text-overflow on the channel button: the name is already
       cut to length in labelPanel, where a limit in characters can actually be
       expressed. nowrap above keeps each button whole, so a row that outgrows
       the picker breaks between buttons rather than inside one. */
    .ute-panel button:hover { background: rgba(255, 255, 255, .08); }
    .ute-panel button:focus-visible { outline: 2px solid #bf94ff; outline-offset: 1px; }
    /* No styling hangs off aria-pressed. The word in the label already says
       which state the toggle is in, and a colour saying it a second time only
       raises the question of which of the three controls is special. The
       attribute stays for screen readers, which have no label to read twice. */
    .ute-nav-item { position: relative; }
    .ute-nav-tag {
      position: absolute; bottom: 1px; left: 50%; transform: translateX(-50%);
      padding: 0 3px; border-radius: 2px; white-space: nowrap;
      background: rgba(0, 0, 0, .82); color: #fff;
      font: 700 7px/10px Inter, Roobert, Helvetica, sans-serif;
      letter-spacing: .03em; pointer-events: none;
    }
  `);

  /**
   * The CSS Custom Highlight API styles arbitrary Ranges with no DOM mutation,
   * which is the one thing that lets the composer hide a code without covering
   * it: `color: transparent` on exactly those characters. The alternative — and
   * the fallback below — is painting an opaque box over them in a colour guessed
   * from the input's ancestors, which is wrong over a gradient or an image.
   *
   * Only paint properties are available here; the spec excludes anything that
   * affects layout, precisely so a highlight can never reflow text. So this
   * hides a code. It cannot narrow one.
   */
  const HIGHLIGHT_NAME = 'ute-composer-code';
  const HIGHLIGHTS = typeof Highlight === 'function'
    && typeof CSS !== 'undefined' && !!(CSS && CSS.highlights);

  addStyle(`
    ::highlight(${HIGHLIGHT_NAME}) { color: transparent; text-shadow: none; }
  `);

  const Composer = {
    editable: null,
    box: null,
    layer: null,
    bubble: null,
    hostObserver: null,
    contentObserver: null,
    host: null,
    onFocusIn: null,
    handlers: null,
    queued: false,
    composing: false,
    // Set while the overlay is blanked for a live selection, so the pass that
    // clears the selection still runs even if focus has left the editable by
    // then — otherwise the emotes never come back. See the selectionchange
    // handler and render().
    selectionHidden: false,

    start() {
      if (!CONFIG.composerPreview || this.hostObserver) return;
      if (!/(^|\.)twitch\.tv$/i.test(location.hostname)) return;
      const host = document.querySelector('.chat-input') || document.body;
      if (!host) return;
      // Repaint as well as re-attach: the overlay and the bubble are both
      // measured, and anything mounting in this subtree — the reply-thread
      // tray above all — moves the box they are measured against.
      //
      // Records from our own layer are dropped, and that is not an
      // optimisation. The layer is a child of the box, which is inside the
      // host: every repaint replaces its tokens, those removals and insertions
      // arrive back here as mutations, and scheduling on them paints again.
      // Unfiltered that is a loop running once a frame for as long as the box
      // holds a code — which is also what kept the bubble's image pinned to its
      // first frame, since each turn of it rewrote the card. Nothing inside the
      // layer can move the box the layer is measured against, so there is
      // nothing in those records worth waking up for.
      this.hostObserver = new MutationObserver(muts => {
        if (this.layer && muts.every(m => this.layer.contains(m.target))) return;
        this.attach();
        this.schedule();
      });
      this.hostObserver.observe(host, { childList: true, subtree: true });

      // Moving the caret from one composer to the other changes no markup, so
      // the observer above cannot see it and target() would keep returning the
      // editable that was focused when the last mutation happened. focusin
      // bubbles, so one listener on the host covers every composer under it,
      // and attach() costs nothing on the passes where the target is unchanged.
      this.host = host;
      this.onFocusIn = () => this.attach();
      host.addEventListener('focusin', this.onFocusIn);

      this.attach();
    },

    /**
     * The composer being typed into, which is not always the first one in the
     * tree. Twitch's reply-thread tray brings its own editable, and both carry
     * the same hooks — so a plain querySelector binds whichever the markup
     * happens to put first, which was how a reply could be typed with no
     * preview under it at all.
     *
     * Focus is the right tiebreak rather than a second overlay, because only
     * one of them can be typed into: the state this module maintains is one
     * layer, one bubble and one measured box, and there is nothing to preview
     * in a composer nobody is writing in. Where the choice is unambiguous —
     * one editable, or none focused yet — this reads exactly as before.
     *
     * Spellcheck deliberately does the opposite and writes to every match. The
     * difference is what is being maintained: an attribute is per element and
     * costs nothing to hold on all of them, an overlay is a live measurement of
     * one box against one caret.
     */
    target() {
      const all = document.querySelectorAll(PSEL.input);
      if (all.length < 2) return all[0] || null;
      const active = document.activeElement;
      return Array.from(all).find(el => el === active || el.contains(active)) || all[0];
    },

    attach() {
      const editable = this.target();
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
        // On document.body, fixed and measured — never parented to a Twitch
        // element. It used to hang off .chat-input with bottom: 100%, which
        // needed .chat-input made into a containing block and put the card
        // above whatever else that element happened to contain. With the
        // reply-thread tray open, that is the height of the entire thread.
        const bubble = document.createElement('div');
        bubble.className = 'ute-card ute-bubble';
        bubble.setAttribute('aria-hidden', 'true');
        bubble.innerHTML = '<img alt=""><span class="ute-card-code"></span>' +
                           '<span class="ute-card-src"></span>';
        document.body.appendChild(bubble);
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
        selectionchange: () => {
          // The activeElement test alone is too narrow now that a selection
          // blanks the overlay. A drag that starts in the message list and ends
          // in the box never makes the editable active, and a click elsewhere
          // that clears such a selection makes it inactive before we hear about
          // it — so the state the overlay needs to leave would be the one state
          // that never scheduled a pass out of itself.
          if (this.editable === document.activeElement
              || this.selectionHidden
              || this.selectionActive()) this.schedule();
        },
        resize: () => this.schedule(),
      };
      editable.addEventListener('scroll', this.handlers.scroll, { passive: true });
      editable.addEventListener('compositionstart', this.handlers.compositionstart);
      editable.addEventListener('compositionend', this.handlers.compositionend);
      document.addEventListener('selectionchange', this.handlers.selectionchange);
      window.addEventListener('resize', this.handlers.resize, { passive: true });

      this.schedule();
      log('composer preview attached');
    },

    detach() {
      this.setHighlight(null);
      if (this.contentObserver) { this.contentObserver.disconnect(); this.contentObserver = null; }
      if (this.editable && this.handlers) {
        this.editable.removeEventListener('scroll', this.handlers.scroll);
        this.editable.removeEventListener('compositionstart', this.handlers.compositionstart);
        this.editable.removeEventListener('compositionend', this.handlers.compositionend);
        document.removeEventListener('selectionchange', this.handlers.selectionchange);
        window.removeEventListener('resize', this.handlers.resize);
      }
      if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
      if (this.bubble && this.bubble.parentNode) this.bubble.parentNode.removeChild(this.bubble);
      this.editable = this.box = this.layer = this.bubble = this.handlers = null;
      this.selectionHidden = false;
    },

    reset() {
      this.detach();
      if (this.hostObserver) { this.hostObserver.disconnect(); this.hostObserver = null; }
      if (this.host && this.onFocusIn) this.host.removeEventListener('focusin', this.onFocusIn);
      this.host = this.onFocusIn = null;
    },

    schedule() {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => { this.queued = false; try { this.render(); } catch (e) { log('composer', e.message); } });
    },

    /**
     * Hand the painted codes' ranges to the highlight registry, or drop the entry
     * when there are none. Rebuilt from scratch on every pass: Slate replaces the
     * editable's text nodes on each keystroke, so yesterday's ranges are detached
     * and simply stop painting.
     */
    setHighlight(ranges) {
      if (!HIGHLIGHTS) return;
      try {
        if (ranges && ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
        else CSS.highlights.delete(HIGHLIGHT_NAME);
      } catch (e) { log('highlight', e.message); }
    },

    clear() {
      if (this.layer) this.layer.replaceChildren();
      this.setHighlight(null);
      this.showBubble(null);
    },

    /**
     * BTTV's speech-bubble: the code under the caret hasn't been committed
     * with a space yet, so it stays editable text and gets a card instead.
     * The same rule that keeps the caret's token unpainted drives this.
     */
    showBubble(info, codeRect) {
      const bubble = this.bubble;
      if (!bubble) return;
      // The code is deliberately left on the node when the card is hidden, so
      // coming back to the same emote costs no new image request and resumes
      // the animation rather than restarting it.
      if (!info || !this.box) { bubble.classList.remove('ute-on'); return; }

      /**
       * The one card in the script that was showing a still, and the reason is
       * how often it is written rather than what it is written with.
       *
       * render() runs on every keystroke, every selection change and every
       * repaint, and calls this on each pass. Assigning src re-runs the image
       * request even when the value is identical — it is the standard way to
       * restart a GIF — so an animated emote was being sent back to frame one
       * faster than it could reach frame two. The hover cards escaped it only
       * by being written once per mouseover.
       *
       * Guarding the write on the code fixes it for good rather than for a
       * particular repaint cadence: the picture is now built once per emote and
       * left alone, however many passes go over it.
       */
      if (bubble.dataset.uteCode !== info.code) {
        bubble.dataset.uteCode = info.code;
        const img = bubble.querySelector('img');
        img.alt = info.code;
        img.src = info.url;
        bubble.querySelector('.ute-card-code').textContent = info.code;
        bubble.querySelector('.ute-card-src').textContent = info.label;
      }
      bubble.classList.add('ute-on');       // measure only once it's laid out

      /**
       * Anchored to the code itself, both axes.
       *
       * On a message long enough to wrap this puts the card over the line above
       * the one being typed, which looks like a drawback and is not: it is what
       * Twitch's own emote preview does, so it is the behaviour a Twitch user
       * already expects. Matching it is worth more than keeping the whole field
       * clear — an expectation met beats a line of your own text visible, and
       * the card is dismissed by the same keystroke that finishes the code.
       *
       * Where a code is long enough to wrap, it is anchored to the first
       * fragment rather than to whichever one holds the caret, so the card
       * keeps one position for the whole time you are typing that code. With
       * no rect to work from this falls back to the corner of the box rather
       * than guessing.
       */
      placeCard(bubble, codeRect || this.box.getBoundingClientRect(),
                codeRect ? {} : { align: 'start' });
    },

    /**
     * First non-transparent background above the input, to mask the text with.
     *
     * A guess, and the reason highlights are preferred where available: it walks
     * ancestors for a solid colour and has nothing sensible to return over a
     * gradient or an image. Only reached when the highlight API is missing.
     */
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

    /**
     * True while a non-collapsed selection overlaps the composer.
     *
     * Scoped to selections that actually reach the box: selecting a line out of
     * the message list is not a reason to blank the thing you are typing into.
     * intersectsNode rather than a check on the anchor, so a selection that
     * spans the box without either end landing in it — select-all, or a drag
     * from above it to below — counts too.
     */
    selectionActive() {
      const el = this.editable;
      if (!el) return false;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i);
        try { if (r.intersectsNode(el)) return true; }
        catch (e) { if (el.contains(r.startContainer) || el.contains(r.endContainer)) return true; }
      }
      return false;
    },

    render() {
      if (!this.editable || !this.layer || this.composing) return;
      if (!Store.map.size) { this.clear(); return; }

      /**
       * A live selection takes the overlay down entirely.
       *
       * This is the one state where the picture and the code it stands for were
       * both visible at once. The composer hides a code with `color:
       * transparent` rather than by removing it, and the browser paints
       * selected text in the selection's own colours — selection outranks a
       * custom highlight — so the moment a code fell inside a selection its
       * characters came back underneath the emote already drawn over them.
       *
       * Blanking is the answer rather than extending the mask, and the script
       * already argued the case: a code under the caret gives up its picture so
       * that it can be edited as text. A selected code is being handled as text
       * for the same kind of reason — to be copied, replaced or deleted — and
       * the same answer follows. It also leaves the selection reading exactly
       * as the message will send, and puts the highlight rectangles back around
       * the characters they belong to instead of around a picture.
       *
       * All of it goes, not only the codes inside the selection. A selection is
       * a transient thing you are looking at deliberately, the state lasts as
       * long as a drag, and a box that is half pictures and half codes reads
       * worse than one that is briefly all text.
       */
      if (this.selectionActive()) {
        this.selectionHidden = true;
        this.clear();
        return;
      }
      this.selectionHidden = false;

      const raw = (this.editable.textContent || '').replace(/\uFEFF/g, '');
      if (!raw.trim()) { this.clear(); return; }

      const boxRect = this.box.getBoundingClientRect();
      const caret = this.caretToken();
      // Only needed for the masking fallback; skipped entirely, along with its
      // six getComputedStyle calls, where highlights hide the text instead.
      const bg = HIGHLIGHTS ? '' : this.background();
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
      let caretRect = null;
      const hidden = [];
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
            // Measured even though this code is deliberately not painted: the
            // preview card is anchored to it, and without a rect it has nothing
            // to sit over but the corner of the box.
            //
            // The first fragment, always. A wrapped code has one rect per line
            // it touches, and following the caret between them would slide the
            // card up and down as you typed through a single word. Anchoring to
            // where the code begins is both stable and uniform — every code
            // previews in the same place relative to itself. It reads well for
            // the wrapped case too: a code long enough to wrap is longer than a
            // line, so the browser starts it on a fresh one, and that first
            // fragment is a full line with the card centred over it.
            const cr = document.createRange();
            cr.setStart(node, start);
            cr.setEnd(node, end);
            caretRect = Array.from(cr.getClientRects())
              .find(r => r.width > 0 && r.height > 0) || null;
            continue;
          }

          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          const rects = Array.from(range.getClientRects())
            .filter(r => r.width > 0 && r.height > 0);
          if (!rects.length) continue;

          // One rect per line the code occupies. Codes long enough to wrap are
          // common — 7TV has several past fifty characters — and abandoning
          // them left the raw code sitting in the box as text.
          //
          // The widest fragment gets the picture. The rejected alternative was
          // slicing the image across the break the way the text itself breaks:
          // the halves cannot line up, because the fragment widths come from the
          // text and bear no relation to the emote's own aspect ratio, and a
          // picture cut in two reads as broken rather than as wrapped. A blank
          // tail on the shorter fragment does not, and the boxes still occupy
          // exactly the space the text did, so nothing reflows.
          let host = 0;
          for (let i = 1; i < rects.length; i++) {
            if (rects[i].width > rects[host].width) host = i;
          }

          // One range covers every fragment at once, so a wrapped code needs no
          // per-fragment bookkeeping to be hidden.
          hidden.push(range);

          for (let i = 0; i < rects.length; i++) {
            // Without highlights each fragment needs its own opaque box. With
            // them the text is already invisible, so only the fragment carrying
            // the picture needs a node at all.
            if (i !== host && HIGHLIGHTS) continue;
            const r = rects[i];
            const token = document.createElement('span');
            token.className = 'ute-composer-token';
            token.dataset.uteCode = match[0];
            token.style.left = (r.left - boxRect.left) + 'px';
            token.style.top = (r.top - boxRect.top) + 'px';
            token.style.width = r.width + 'px';
            token.style.height = r.height + 'px';
            if (bg) token.style.background = bg;
            if (i === host) {
              const img = document.createElement('img');
              img.src = emote.url;
              if (emote.srcset) img.srcset = emote.srcset;
              img.alt = match[0];
              token.appendChild(img);
            }
            frag.appendChild(token);
          }
        }
      }

      this.layer.replaceChildren(frag);
      this.setHighlight(hidden);
      this.showBubble(caretMatch, caretRect);
    },
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * 10. SPELLCHECK SUPPRESSION  (twitch.tv only)
   *
   * The browser's dictionary has never heard of catJAM or peepoHappy, so every
   * third-party code in the chat box picks up a misspelling underline. Section
   * 9 then paints the emote over those characters without removing them — it
   * hides them with `color: transparent`, and a spelling marker is not the
   * text's colour, so it survives underneath the picture. The result reads as
   * a red squiggle under the emote itself.
   *
   * Two things could be done about that and only one of them is honest:
   *
   *   - Suppress the marker. One attribute, no layout, nothing to keep in
   *     sync, and the underline is gone from the codes Twitch leaves as text
   *     as well as from the ones we paint over.
   *   - Cover the marker up. It is drawn below the baseline, outside the
   *     glyph box the composer measures, so hiding it would mean guessing at
   *     an inflated box and masking a strip of whatever is behind the input —
   *     the same guess `background()` already documents as its weak point,
   *     made in a place where being wrong is visible on every line.
   *
   * So: the `spellcheck` attribute on the editable. It is inherited by every
   * descendant, so one write covers the whole message including text Slate
   * re-renders later, and it is a presentational hint the editor never reads.
   * Slate's model, its serialiser, and the message that actually gets sent are
   * all untouched — which is the same contract §9 holds itself to, and for the
   * same reason: nothing here may change what other people receive.
   *
   * This is the third and last place the script writes to Twitch's own DOM,
   * and it is held to the terms of the other two. One attribute. Written only
   * when it differs from what we want, so a pass over an already-correct
   * editable is free and our own write cannot start a loop. Re-asserted every
   * time rather than assumed to have held. Restored to whatever Twitch had
   * when the toggle goes back off — recorded per element in a WeakMap rather
   * than in a data attribute, because a marker of our own on their node is one
   * more write than this needs.
   *
   * React does not fight it. It writes DOM attributes by diffing this render's
   * props against the previous render's, not against the DOM, so a re-render
   * carrying an unchanged `spellCheck` prop leaves our value alone. A remount
   * is different — that element arrives new, with Twitch's value on it — and
   * catching it is what the attribute filter on the observer is for.
   * ════════════════════════════════════════════════════════════════════════ */

  const PREF_SPELLCHECK = 'ute:spellcheck-off';

  const Spellcheck = {
    observer: null,
    queued: false,
    // element → the value Twitch had before we first touched it. null records
    // "no attribute at all", which is not the same as "false" and restores
    // differently. A WeakMap so a torn-down editable is not kept alive by us.
    original: new WeakMap(),

    /**
     * True when suppression is active. The stored choice wins over CONFIG,
     * which is only the default for someone who has never touched the toggle —
     * so editing CONFIG later will not silently override a decision the user
     * has already made, and clearing the key restores CONFIG as the answer.
     */
    off() {
      const stored = gmGet(PREF_SPELLCHECK, null);
      return stored === null ? !!CONFIG.disableSpellcheck : !!stored;
    },

    set(off) {
      gmSet(PREF_SPELLCHECK, !!off);
      this.apply();
      // Both surfaces carry the state in their labels, so both are told.
      Menu.register();
      Picker.syncPanel();
      log('spellcheck', off ? 'suppressed in the chat box' : 'left to the browser');
    },

    toggle() { this.set(!this.off()); },

    /**
     * Every composer on the page, not just the main one. Twitch's reply-thread
     * tray mounts a second editable with the same hooks, and a reply is where
     * emote codes get typed as often as anywhere.
     */
    editors() {
      return Array.from(document.querySelectorAll(PSEL.input));
    },

    apply() {
      if (!isTwitch()) return;
      const off = this.off();
      for (const el of this.editors()) {
        // Recorded before the first write and never afterwards, so a pass that
        // runs while our own value is on the element cannot mistake it for
        // Twitch's.
        if (!this.original.has(el)) {
          this.original.set(el, el.hasAttribute('spellcheck') ? el.getAttribute('spellcheck') : null);
        }
        if (off) {
          if (el.getAttribute('spellcheck') !== 'false') el.setAttribute('spellcheck', 'false');
          continue;
        }
        const was = this.original.get(el);
        if (was === null) {
          if (el.hasAttribute('spellcheck')) el.removeAttribute('spellcheck');
        } else if (el.getAttribute('spellcheck') !== was) {
          el.setAttribute('spellcheck', was);
        }
      }
    },

    start() {
      if (!isTwitch() || this.observer) return;
      // Same host as the picker and the composer watch, and for the same
      // reason: .chat-input sees almost no churn, document.body sees every
      // incoming message.
      const host = document.querySelector('.chat-input') || document.body;
      if (!host) return;

      // childList catches Twitch mounting a new editable — a reply tray
      // opening, a remount after a re-render. The attribute filter catches the
      // narrower case of the value being written back on an element we already
      // hold. Our own writes come back through here too and settle on the next
      // pass, because apply() only writes when the value differs.
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(host, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['spellcheck'],
      });

      this.apply();
      log('spellcheck control attached;', this.off() ? 'suppressed' : 'left alone');
    },

    schedule() {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => { this.queued = false; this.apply(); });
    },

    /**
     * Nothing is restored here. A channel change tears the editable down and
     * builds another, so there is no attribute left to put back — and the
     * preference outlives the navigation by design. start() re-attaches to the
     * new chat shell on the next boot.
     */
    reset() {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
    },

    /**
     * Both toggles are labelled from here. The label states the browser's
     * behaviour ("Spellcheck: on") rather than the action, matching how the
     * manager menu's other entries carry their state; aria-pressed, the tooltip
     * and the accessible name supply the action, since "on" alone does not say
     * what clicking the control would do.
     */
    labelButton(b) {
      const off = this.off();
      b.textContent = `Spellcheck: ${off ? 'off' : 'on'}`;
      b.setAttribute('aria-pressed', off ? 'true' : 'false');
      const hint = off
        ? 'Spellcheck is off in the chat box. Click to turn it back on.'
        : 'Spellcheck is on in the chat box. Click to turn it off.';
      b.title = hint;
      b.setAttribute('aria-label', hint);
    },
  };


  /* ══════════════════════════════════════════════════════════════════════════
   * 11. MENU COMMANDS
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
        // Only where there is a chat box to act on. The other two entries are
        // useful on any page this script has found chat on; this one would be
        // a control that does nothing visible, which is the failure the panel
        // this menu replaced was retired for.
        if (isTwitch()) {
          this.ids.push(GM_registerMenuCommand(
            `Chat box spellcheck — currently ${Spellcheck.off() ? 'off' : 'on'}`,
            () => Spellcheck.toggle()));
        }
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
   * 12. BOOTSTRAP
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
    if (profile === 'twitch') { Picker.start(); Composer.start(); Spellcheck.start(); }

    const login = resolveChannel();
    if (!login) {
      warn('chat found but channel unknown — loading global emotes only. ' +
           'Set it from the userscript manager menu, or add a channelOverrides entry.');
    }
    await Store.load(login);
    // Kept even though adopt() normally does this. It is the path where adopt
    // correctly declines — a reload of the same channel with an unchanged
    // signature — that still needs it, because the root attached above is new
    // and has never been walked with a populated map.
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

  // Held so a channel change replaces this watcher rather than stacking a
  // second one over the same document, each with its own three-minute timer.
  let chatWatcher = null;
  let chatWatcherTimer = 0;

  function stopWatchingForChat() {
    if (chatWatcher) { chatWatcher.disconnect(); chatWatcher = null; }
    if (chatWatcherTimer) { clearTimeout(chatWatcherTimer); chatWatcherTimer = 0; }
  }

  function watchForChat() {
    stopWatchingForChat();
    scan();
    if (booted) return;
    const obs = new MutationObserver(() => {
      if (booted) { stopWatchingForChat(); return; }
      scan();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    chatWatcher = obs;
    // Hard stop so idle tabs don't keep an observer alive forever.
    chatWatcherTimer = setTimeout(stopWatchingForChat, 180000);
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
        Spellcheck.reset();
        // Before the new load starts, so anything still in flight for the
        // channel we are leaving can no longer adopt over the top of it.
        Store.invalidate();
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
