# Sharing this plugin

For personal use on another machine, or handing it to a teammate (not Adobe Exchange
distribution):

```bash
cd Test-rh92b4
npm run build
cd dist
zip -r ../Test-rh92b4-plugin.zip .
```

Send `Test-rh92b4-plugin.zip`. Whoever receives it:

1. Unzips it, opens **UXP Developer Tools** → Add Plugin → selects the unzipped
   `manifest.json`.
2. Needs `PlayerDebugMode` enabled for their Premiere Pro install, then a full
   quit/relaunch of Premiere:
   ```bash
   defaults write "com.Adobe.Premiere Pro.<version>" PlayerDebugMode 1
   ```
   (find the exact domain with `defaults find PremierePro` if unsure — pick the one
   matching their installed version, e.g. `com.Adobe.Premiere Pro.26.5`).
3. **Also needs their own copy of `media-finder-server` running.** The plugin only
   talks to `http://localhost:3000` — there's no bundled backend, and UXP plugins can't
   shell out to `yt-dlp`/`ffmpeg` themselves. So share the `media-finder-server/` folder
   too, and have them run once:
   ```bash
   cd media-finder-server
   npm install
   npm run setup:yt-dlp
   ./start.sh
   ```
