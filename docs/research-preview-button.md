# Research: Preview button after search

Date: 2026-10-05. Scope: how to let the user watch a video from a search
result (or pasted URL) before importing it, from inside the Premiere UXP
panel (`Test-rh92b4/`). No code changed.

## TL;DR

- Recommended: a **Preview button on each row** that plays a **short, low-res
  clip** (first ~10-15 s) in a `<video>` element in the panel. The local server
  makes the clip with yt-dlp and serves it from `localhost:3000`, which the
  manifest already allows. Works the same for YouTube and X.
- Fallback / cheap first version: a **"Watch" button that opens the video in the
  default browser** with `shell.openExternal` (one manifest permission).
- Not recommended: an embedded YouTube player in a `<webview>` (embed
  restrictions, ads, wildcard-domain permissions, popups blocked).
- **Not verified:** whether Premiere 26.5's `<video>` element actually plays an
  H.264/AAC mp4 from `http://localhost`. Adobe docs do not say. That is the
  one thing to test first (see "First test" below).

## What the panel can do (from Adobe docs)

| Capability | Status | Notes |
|---|---|---|
| `<video>` element | Supported since UXP v7.0.0 | Default `preload` is `"metadata"`. Events: `loadeddata`, `ended`, `pause`, `seek`, `timeupdate`. `poster` attribute is macOS-only. Codec/container support is **not documented**. |
| `<webview>` | Supported since UXP v6.4 | Loads remote https if the domain is listed in the manifest. No new windows/popups. No wildcards at the top-level domain. Needs the `webview` permission (`domains`, `enableMessageBridge`, ...). |
| `shell.openExternal(url)` | Works in current Premiere | Needs the `launchProcess` permission in the manifest. Opens the default browser. |
| `SourceMonitor.openProjectItem(item)` | Since 25.6 | Opens a project item in Premiere's own Source Monitor. Only for items already imported. `setPosition` exists since 26.3. |

Sources:
- [UXP WebView element](https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-js/global-members/html-elements/html-web-view-element)
- [UXP changelog (Premiere)](https://developer.adobe.com/premiere-pro/uxp/uxp-api/changelog3-p)
- [Opening external websites from a UXP panel](https://forums.creativeclouddeveloper.com/t/opening-external-websites-from-uxp-panel/11448)
- [SourceMonitor class](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sourcemonitor)

## Options compared

| # | Option | New permissions | Server work | Works for X | Main risk |
|---|---|---|---|---|---|
| A | Open in default browser (`shell.openExternal`) | `launchProcess` (https) | none | yes | Leaves the panel; not an in-panel preview |
| B | `<webview>` with the YouTube embed URL | `webview` + youtube domains | none | no (different embed) | Embed blocked on some videos, ads, popup/link limits |
| C | `<video src>` = direct stream URL from `yt-dlp -g` | `network` for `https://*.googlevideo.com` | one tiny endpoint | yes (twimg) | URLs expire and are IP/session-bound; rotating hostnames; full-length streaming |
| **D** | **`<video src>` = short clip made by the server** | **none** (localhost already allowed) | **one endpoint + temp cache** | **yes** | **Needs the `<video>` codec test; ~7 s wait for first preview** |
| E | Import first, then `SourceMonitor.openProjectItem` | none | none | yes | Defeats the point: you have to download and import before previewing |

Why D: no new permissions, same code path for YouTube and X, small files, and
the user can scrub a real clip. A is the safety net if `<video>` turns out not
to play mp4 in the panel.

## Local findings (this laptop)

Tested with `bin/yt-dlp` 2026.08.19 and Chrome cookies, on a public video.

- **Direct stream URL** (`-f "18/b[height<=360][vcodec^=avc1]" -g`): returned a
  `googlevideo.com` URL in about **6.4 s**. The hostname is a rotating
  `rr6---sn-....googlevideo.com`, and the URL has an `expire=` timestamp.
- **10-second clip** (`-f "b[height<=360][vcodec^=avc1]/18" --download-sections
  "*0-10" --force-keyframes-at-cuts`, using the bundled ffmpeg): produced a
  **~690 KB mp4 in about 7.3 s**, H.264 video + AAC audio.
- Both used the same cookie flag the server already passes, so the bot check
  was not a problem.

So the first preview of a video costs roughly 7 seconds; a cached repeat is
instant.

## Proposed design (option D)

**UI** (`Test-rh92b4/src/components/App.jsx`, `App.css`)
- Add a small **Preview** button on each result row (left of Import). Recent
  rows can have it too.
- Clicking it expands the row **inline** (or opens the existing preview card)
  with a `<video controls>` and a Close button. While the clip is being made,
  show the same loading bar/gif pattern as search ("Making preview...").
- One preview open at a time; closing it pauses and unloads the video.

**Server** (`media-finder-server/src/index.ts`)
- `POST /preview` with `{ url, id }`: runs yt-dlp with the clip command above
  into a temp folder (e.g. `os.tmpdir()/media-finder-previews/<id>.mp4`), returns
  `{ previewUrl: "http://localhost:3000/previews/<id>.mp4" }`. If the file
  already exists, return it immediately.
- `express.static` for that folder, so `<video src>` can load it.
- Clean up: delete previews older than ~1 day at startup; cap total size.
- Clip length is a constant (10-15 s). Choose 360p so files stay small.
- For X, the same command works (yt-dlp's Twitter extractor); format
  selection falls back to `best`.

**Manifest** (`Test-rh92b4/plugin/manifest.json`)
- No change for option D (`http://localhost:3000` is already allowed).
- Option A would add `"launchProcess": { "schemes": ["https"], "extensions": [] }`.

## First test (before building anything)

Before writing the full feature, check the one unknown:

1. Copy a ~10 s clip to `media-finder-server/previews/test.mp4`.
2. In the panel, temporarily render `<video controls src="http://localhost:3000/previews/test.mp4" />`.
3. Reload the plugin in UDT and see whether it plays with audio.

If it plays: build D. If it shows a blank or errors: fall back to A (browser)
and maybe try a re-encode (baseline H.264 + AAC) before giving up.

## Risks and open questions

- `<video>` codec support in Premiere 26.5 is undocumented. Test above.
- First preview takes ~7 s. Could be reduced by pre-fetching the first result's
  clip, but that costs bandwidth and cookie-gated requests; skip for v1.
- YouTube bot checks can still hit these requests; they use the same cookies as
  the other endpoints.
- Disk: previews are small (~0.7 MB per 10 s), but need cleanup.
- Private/age-restricted/login-only videos may fail; show the existing
  `{code, message}` error banner.
- Preview clip shows the start of the video only. A "preview from the middle"
  option would need `--download-sections "*60-70"` and a UI control; out of
  scope for v1.
- If previews are made for X posts that are only a few seconds long, the clip
  is just the whole video.

## Suggested next steps

1. Run the "First test" above (5 minutes) to confirm `<video>` plays mp4.
2. If yes, build `/preview` + the Preview button; if no, ship option A.
3. Add the Preview button to Recent rows once it works for Results.
