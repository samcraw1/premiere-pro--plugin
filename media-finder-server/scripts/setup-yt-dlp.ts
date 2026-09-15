import fs from "node:fs/promises";
import path from "node:path";
import YTDlpWrapImport from "yt-dlp-wrap";

// yt-dlp-wrap's CJS/ESM interop is broken under NodeNext ESM - its default
// export ends up double-wrapped at runtime, and its .d.ts doesn't reflect
// that either, so this one boundary is intentionally untyped.
const YTDlpWrapAny = YTDlpWrapImport as any;
const YTDlpWrap = (YTDlpWrapAny.default ?? YTDlpWrapAny);

const binaryPath = path.join(process.cwd(), "bin", "yt-dlp");

async function main() {
  await fs.mkdir(path.dirname(binaryPath), { recursive: true });
  console.log(`Downloading yt-dlp binary to ${binaryPath}...`);
  await YTDlpWrap.downloadFromGithub(binaryPath);
  console.log("Done. You can now run `npm run dev`.");
}

main().catch((error) => {
  console.error("Failed to download yt-dlp binary:", error);
  process.exit(1);
});
