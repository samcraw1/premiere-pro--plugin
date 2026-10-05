# Research: cloud storage instead of the local downloads folder

Date: 2026-10-05. Goal: store downloaded videos in iCloud, Google Drive, etc.
instead of `~/Desktop/MediaFinder`. No code changed.

## TL;DR

- **Easiest path needs no new code.** iCloud Drive, Google Drive for Desktop,
  Dropbox, and OneDrive all expose a synced folder on disk. The server already
  reads `DOWNLOADS_DIR` (`media-finder-server/src/index.ts:19`). Point it at a
  synced folder and the cloud app uploads for you.
- **Premiere must import a real local file.** `project.importFiles()` takes
  local paths. Cloud-only placeholder files (iCloud "Optimize Mac Storage",
  Drive "Stream files") break imports and relinking.
- **Direct cloud APIs** (Google Drive API, Dropbox API, S3) only make sense if
  you want storage without a desktop sync app, or a shared team library. They
  add auth, uploads, and a still-needed local copy for Premiere.
- Recommended: synced folder now, optional "stage locally, then move" later.

## How it works today

- `downloadsDir = process.env.DOWNLOADS_DIR ?? ~/Desktop/MediaFinder` (index.ts:19),
  created on startup (index.ts:31).
- yt-dlp writes `<title> [<id>]-raw.<ext>` straight into that folder
  (index.ts:83). Server finds it with `readdir` (index.ts:106), and if not mp4,
  ffmpeg writes `<title> [<id>].mp4` there and deletes the raw file
  (index.ts:119).
- The response returns `filePath`. The panel passes that path to
  `project.importFiles()` and stores it in the Recent list (localStorage).

So a path is the contract. Anything that keeps `filePath` a valid local path
works with the panel unchanged.

## Option A: synced folder (recommended)

Set `DOWNLOADS_DIR` in `media-finder-server/.env` (the server loads `dotenv`).

| Service | macOS folder | Notes |
|---|---|---|
| iCloud Drive | `~/Library/Mobile Documents/com~apple~CloudDocs/MediaFinder` (exists on this Mac) | Shows as "iCloud Drive" in Finder. Same user across Apple devices. |
| Google Drive for Desktop | `~/Library/CloudStorage/GoogleDrive-<email>/My Drive/MediaFinder` | Folder not present on this Mac yet, so the app isn't installed or signed in. |
| Dropbox | `~/Library/CloudStorage/Dropbox/MediaFinder` (newer installs) or `~/Dropbox/...` | |
| OneDrive | `~/Library/CloudStorage/OneDrive-<org>/MediaFinder` | |

Example `.env`:

```
DOWNLOADS_DIR=/Users/user01/Library/Mobile Documents/com~apple~CloudDocs/MediaFinder
```

Pros: zero code, works with any provider, Premiere sees a normal path.

Cons and gotchas:

1. **Offloaded files.** iCloud "Optimize Mac Storage" and Drive "Stream files"
   can evict local copies. Premiere then shows offline media. Fix: mark the
   folder "Keep Downloaded" (iCloud) / "Available offline" (Drive), or use
   Drive "Mirror files".
2. **Partial files sync.** yt-dlp writes `.part` files, then the `-raw` file,
   then the converted mp4, then deletes the raw. The sync client uploads the
   churn (wasted bandwidth, sometimes conflict copies). Mitigation in Option C.
3. **macOS permissions.** Node launched from Terminal needs Terminal (or your
   IDE) allowed under Privacy & Security, Files and Folders / Full Disk Access
   for iCloud Drive. First write may prompt.
4. **Path chars.** Spaces in the iCloud path are fine in Node. Filenames already
   strip `\ / : * ? " < > | %`. Brackets are fine.
5. **Other devices.** Laptop and desktop have different home dirs and
   usernames. Keep `DOWNLOADS_DIR` per machine in `.env` (not committed). A
   file imported on one machine and relinked on another needs the same media
   path, or use Premiere's Link Media.
6. **Slow uploads on large files** don't block the panel. Import uses the local
   copy immediately.
7. **Cloud URLs are not paths.** Do not store `https://drive.google.com/...`
   in `filePath`; Premiere can't import it.

## Option B: provider API upload

Server uploads the finished file via API, in addition to keeping a local copy
for Premiere.

- **Google Drive API v3**: OAuth 2.0 (Desktop app client), resumable upload for
  large files, scope `drive.file` (only files the app creates). Node:
  `googleapis`. Needs a Google Cloud project and OAuth consent screen. Tokens
  must be stored locally.
- **Dropbox API**: OAuth 2.0 PKCE, upload sessions for files over 150 MB. Node:
  `dropbox`.
- **iCloud**: **no public server-side API.** CloudKit is for app-container data
  and web access needs an Apple developer setup. For iCloud, use the synced
  folder (Option A).
- **S3 / R2 / B2** (not asked, but the cleanest if you want an owned library):
  one SDK, presigned URLs, cheap. Files still need a local copy for Premiere.

Pros: works without a desktop sync client, can return a share link, can be
shared with a team.
Cons: auth flow, token storage, error handling, retry, and the panel still
needs a local file. More code to maintain, and the CLAUDE.md rule is that you
write the code.

## Option C: stage locally, then move (hybrid)

Keep yt-dlp and ffmpeg working in a local temp dir
(`os.tmpdir()/mediafinder`), then move the finished mp4 into the synced folder
(`DOWNLOADS_DIR`) in one step.

- Cloud client only ever sees the finished file, so no `.part`/raw churn.
- `filePath` returned to the panel is the final synced path, still local.
- Use `fs.rename` when on the same volume, else copy then unlink (the iCloud
  folder is on the same APFS volume as home, so rename works there; Google
  Drive's mount may not allow rename, so fall back to copy).
- Small change in `/download` only: output template and `readdir` target the
  temp dir, then one move at the end.

## Comparison

| | Code change | Needs sign-in code | Premiere-ready | Share links | Works for iCloud |
|---|---|---|---|---|---|
| A: synced folder | none | no | yes (if kept offline) | via provider app | yes |
| B: API upload | large | yes | needs local copy | yes | no |
| C: stage then move | small | no | yes | via provider app | yes |

## Recommendation

1. Now: Option A. Create the folder in iCloud Drive, set "Keep Downloaded",
   set `DOWNLOADS_DIR` in `.env`, restart the server.
2. If sync churn or conflict copies show up: Option C.
3. Only add Option B if you want a shared team library or no desktop client.
   Start with Google Drive and `drive.file` scope.

## Open questions for Sam

- Which provider first: iCloud (already on this Mac) or Google Drive (not
  installed here yet)?
- Do you need the same files on both laptop and desktop? If yes, Premiere
  relinking and per-machine paths matter more than the provider choice.
- Do you want share links, or just storage?

## Related

- `docs/research-instagram-tiktok.md`: new sources will increase download
  volume, which raises the value of Option C.
- Earlier review note: `/download` URL validation and localhost binding apply
  regardless of storage.
