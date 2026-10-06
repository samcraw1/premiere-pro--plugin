# Research: Instagram + TikTok fetching

Date: 2026-10-05. Scope: how to add Instagram and TikTok to Media Finder
(paste-a-URL, maybe search). No code changed.

## TL;DR

- Reuse yt-dlp. It already powers `/search`, `/url-info`, `/download`. Instagram
  and TikTok are built-in extractors, so **paste-a-URL works with near-zero new
  code**: the same endpoints, URL validation relaxed from YouTube-only.
- **Search is not feasible** on either platform via yt-dlp (no keyword search
  extractor that works). Paste-a-URL only.
- Instagram needs a logged-in session (cookies). Expect flakiness.
- TikTok mostly works logged-out, but depends on browser impersonation
  (`curl_cffi`), which our local yt-dlp does not have.

## Local findings (this laptop)

- yt-dlp binary: `2026.08.19` (`media-finder-server/bin/yt-dlp`).
- `--list-impersonate-targets`: every target shows `curl_cffi (unavailable)`.
  `curl_cffi` is not installed for the binary.
- TikTok probe, public video (yt-dlp's own test URL, an old video):
  `--dump-json` succeeded with formats returned, even without `curl_cffi`.
  One sample only. Newer or region-limited videos may behave differently.
- Instagram probe, fake reel URL with `--cookies-from-browser chrome`:
  `Instagram sent an empty media response ... use --cookies-from-browser`.
  That is the expected failure for a bad ID. A real reel was **not** tested.
  Needs a real URL and a logged-in Chrome to confirm.

## yt-dlp extractor status

From yt-dlp `supportedsites.md`:

| Site | Works | Broken |
|---|---|---|
| Instagram | `instagram` (posts/reels), `instagram:story`, `instagram:tag` | `instagram:user` ("Currently broken") |
| TikTok | `TikTok` (single video), `tiktok:user`, `tiktok:collection`, `tiktok:live` | `tiktok:effect`, `tiktok:sound`, `tiktok:tag` |

Single-video URLs are the supported, stable path. Profile/tag/sound pages are
the fragile ones.

## Instagram

- Most content sits behind a login wall. Anonymous requests give "empty media
  response" or a login redirect.
- Auth options: `--cookies-from-browser chrome` (already used for YouTube in
  the server) or an exported `cookies.txt`.
- Known open yt-dlp issues (2026): empty media response even with valid
  `sessionid`/`ds_user_id` cookies (#17074), stories failing with cookies
  (#17707, #17770), age-restricted reels failing (#13551).
- Risk: automated use of a personal logged-in session can get the account
  rate-limited or flagged. Use a throwaway/secondary account for the cookies if
  this becomes routine. Personal-tool use at low volume is lower risk.
- Alternatives:
  - Instagram Graph API / oEmbed: only returns your own or business content,
    needs app review. Not a fit for arbitrary links.
  - Third-party scraping APIs (paid, e.g. Apify/RapidAPI actors): more stable
    than yt-dlp but cost money and send URLs to a third party. Not recommended
    for a personal tool.

## TikTok

- Single public videos usually work logged-out.
- yt-dlp's TikTok extractor requests pages with `impersonate=True`. Without an
  impersonation backend you can see `no impersonate target is available` then
  `Video not available, status code 0` (yt-dlp #15505, #17403; hits Android,
  ARM64, Homebrew, Docker).
- Fix: install `curl_cffi` where yt-dlp runs. yt-dlp 2026.08.19 documents a
  pinned extra: `curl-cffi==0.16.0`, `cffi==2.1.1`, `pycparser==3.0`.
- Our binary is the standalone `yt-dlp` downloaded by `setup:yt-dlp`. Standalone
  builds do not pick up pip packages, so impersonation means switching to a pip
  install (`pip install "yt-dlp[default,curl-cffi]"`) and pointing the server at
  that executable. Only do this if TikTok starts failing; the probe worked
  without it.
- Watermark: default formats may be watermarked. yt-dlp exposes a
  non-watermarked variant for many videos. Check `--list-formats` per video.
- Alternative: TikTok's official Display/Research APIs are for approved apps and
  own-account data. Not a fit.

## Integration plan (for Sam to implement)

Touch points in the current code:

1. `media-finder-server/src/index.ts`
   - `/url-info` already accepts any valid URL and calls yt-dlp, so
     Instagram/TikTok links go through as-is. Check the returned
     `webpage_url`, `thumbnail`, `duration` (may be null on some posts).
   - `/thumbnail` only allows `*ytimg.com`. Instagram (`cdninstagram.com`,
     `fbcdn.net`) and TikTok (`tiktokcdn*.com`) thumbs need their hosts added,
     with an exact-or-subdomain match, not `endsWith("ytimg.com")`.
   - `--cookies-from-browser chrome` is hardcoded on all three endpoints.
     Make it configurable (env var) since Instagram needs it and others may not.
   - `/download` format string pins `avc1` + `m4a` (YouTube-specific). Instagram
     and TikTok are usually already H.264 mp4, but verify the fallback
     (`best`) picks something Premiere can read. The existing ffmpeg convert
     step covers non-mp4.
2. `Test-rh92b4/src/components/App.jsx` (UXP panel)
   - `toJpgThumbnail` rewrites YouTube `vi_webp` URLs only. Other hosts pass
     through. Confirm UXP can render the proxied images.
   - Placeholder text and error copy say "YouTube". Update to "video URL".
3. `Test-rh92b4/plugin/manifest.json`: network permission is `localhost:3000`
   only. No change needed since the server fetches, not the panel.
4. Optional: tag each result with its source (YouTube/Instagram/TikTok) from
   `extractor_key` in the yt-dlp JSON, for the row UI.

## Security notes (matter more with new sources)

- `/download` passes `video.url` to yt-dlp unvalidated (option injection, e.g.
  `--exec`). Validate with `new URL()`, require `http(s)`, add `--` before the
  URL. Adding more sites makes a permissive allow-list tempting; use an
  explicit hostname allow-list (`youtube.com`, `youtu.be`, `instagram.com`,
  `tiktok.com`, `vm.tiktok.com`) instead.
- Server binds all interfaces with open CORS and uses browser cookies. Bind to
  `127.0.0.1`. Instagram cookies make this more sensitive.

## Legal / ToS

Downloading from Instagram or TikTok violates their terms of service, and
the content is copyrighted. Fine for a personal tool on content you have rights
to or are permitted to use. Do not ship it publicly or in the Pixel production
plugin without rights clearance.

## TikTok: built (branch `tiktok-support`, 2026-10-06)

Paste-a-link works for TikTok. Search is still not possible.

What the probe showed (yt-dlp 2026.08.19, no `curl_cffi`, no login):
- Two public videos returned full metadata and formats. No impersonation error,
  so no pip/`curl_cffi` switch was needed. A third (`@nike/.../7552898105033755918`)
  failed with "Your IP address is blocked from accessing this post", which is
  per-post, not a general failure.
- Thumbnails are plain **JPEG** from `*.tiktokcdn-us.com` (signed, with an
  `x-expires` timestamp, so thumbnails saved in Recent may stop loading later).
- Formats: `h264_540p_*` (576x1024), `bytevc1_*` (H.265, up to 720p), sometimes a
  `download` format marked `watermarked`. The H.264 codec is labelled `h264`,
  **not** `avc1`.
- `uploader_id` is a long number; the readable handle is in `uploader`.

What changed:
- **Hardening (all sites):** `validateVideoUrl()` in `media-finder-server/src/index.ts`
  allows only http(s) on `youtube.com`, `youtu.be`, `x.com`, `twitter.com`,
  `t.co`, `tiktok.com` (exact host or subdomain). `/download`, `/url-info` and
  `/preview` return 400 for anything else. All yt-dlp calls now put `--` before
  the URL. Tested: `file://`, `javascript:`, `evil.com`, `--exec id`,
  `eviltiktok.com`, `tiktok.com.evil.com` are all rejected.
- **Local-only server:** listens on `127.0.0.1` and `::1` (both, because
  `localhost` resolves to `::1` on this Mac). The LAN address no longer reaches
  it. Own commit, easy to revert. Not tested from the Premiere panel.
- **Thumbnails:** `/thumbnail` allows `tiktokcdn-us.com` and `tiktokcdn.com`
  (the second is not seen in the probe; remove it if you want only confirmed hosts).
- **Formats:** `/download` and `/preview` selectors gained a TikTok branch:
  `b[vcodec^=h264][format_note!=?watermarked]` (`!=?` is needed because the
  field is missing on most formats). YouTube picks are unchanged (still 1080p
  `avc1` for downloads, itag 18 for previews). The `/preview` chain also has
  `b[height<=480]/w[vcodec^=h264]` before `best`.
- **Panel:** `detectSource` returns `"tiktok"` for `tiktok.com` and subdomains;
  rows get a `TT` badge, a pink left edge, and a `@uploader – first 60 chars`
  title; placeholder reads "YouTube, X or TikTok".

Tested from the command line (not in Premiere): `/url-info`, `/thumbnail`,
`/preview` (10 s, H.264 + AAC, 576x1024) and the exact `/download` arguments
(H.264 + AAC mp4) on a public TikTok; YouTube `/url-info`, `/preview`, format
selection and thumbnail still work. **Not tested:** the panel inside Premiere,
a real X link, the `/download` route itself on TikTok (the arguments were run
directly into a scratch folder), and TikTok videos from other regions.

## Instagram: hand-off for Sam

Not started. The shared pieces are done, so what is left is Instagram-specific:

1. **Allow-list:** add `instagram.com` to `ALLOWED_VIDEO_HOSTS` in
   `media-finder-server/src/index.ts` (`cdninstagram.com` and `fbcdn.net` are
   image hosts, not video URLs).
2. **Thumbnail hosts:** add `cdninstagram.com` and `fbcdn.net` to
   `allowedImageHosts` in `/thumbnail`. Check what the real reel returns first
   (format, expiry).
3. **Cookies:** Instagram needs a logged-in session. The server hardcodes
   `--cookies-from-browser chrome` in four places; make the browser an env var
   (e.g. `COOKIES_BROWSER` in `.env`) if you want it configurable.
4. **Panel:** add `"instagram"` to `detectSource` and a `SOURCE_LABELS` entry in
   `Test-rh92b4/src/components/App.jsx` (text `IG`), plus `--ig` colour, `.row--ig`
   and `.badge--ig` in the CSS. Title: probably `@uploader – caption`; check
   which field holds the handle (TikTok used `uploader`, not `uploader_id`).
5. **Test with a real reel** while logged in to Instagram in Chrome:
   `./bin/yt-dlp --dump-json --cookies-from-browser chrome -- <url>`; then the
   four routes. Expect flakiness (see the known yt-dlp issues above) and risk to
   the logged-in account if you hammer it.
6. **Format check:** run `-s --print "%(format_id)s | %(vcodec)s"` with the
   selectors from `/download` and `/preview` to confirm they pick H.264.

## Suggested order

1. Test a real public TikTok URL and a real Instagram reel (with Chrome logged
   in) via `./bin/yt-dlp --dump-json <url>` to confirm both work today.
2. Fix URL validation + host allow-list in `/download` and `/url-info`.
3. Extend `/thumbnail` host check.
4. Make cookies browser configurable.
5. Update panel copy. Add `curl_cffi` only if TikTok fails.

## Sources

- yt-dlp supported sites: https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/supportedsites.md
- Instagram issues: https://github.com/yt-dlp/yt-dlp/issues/13551, /17074, /17707, /17770
- TikTok impersonation issues: https://github.com/yt-dlp/yt-dlp/issues/15505, /17403, /17500
- Cookie guidance: https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
