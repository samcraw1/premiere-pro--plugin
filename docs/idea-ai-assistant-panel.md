# Idea: chat panel for Media Finder (find, download, import outside media)

Date: 2026-10-05. Status: idea + notes, nothing built. Updated after comparing
options and checking what Adobe already ships.

Source: Sam's notes from an earlier chat plus web checks on 2026-10-05. Claims
are **not re-verified here** unless marked "(checked)" or "(checked in this
repo)". Confirm dates, pricing and policy before relying on them.

## Decision (current)

Build **option B: our own chat panel on the Claude API**, scoped to what Adobe's
tools do not do: **find, preview, download and import outside media**. Do not
rebuild what Adobe ships (project organizing, edits, video/sound generation).

## What Adobe already ships (so we skip it)

- **AI Assistant** (checked): public beta in Premiere since 2026-06-18, free in
  the beta per a reviewer. Works inside the project: makes bins and sorts clips by
  content, mutes audio, sets opacity, tries to build timelines. Slow on big
  tasks. Does not bring in outside media (YouTube, X, TikTok, stock). Whether it
  can create masks is **unverified**. Credit usage is unknown.
- **Generative Media tool** (checked via search summary; the Adobe page itself
  returned 403): generates **video** (Firefly, Google Veo, Kling, Luma) and
  **sound effects** (Adobe model) on the timeline, with reference frames from
  your sequence. No mention of still images, and no API or extensibility found.
  Requirements, credits, limits and licensing not retrieved. See the
  [FAQ](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-media-tool-faq.html).
- Not covered by Adobe (as far as found): importing from YouTube/X/TikTok/
  Instagram, web image search, still-image generation (unconfirmed).

## Options compared

| | A. Webview (claude.ai / chatgpt.com) | B. Own panel + Claude API | C. Adobe AI Assistant | D. YouTube/X webview |
|---|---|---|---|---|
| Works today | Unverified | Yes | Yes (beta only) | Unverified |
| Build effort | Lowest | Medium | None | Low if URL readable |
| Cost | Existing plan | Pay per use | Free in beta (credits unknown) | Free |
| Sees project | No | Yes, via tools | Yes, deeply | No |
| Imports outside media | No | Yes, via our endpoints | No | Only if panel can read the URL |
| Main risk | Login popups blocked | API cost, key safety | Beta, not extensible | Cannot read URL, popups, ads |

- **A** is only a chat window; no project access, no import. Worth a 30-minute
  test if a free general chat is wanted.
- **C** already covers organizing and basic edits. Use it, don't rebuild it.
- **D** is a browser for discovery. Only useful if the panel can read the
  webview's current URL (unverified); otherwise search + paste already covers it.
- **B** is the only one that does hands-free "find it, import it".

Also noted in the earlier notes: "Sign in with ChatGPT" (own panel billed to a
ChatGPT plan, OpenAI models only, no image generation). Availability for a
personal app is unconfirmed. Claude has no equivalent subscription route for
third-party apps found; use API auth.

## Option B scope

Tools the chat would call (all on the local server, key stays server-side):

| Tool | Does | Reuses |
|---|---|---|
| `search_videos(query)` | yt-dlp search | existing `/search` |
| `get_url_info(url)` | metadata for YouTube/X (TikTok/Instagram later) | existing `/url-info` |
| `preview(url)` | 10 s clip | existing `/preview` |
| `download_and_import(url, bin)` | download, then `Project.importFiles()` | existing `/download`, bin picker |
| `search_images(query)` | stock/web image search | new |
| `generate_image(prompt)` | image generation API | new, **later** |

Example: "find a yellow tiger image and import it into B-roll" means
`search_images`, pick or show thumbnails, then import. "Find or generate" means
Claude picks `search_images` first and `generate_image` when nothing fits.

Out of scope for B: project organizing, edits, masks, video or sound-effect
generation (Adobe covers these; masks would need an API we have not confirmed).

## Image sources

- "Google Images" via Google's Custom Search JSON API: reported closed to new
  customers, with existing customers required to migrate by **2027-01-01**
  (unverified). Do not build on it. Scraping Google Images breaks terms and
  breaks often.
- Alternatives: Brave image-search API (Brave's index, not Google's), Pexels API
  (stock images and video).
- Generation: Claude cannot generate images; needs a separate service (Adobe
  Firefly, OpenAI, Google Imagen). Firefly API access and pricing not yet
  researched.
- Licensing: found images need a stored source URL and a check before use in
  published videos.

## Webview notes (for A and D)

- Premiere UXP has a `<webview>` that loads remote https sites if domains are
  listed in the manifest (`webview` permission). No new windows or popups, no
  wildcards at the top-level domain. (checked: Adobe WebView docs, see
  `docs/research-preview-button.md`)
- Unverified: ChatGPT/Claude login, chat, upload and download inside it;
  YouTube playback and domain coverage (`youtube.com`, `ytimg.com`,
  `googlevideo.com`, `gstatic.com`); reading the current URL; X login.
- A webview chat cannot see the timeline or import files on its own.

## Suggested path

1. **Optional 30-minute webview test:** load chatgpt.com or claude.ai and
   youtube.com in a test panel. Record what works.
2. **First milestone (B):** chat tab in the Media Finder panel with
   `search_videos`, `get_url_info`, `preview`, `download_and_import`. Reuses the
   server, bin picker, Recent list and import code.
3. **Add images:** `search_images` (Pexels or Brave), with source links.
4. **Later:** `generate_image` once a service is chosen (research Firefly API
   first), and TikTok/Instagram sources per
   `docs/research-instagram-tiktok.md`.

## Open questions

- Which image source first: Pexels, Brave, or generation?
- Firefly API: access, pricing, commercial-use terms?
- Does Adobe's Generative Media tool cover stills? (unconfirmed)
- Can Adobe's AI Assistant create masks? (unverified; needs the beta to test)
- Can a UXP panel read a webview's current URL?
- New tab in the Media Finder panel or a separate panel?
- API key storage and cost cap for the chat route.

## Reminder

Sam asked to be reminded around 10 AM Eastern the next day to explore this.
