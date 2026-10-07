import "dotenv/config";
import fileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import YTDlpWrapImport from "yt-dlp-wrap";

// yt-dlp-wrap's CJS/ESM interop is broken under NodeNext ESM - its default
// export ends up double-wrapped at runtime, and its .d.ts doesn't reflect
// that either, so this one boundary is intentionally untyped.
const YTDlpWrapAny = YTDlpWrapImport as any;
const YTDlpWrap = (YTDlpWrapAny.default ?? YTDlpWrapAny);

ffmpeg.setFfmpegPath(ffmpegPath.path);

const downloadsDir = process.env.DOWNLOADS_DIR ?? path.join(os.homedir(), "Desktop", "MediaFinder");
const ytDlpBinaryPath = path.join(process.cwd(), "bin", "yt-dlp");
const cookiesBrowser = process.env.COOKIES_BROWSER;

try {
  await fileSystem.access(ytDlpBinaryPath);
} catch {
  console.error(
    `yt-dlp binary not found at ${ytDlpBinaryPath}. Run "npm run setup:yt-dlp" once, then try again.`
  );
  process.exit(1);
}

await fileSystem.mkdir(downloadsDir, { recursive: true });
await fileSystem.mkdir(path.join(process.cwd(), "previews"), { recursive: true });

const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
const app = express();

function convertToMp4(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(outputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

function toSafeBaseName(title: unknown, fallback: string): string {
  const cleaned = String(title ?? "")
    .replace(/[\\/:*?"<>|%\u0000-\u001f]/g, "") // % would break yt-dlp's -o template
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
  return cleaned || fallback
}

// Only these sites (exact host or any subdomain) may be passed to yt-dlp.
const ALLOWED_VIDEO_HOSTS = [
  "youtube.com", "youtu.be",
  "x.com", "twitter.com", "t.co",
  "tiktok.com",
  "instagram.com", "cdninstagram.com", "fbcdn.net",
];

// Returns the normalized URL if it is http(s) on an allowed host, else null.
function validateVideoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_VIDEO_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  return allowed ? parsed.href : null;
}

app.use(cors());
app.use(express.json());
app.use("/previews", express.static(path.join(process.cwd(), "previews")));

// Local-only: listen on both loopback addresses so "localhost" works whether
// it resolves to IPv4 or IPv6, but nothing on the network can reach the server.
for (const host of ["127.0.0.1", "::1"]) {
  const server = app.listen(3000, host, () => {
    console.log(`Server is running on port 3000 (${host})`);
  });
  server.on("error", (err) => {
    console.error(`Could not listen on ${host}:`, err.message);
  });
}

app.post("/preview", async (request, response) => {
    const { url, id } = request.body;
    if(!url || !id) {
        return response.status(400).json({ error: "URL and ID are required" });
    }
    const videoUrl = validateVideoUrl(url);
    if (!videoUrl) {
        return response.status(400).json({ error: "Invalid or unsupported URL" });
    }

    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "");

    const clipPath = path.join(process.cwd(), "previews", `${safeId}.mp4`);
    try{
        await fileSystem.access(clipPath);
        return response.status(200).json({ previewUrl: `http://localhost:3000/previews/${safeId}.mp4` });
    } catch {
        // no cached clip yet; fall through to make one
    }

    try {
        await ytDlpWrap.execPromise([
           "-f", "b[height<=360][vcodec^=avc1]/18/b[height<=480]/w[vcodec^=h264][format_note!=?watermarked]/best",
        "--download-sections", "*0-10",
        "--force-keyframes-at-cuts",
        "--cookies-from-browser", cookiesBrowser,
        "--ffmpeg-location", ffmpegPath.path,
        "-o", clipPath,
        "--", videoUrl,
        ])
        return response.status(200).json({ previewUrl: `http://localhost:3000/previews/${safeId}.mp4` });
    } catch (err) {
        console.error(err);
        return response.status(500).json({ error: "Failed to generate preview" });
    }
});

    


app.post("/download", async (request, response) => {
    const video = request.body
    if(!video || !video.url) {
        return response.status(400).json({ error: "Video URL is required" });
    }
    const videoUrl = validateVideoUrl(video.url);
    if (!videoUrl) {
        return response.status(400).json({ error: "Invalid or unsupported URL" });
    }

    // From here on, we've committed to a 200 + streaming NDJSON response,
    // since we're already writing to disk. Errors past this point are
    // reported as an inline {"type":"error"} line, not an HTTP status.
    response.status(200);
    response.setHeader("Content-Type", "application/x-ndjson");

    const downloadId = Date.now();
    // yt-dlp picks the real extension itself (usually mp4, but not
    // guaranteed - e.g. it falls back to webm if no mp4 format exists),
    // so we template it and check afterward rather than assuming.
    const baseName = `${toSafeBaseName(video.title, "video")} [${downloadId}]`;
    const rawPathTemplate = path.join(downloadsDir, `${baseName}-raw.%(ext)s`);

    try {
        await new Promise<void>((resolve, reject) => {
            ytDlpWrap
                .exec([
                    "--cookies-from-browser", cookiesBrowser,
                    // Pin the codec, not just the container - YouTube also
                    // serves AV1/VP9 inside mp4 containers, which Premiere
                    // doesn't reliably decode, so ext=mp4 alone isn't enough.
                    // TikTok labels its H.264 "h264" (not "avc1") and also serves
                    // H.265 and a watermarked copy, hence the third branch.
                    "-f", "bv*[vcodec^=avc1]+ba[ext=m4a]/b[vcodec^=avc1]/b[vcodec^=h264][format_note!=?watermarked]/best",
                    "--merge-output-format", "mp4",
                    "--ffmpeg-location", ffmpegPath.path,
                    "-o", rawPathTemplate,
                    "--", videoUrl,
                ])
                .on("progress", (progress: { percent?: number }) => {
                    response.write(JSON.stringify({ type: "progress", percent: Math.round(progress.percent ?? 0) }) + "\n");
                })
                .on("error", (err: Error) => reject(err))
                .on("close", () => resolve());
        });

        const downloadedFiles = await fileSystem.readdir(downloadsDir);
        const rawFilename = downloadedFiles.find((name) => name.startsWith(`${baseName}-raw.`));
        if (!rawFilename) {
            throw new Error("yt-dlp did not produce an output file");
        }
        const rawPath = path.join(downloadsDir, rawFilename);
        const isAlreadyMp4 = rawFilename.endsWith(".mp4");

        let finalPath = rawPath;
        let filename = rawFilename;

        if (!isAlreadyMp4) {
            response.write(JSON.stringify({ type: "converting" }) + "\n");
            const convertedPath = path.join(downloadsDir, `${baseName}.mp4`);
            await convertToMp4(rawPath, convertedPath);
            await fileSystem.unlink(rawPath);
            finalPath = convertedPath;
            filename = `${baseName}.mp4`;
        }

        response.write(JSON.stringify({ type: "done", filename, filePath: finalPath }) + "\n");
        response.end();
    } catch (error) {
        console.error(error);
        response.write(JSON.stringify({ type: "error", message: "Failed to download video" }) + "\n");
        response.end();
    }
});

app.get("/thumbnail", async (request, response) => {
    const url = request.query.url;
    if (!url || typeof url !== "string") {
        return response.status(400).json({ error: "Image URL is required" });
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return response.status(400).json({ error: "Invalid URL" });
    }
    const allowedImageHosts = ["ytimg.com", "twimg.com", "tiktokcdn-us.com", "tiktokcdn.com", `cdninstagram.com`, `fbcdn.net`];
    const host = parsed.hostname;
    if (!allowedImageHosts.some((d) => host === d || host.endsWith(`.${d}`))) {
        return response.status(400).json({ error: "Unsupported image host" });
    }

    try {
        const imageResponse = await fetch(url);
        if (!imageResponse.ok) {
            return response.status(502).json({ error: "Failed to fetch image" });
        }
        const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        response.setHeader("Content-Type", contentType);
        response.setHeader("Cache-Control", "public, max-age=3600");
        return response.status(200).send(buffer);
    } catch (error) {
        console.error(error);
        return response.status(500).json({ error: "Failed to fetch image" });
    }
});

app.get("/url-info", async (request, response) => {
    const url = request.query.url;
    if (!url || typeof url !== "string") {
        return response.status(400).json({ error: "URL is required" });
    }

    const videoUrl = validateVideoUrl(url);
    if (!videoUrl) {
        return response.status(400).json({ error: "Invalid or unsupported URL" });
    }

    try {
        // Not getVideoInfo() - it silently injects "-f best", which fails
        // outright on videos with no single pre-merged best stream. Plain
        // --dump-json needs no format resolution at all for metadata.
        const stdout = await ytDlpWrap.execPromise(["--dump-json", "--no-warnings", "--cookies-from-browser", cookiesBrowser, "--playlist-items", "1", "--", videoUrl]);
        const entry = JSON.parse(stdout);
        return response.status(200).json({
            id: entry.id,
            title: entry.title,
            url: entry.webpage_url,
            duration: entry.duration ?? 0,
            thumbnail: entry.thumbnail ?? "",
            uploader: entry.uploader ?? "",
            uploaderId: entry.uploader_id ?? "",
            description: entry.description ?? "",
        });
    } catch (error) {
        console.error(error);
        return response.status(500).json({ error: "Failed to fetch URL info" });
    }
});


app.get("/search", async (request, response) => {
    const term = request.query.term
    if(!term) {
        return response.status(400).json({ error: "Search term is required" });
    }

    try {
        const stdout = await ytDlpWrap.execPromise([
            `ytsearch12:${String(term)}`,
            "--dump-json",
            "--no-warnings",
            "--cookies-from-browser", "chrome",
        ]);

        const results = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line: string) => {
                const entry = JSON.parse(line);
                return {
                    id: entry.id,
                    title: entry.title,
                    url: entry.webpage_url,
                    duration: entry.duration ?? 0,
                    thumbnail: entry.thumbnail ?? "",
                };
            });

        return response.status(200).json({ results });
    } catch (error) {
        console.error(error);
        return response.status(500).json({ error: "Failed to search videos" });
    }

});

