# Universal Twitch Extension Emotes (BTTV / FFZ / 7TV)

**A lightweight alternative to the BetterTTV, FrankerFaceZ and 7TV browser
extensions** — the emotes, without the rest of the product. One file, no
extension to install, no background process, no account.

It renders all three providers' emotes in chat, adds the channel's third-party
emotes to Twitch's own emote picker, and draws them in the chat box as you type,
which is what most people install those extensions for in the first place.

And because it finds chat by behaviour rather than by domain, it keeps working
**anywhere chat is actually rendered** — embedded chat on someone else's site,
popout chat, multi-stream layouts, OBS browser sources, KapChat overlays and
custom tmi.js widgets — which is a bonus falling out of the same design.

## What it does

For each chat log it finds, the script works out which channel is being
watched, fetches that channel's emote sets plus the three global sets, and
swaps matching words in incoming messages for images:

- **7TV** — global set and the channel's active emote set, WebP, animated
  included.
- **BetterTTV** — global emotes plus the channel's own and shared emotes.
- **FrankerFaceZ** — global sets and the channel's room sets, preferring the
  animated variant where one exists.

This covers every place Twitch renders chat text, not only the message list —
pinned messages, hype chat and other community highlights sit in a separate
stack above it, and are matched by the same
`data-a-target="chat-message-text"` hook every Twitch message form uses.
Hovering a rendered emote shows a small card with its name and provider — the
same card the chat box and the emote picker use.

Channel emotes win over global emotes when a code collides, matching what the
real extensions do. **Zero-width emotes stack** rather than sitting side by
side: 7TV's `ZeroWidth` flag, FFZ's `modifier` emotes and BetterTTV's overlay
set are drawn centred on top of the emote they follow, and the space that
separated them is swallowed so the line doesn't gain a visible gap. Every image
keeps its code as `alt` text, so selecting and copying a message still gives
you the words.

Nothing is sent anywhere. The script reads three public emote APIs, and it
never asks for Twitch credentials.

## Why a userscript

The three extensions are full products: emotes, badges, paints, personal
emotes, cosmetics, settings panes, chat tooling. Plenty of people install one
for a single part of that — seeing the emotes everyone else is using — and take
the rest as freight.

This is that one part, in a single file of about 2,000 commented lines you can
read end to end before deciding to trust it. There's no bundle to unpack, no
build step, no background service worker sitting in your browser between
sessions, and no permissions beyond whatever your userscript manager already
holds. Turn it off in the manager and the page is exactly as Twitch shipped it.

What you give up is real and worth knowing before switching. Badges, paints,
personal emotes, cosmetics, settings UI, tab-completion and every other feature
those extensions carry are all out of scope here — see
[Known limits](#known-limits) for the full list. If you want them, install the
extension; the two can also coexist, with `blocklist` keeping this script off
`twitch.tv` and letting it cover only the places the extension doesn't reach.

It also isn't a substitute for supporting the projects themselves. Every emote
it draws comes from BetterTTV's, FrankerFaceZ's and 7TV's own public APIs, and
it works only for as long as they keep them open.

## Where it works

### Embedded chat is still a Twitch page

Most Twitch emote userscripts match `*://*.twitch.tv/*` and set `@noframes` — a
sensible-looking default that quietly removes the single most common case.

When a site embeds chat, it does it like this:

```html
<iframe src="https://embed.twitch.tv/?channel=xyz&parent=example.com"></iframe>
```

That iframe's document **is** a `twitch.tv` document, and the chat inside it is
the ordinary Twitch chat DOM. The reason a script doesn't reach it is never the
hostname match — it's `@noframes` stopping the script at the frame boundary.

So this script deliberately does **not** declare `@noframes`, and instead
rejects frames smaller than 120×120 px so ad and tracking iframes cost nothing.
That single omission covers embeds, popout chat, `/moderator` view, multi-stream
sites and dashboard layouts without a line of site-specific code.

A warning if you fork this: `@noframes` takes **no value**. Writing
`@noframes false` doesn't disable it — the directive's mere presence switches it
on, and every embed silently stops working.

### Chat that Twitch never rendered

The other half is chat rendered by something else entirely: KapChat,
StreamElements overlays, OBS browser sources, and custom clients speaking
Twitch IRC over a websocket. There's no hostname to match and no stable class
name to select, because everything is minified and different on every site.

Matching `[class*="chat"]` is the obvious approach and a bad one — it fires on
static markup, help pages and marketing copy across half the web.

Instead the script watches for the **shape** of a chat log. A chat line, on
Twitch and on every IRC-style renderer, looks like `name: message` — a short
name, a colon, then text. A list of articles, comments or notifications grows
over time in exactly the same way but never takes that shape, which is what
separates the two.

Two such lines appended into the same parent promotes it to a chat root and the
detector shuts down. A far higher plain-text threshold acts as a fallback, for
renderers that draw the separator in CSS so it never reaches the text — losing
real chat is a worse failure than a harmless false match. The class-name fast
path also now requires a chat-shaped child, so a container merely *named* like
chat isn't enough.

Known layouts — Twitch, KapChat, StreamElements, Streamlabs — skip this
entirely and use a selector profile, so the heuristic only ever runs on
genuinely unknown sites.

## Working out which channel

Channel emotes need a channel name, and then a numeric Twitch user ID. The
script tries, in order:

1. A `channelOverrides` entry for the host, then any channel you've set by hand
   from the picker's status row or your userscript manager's menu.
2. The URL — `/popout/<ch>/chat`, `/embed/<ch>/chat`, `/moderator/<ch>`, a bare
   `/<ch>` that isn't a reserved Twitch path, or the `?channel=` parameter that
   nearly every embed and overlay widget takes.
3. On `twitch.tv` only, a walk up React's fiber tree from the chat input looking
   for a `channelLogin` prop.
4. `data-channel` / `data-room` attributes, then the parent frame's URL.

Turning that login into a user ID normally means a Twitch API client ID. It
doesn't have to: FrankerFaceZ's room endpoint returns the channel's `twitch_id`
**and** its FFZ emote sets in one response, so the lookup you need anyway also
answers the ID question. `api.ivr.fi` and `decapi.me` are fallbacks if FFZ has
no room entry.

If nothing resolves, the script still loads the three global sets and says so:
the picker's status row reads *channel not detected*, and its **Set channel**
button takes the name by hand, remembered for that page. Off Twitch, where
there is no picker, the same control sits in your userscript manager's menu —
which also shows the current channel and emote count in its labels.

## Sections in the emote picker

On `twitch.tv`, the channel's 7TV, BetterTTV and FrankerFaceZ emotes are added
to Twitch's emote menu as three further sections, placed directly below the
channel's own native emotes so Twitch's keep top billing. Clicking one appends
its code to the end of the message, with a space before it unless the box is
empty or already ends in one, and a space after. Hovering shows the same card
the chat box uses, below the emote as Twitch places its own. The picker's
search box filters these sections alongside Twitch's, and each provider gets a
tab on the right-hand nav rail.

The rail's selected-tab highlight is left entirely to Twitch. Our tabs scroll
to their section and claim nothing, because our sections sit inside the channel
section's scroll range — so Twitch's own scroll spy keeps the channel tab lit
while they're in view, which is both correct and free. Moving that highlight
onto our tabs meant writing to state React owns and we can't read, and every
version of that synchronisation drifted into an invalid state after enough
clicks. The tabs sit directly beneath the channel's own and carry a provider
tag, so the grouping already says what they are.

Each tab reuses the channel's own icon with the provider tagged in the corner,
so they read as siblings of Twitch's tabs rather than foreign objects, and they
sit directly below the channel's tab to match the section order. The rail is a
separate React subtree from the sections list and re-renders on its own, so the
tabs are re-asserted on every pass rather than only when the sections are built.

A slim status row above the sections shows how many emotes each provider
contributed and which channel they came from, with buttons to set the channel by
hand or force a reload. That lives here rather than floating over the chat UI,
where it had nowhere to sit without covering Twitch's own controls.

**Nothing hardcodes a class name.** Twitch's picker is styled-components
output, so every visual class is a build hash — `bVKCgo`, `eXryG`, `AoXTY` —
that changes on each deploy. Only the BEM-ish names survive, because Twitch's
own tooling keys on them: `.emote-picker`, `.emote-grid`,
`.emote-grid-section__header-title`, `.emote-button`, `.emote-picker__image`.
So the script locates a live native section and a live native emote cell,
deep-clones them as templates, and swaps in its own title and images. Whatever
classes Twitch ships today come along for free, and a restyle can't break the
layout. If the templates can't be found at all, the picker is left exactly as
it was.

Cloning is also what keeps React out of it. `cloneNode` copies attributes but
not expando properties, so a cloned cell carries no React fiber — React can't
see these buttons and never tries to reconcile them.

## Emotes in the chat box

Type a 7TV, BetterTTV or FrankerFaceZ code and it becomes the emote right there
in the input, the way BetterTTV does it. Before you type the space that commits
it, a small card above the box shows the emote, its name and which provider it
came from, so you can see what you're about to send.

Twitch already does this for its own emotes when you're logged in — that's what
the rich input is for. It simply has no idea what a 7TV code is. This fills in
that gap and stays out of the way of the rest: anything Twitch is already
drawing is left exactly as Twitch drew it.

### What gets sent is what you typed

The script never edits the contents of the input. It measures where each code
sits and paints the emote on top, in a separate layer the editor can't see, so
your message text is untouched from the first keystroke to the moment you press
enter.

Inserting from the picker is the one place text is added, and it goes through
the same `beforeinput` event a keystroke would, letting the editor apply it to
its own model. If the editor declines, nothing is written: characters placed in
the box behind its back look right but aren't really there — the placeholder
stays up, backspace deletes from a model that never had them, and the next
keystroke wipes the lot.

That's a deliberate constraint rather than a shortcut. Twitch's input keeps its
own internal document model, and the tidier-looking approaches — dropping an
image into it, or inserting an emote through that model — both risk the message
going out wrong. An element Twitch's own code doesn't recognise gets dropped
when the message sends, so you would see the emote, press enter, and the word
would silently vanish from what everyone else receives. A misaligned picture is
a far better failure than a corrupted message.

One visible consequence: each emote is drawn at the width of the code it
covers, so a long code leaves a little space either side. That's what keeps the
text underneath in its original position, so nothing reflows and the caret
never jumps while you type.

### What stays as text

Four cases are left as plain text deliberately, so they aren't bugs:

- **The code your caret is inside.** It stays editable while you're still
  typing it, and the preview card shows the emote instead.
- **A code that wraps across two lines.** It occupies two separate boxes, and
  guessing between them would put the picture in the wrong place.
- **Anything typed with an IME.** The overlay steps aside during composition and
  returns when you're done.
- **A channel's Twitch subscriber emotes, if you're not subscribed.** Those send
  as the literal word, so they're shown as one rather than promising an emote
  nobody will receive — unless a third-party emote happens to share the name,
  which is then what viewers actually see, so that is what's drawn.

## Two constraints it works around

**Content-Security-Policy.** `twitch.tv` ships a `connect-src` policy that
blocks plain `fetch()` to `betterttv.net`, so all API calls go through
`GM_xmlhttpRequest`, which isn't subject to page CSP or CORS. Emote images are a
separate problem: a handful of sites restrict `img-src` too. Rather than
pre-downloading everything everywhere, each `<img>` gets a one-shot `error`
handler that re-fetches that emote through the userscript bridge as a blob —
free on the sites where direct loading works, self-repairing on the ones where
it doesn't.

**React's DOM ownership.** Twitch chat is React, and scripts that rewrite a chat
line's `innerHTML` produce `NotFoundError: failed to remove child` when React
later unmounts the line it no longer recognises. In chat messages this script
only ever replaces **text nodes**, never an element React tracks. When React
unmounts a chat line it removes the parent element, so it never reaches for a
child that was swapped out.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw script — your manager will offer to install it:
   **https://raw.githubusercontent.com/Qnoses/Universal-Twitch-Extension-Emotes/main/universal-twitch-extension-emotes.user.js**

The script needs to run in frames, which managers allow by default. If you've
turned that off globally, embedded chat won't work — it's the one setting that
matters here.

## Configuration

A single `CONFIG` object at the top of the script, safe to edit with no other
changes.

**Emotes**

- `size` (default `'2x'`) — emote scale requested from each CDN, `1x`–`4x`.
  BetterTTV only serves up to `3x` and clamps automatically.
- `maxHeight` (default `28`) — rendered cap in CSS pixels, matching Twitch's own
  emote height.
- `providers` (default all `true`) — `sevenTV`, `bttv`, `ffz`. Switching one off
  skips its network calls entirely.
- `hoverCard` (default `true`) — show a small card naming the emote and its
  provider when you hover one, in chat and in the emote picker. `false` falls
  back to a plain browser tooltip.
- `priority` — the order codes overwrite each other. Later entries win, so the
  default puts channel sets above globals.
- `cacheTTL` (default 30 minutes) — how long emote lists are reused before a
  refetch. Cached lists render instantly; a background refresh only runs once
  the cache is past half this age, and is skipped entirely if the set turns out
  to be unchanged.

**Where it runs**

- `genericDetection` (default `true`) — the structural detector for unknown
  sites. Set `false` to restrict the script to Twitch-served documents, which
  still includes every embed and popout.
- `channelOverrides` (default `{}`) — a host-to-channel map for sites where the
  channel can't be inferred, e.g. `'chat.example.com': 'forsen'`.
- `blocklist` — hosts to leave alone. **If you already run the 7TV, BTTV, or FFZ
  browser extension**, add `'www.twitch.tv'` here and let this script handle
  only the places the extension can't reach.

**Twitch UI extensions** (all `twitch.tv` only)

- `pickerSections` (default `true`) — add the provider sections to Twitch's
  emote picker.
- `pickerIncludeGlobals` (default `false`) — also list the three global sets
  there, not just the channel's. Off by default because global sets run to
  hundreds of emotes and bury the channel's own.
- `pickerNavIcons` (default `true`) — add a per-provider tab to the picker's
  right-hand nav rail.
- `pickerPanel` (default `true`) — the status row above those sections.
- `composerPreview` (default `true`) — draw emotes over their codes in the chat
  box while typing.
- `composerBubble` (default `true`) — show the preview card above the input for
  the code under the caret.

**Diagnostics**

- `debug` (default `false`) — logs detection, channel resolution and emote
  counts to the console, which is the fastest way to see which of the two
  failed.

The two controls that have to work everywhere — **Set channel** and **Reload
emotes** — are registered in your userscript manager's menu, with the current
channel and emote count in their labels. There is no floating panel on the
page: the structural detector is deliberately generous about what counts as
chat, so anything drawn on detection would turn up on ordinary sites too.

## Scope & behavior

- Runs on all sites at `document-idle`, in frames as well as top-level
  documents. Draws no UI of its own outside chat: its controls live in the
  userscript manager's menu, and on `twitch.tv` in the emote picker.
- Does nothing until a chat log is identified; on a page without one it disarms
  its observers and goes quiet.
- Network access is read-only, to the three emote APIs and at most two ID
  resolvers. No Twitch credentials, no account access, nothing is sent
  anywhere.
- Stores only cached emote lists and any channel names you set by hand, in
  userscript storage.
- In chat messages, replaces text nodes inside message elements. Chat inputs,
  links and `contenteditable` regions are never touched.
- In the chat box, paints into a separate overlay only. Nothing inside the
  input's editable region is ever added, removed or rewritten, so sent messages
  are unaffected by this script.
- Its own overlays, cards and panels are excluded from chat processing, so the
  script never renders into its own output.
- In the picker, inserts cloned sections below the channel's native emotes and
  writes to nothing of Twitch's — not a class, not an attribute. Sections are
  re-added if a re-render drops them, cleared first so they can't accumulate,
  and repositioned if Twitch mounts a section late.
- Emote codes are matched as whole space-delimited tokens, so a code appearing
  inside a longer word is left alone.
- Toggle it off in your manager to fully revert.

## How it stays efficient

Being the light option is a claim worth backing, so concretely: on a page with
no chat the script patches two history methods, attaches two observers, finds
nothing, disconnects them both within three minutes, and does nothing else for
the lifetime of the tab. On a chat page it holds one observer on the chat root
and one cached emote list, plus — on `twitch.tv` only — three more watching the
emote picker and the chat input. With a warm cache it makes no network requests
at all.

Matching every site is only affordable if the cost on a site without chat is
near zero, so detection is bounded three ways: the structural detector gives up
after two minutes, the top-level watcher disconnects after three, and both stop
immediately once a chat root is found.

After that, one `MutationObserver` per chat root batches added nodes into a
single `requestAnimationFrame` callback, which matters when chat bursts fifty
messages at once. Processed messages are marked so re-renders and virtualised
scrolling don't cause repeat work, and a `TreeWalker` skips whole subtrees —
links, inputs, already-rendered emotes — rather than testing every node.

A popular channel can carry several hundred third-party emotes, so the paths
that scale with emote count are bounded too:

- Picker sections build their first 150 cells synchronously and the rest during
  idle time, so opening the picker never blocks on a 600-emote channel. Cells
  that arrive late still respect a search that's already active.
- The composer paints from the emote map the script already loads at boot, so it
  works from the first keystroke, with no warm-up.
- A warm cache is left alone. The background refresh only fires once the cached
  set is past half its TTL, so an ordinary page view costs zero API calls rather
  than six.
- Refreshes are compared by signature — an FNV-1a hash over code/URL pairs — so
  a refresh that finds nothing new does no work at all: no re-ingest, no picker
  rebuild, no composer repaint.

## Known limits

- Emote **codes** only. Badges, paints and other cosmetics are out of scope, as
  are personal emotes.
- Typing still relies on memory. The script doesn't extend Twitch's
  tab-completion or its autocomplete popup, both of which read from React state
  it has no access to.
- The chat-box preview is a painted overlay, not real inline rendering, so an
  emote occupies the width of its code rather than reflowing the line. A code
  that wraps across two lines stays as text.
- The 7TV EventAPI isn't wired up, so an emote added to a channel mid-stream
  appears after the cache refreshes rather than instantly. **Reload emotes**,
  in the picker or the manager menu, forces it.
- BetterTTV publishes no zero-width flag, so its overlay emotes are recognised
  from a static list of codes; a new one added by BetterTTV renders inline until
  the list is updated.
- The structural detector is still a heuristic. A page that repeatedly appends
  `something: something` lines could be mistaken for chat — harmless, since
  nothing matches an emote code, but `blocklist` or `genericDetection: false`
  will stop it.
- SPA navigation is caught by patching `pushState`/`replaceState`; a site that
  navigates some other way may need a reload to pick up the new channel.

## License

MIT — see [LICENSE.md](LICENSE.md).
