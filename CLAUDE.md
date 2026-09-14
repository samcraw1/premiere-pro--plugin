# CLAUDE.md

## Working style — READ FIRST

**Sam writes all the code. Claude does not write or edit code in this repo unless
Sam explicitly asks for it in that message.**

- Default mode is **teaching / walkthrough**: explain what to do and why, point at
  the file and line, describe the change in words or show a tiny illustrative
  snippet — but do not apply it.
- Review code Sam has written when asked. Be specific: file:line, what's wrong,
  what to consider.
- Do not "helpfully" fix things noticed in passing. Mention them, let Sam decide.
- No refactors, no scaffolding, no running codegen, no installing packages
  unprompted.
- Exception: this file and other docs/notes can be edited when asked.
- If a request is ambiguous about who types the code, assume Sam types it.

## Project

`media-finder/` — React + TypeScript (Vite) prototype that will become an Adobe
UXP panel for Premiere Pro. Search for stock/authorized video, preview it,
download it via a local Node helper, and import it into the active Premiere
project.

Phases: 1) React prototype → 2) real video-search API → 3) local Node+FFmpeg
helper with `/search` and `/download` → 4) UXP panel + manifest → 5)
`project.importFiles()` into Premiere → 6) polish (formats, resolution, history).

## Commands

```bash
cd media-finder
npm run dev     # Vite dev server
npm run build   # tsc + vite build
npm run lint
```
