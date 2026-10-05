# Idea: AI assistant panel for Premiere (chat, image search, image generation)

Date: 2026-10-05. Status: idea + notes, nothing built.

Source: Sam's notes from an earlier chat. The claims below come from those
notes and were **not re-verified here** unless marked "(checked in this repo)".
Treat dates, pricing and policy statements as things to confirm before relying
on them.

## Goal

A Premiere panel that helps while editing: chat with an AI, find images
(Google-style search or stock), and/or generate images, then bring the result
into the project. Example: while cutting a street interview, type "generate a
dramatic courtroom background for this answer", get a preview, click **Import
to Project**.

The sharper angle (from the notes): a fast **asset assistant** for Sam's editing
style: reaction images, cutaways, backgrounds and stock footage in one place,
instead of a generic chatbot.

## Overlap to be aware of

- Premiere already has an **AI Assistant in beta**, and Adobe announced image
  generation inside the timeline (notes say September 23).
- So a generic chatbot or image generator would duplicate Adobe. The value is in
  a specific workflow: "I need a visual for this joke: find it or make it, then
  import it."

## Building blocks

| Feature | How to build it |
|---|---|
| Chat inside Premiere | UXP panel that calls a backend, which sends messages to an AI model |
| Search internet images | An image-search API; show thumbnails + links to the original source |
| Search stock photos/video | Pexels API (images and video) |
| Generate images | An image-generation service such as Adobe Firefly, called from the backend |
| Import the result | Download the file locally, then `Project.importFiles()` (already used by Media Finder, see `Test-rh92b4/src/components/App.jsx`) |

Notes:
- UXP panels can make network requests and import files into bins; Media Finder
  already does both through the local Node server. (checked in this repo)
- The backend should hold API keys, not the panel.
- Save downloaded assets in a persistent folder so Premiere can still find them
  when the project is reopened. Media Finder already saves to
  `~/Desktop/MediaFinder`. (checked in this repo)

## The "Google Images" catch

- Google's Custom Search JSON API is reported closed to new customers, with
  existing customers required to migrate by **January 1, 2027**. Don't build on
  it.
- Alternative: Brave's image-search API. Results come from Brave's index, not
  Google's.

## Idea: embed ChatGPT in a webview (no API calls)

The thought: a docked browser inside Premiere where you log in to chatgpt.com and
use it normally, so there is no API integration or separate billing.

- Premiere UXP has a `<webview>` element. It loads remote https sites if the
  domain is allowed in the manifest (`webview` permission with `domains`), and
  it does **not** open new windows or popups. (checked: Adobe WebView docs,
  see `docs/research-preview-button.md` for links)
- **Unverified:** whether ChatGPT's login, chat, image upload and downloads work
  inside that embedded browser. Popup-based sign-in flows are the likely
  problem, since UXP blocks new windows. Needs a real test in Premiere.
- Even if it works, the embedded page cannot see the timeline or import
  generated images on its own; that would need extra integration.

**First prototype if pursued:** a dockable panel that just opens chatgpt.com.
Test: sign in, chat, upload an image, download a result. If those work, the
main need (talk to ChatGPT without leaving Premiere) is solved.

## Idea: own chat panel using a ChatGPT plan instead of an API key

- Per the notes, OpenAI documents "Sign in with ChatGPT": eligible requests are
  charged against the user's ChatGPT plan in an open-source app, after a
  registration/authorization flow.
- It does **not** give the panel access to existing ChatGPT conversations or
  account context.
- Flow: build a chat panel in Premiere, sign in through the browser, show
  responses in the panel. It still makes API requests, just billed to the plan.
- Limitation noted: image generation is **not** supported on this route. Text
  chat and supported image inputs work; web search depends on model and account
  policy.
- Claude: no general subscription route was found for third-party apps.
  Anthropic points developers to API authentication, so don't assume a Pro/Max
  allowance can power a custom panel.

## Suggested path

1. **Webview test (cheap, 30 min):** panel that loads chatgpt.com. Record what
   works (login, chat, upload, download).
2. **Search to import (first real milestone):** type a phrase, see image
   thumbnails (Pexels or Brave), pick one, import into the chosen bin. This
   reuses Media Finder's server, bin picker, Recent list and import code.
3. **Generate:** describe an image, preview it, import. Firefly or another image
   API behind the backend.
4. **Chat refinement:** "make it more dramatic", "find something closer to
   this". Add the conversational layer once search and import feel good.

## Open questions

- Does ChatGPT sign-in work inside a UXP webview? (test it)
- Is "Sign in with ChatGPT" available to a personal open-source app, and what is
  the registration process?
- Which image source is best for Sam's use: Brave image search, Pexels, or
  generation first?
- Should this be a new tab in the existing Media Finder panel or a separate
  panel?
- Licensing: found internet images need a source link and a quick check before
  use in published videos.

## Reminder

Sam asked to be reminded around 10 AM Eastern the next day to explore this.
