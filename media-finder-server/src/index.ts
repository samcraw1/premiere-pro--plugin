import "dotenv/config";
import fs from "node:fs/promises"
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

const downloadsDir = path.join(process.cwd(), "downloads");
const ytDlpBinaryPath = path.join(process.cwd(), "bin", "yt-dlp");

try {
  await fs.access(ytDlpBinaryPath);
} catch {
  console.error(
    `yt-dlp binary not found at ${ytDlpBinaryPath}. Run "npm run setup:yt-dlp" once, then try again.`
  );
  process.exit(1);
}

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


app.use(cors());
app.use(express.json());

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});


app.post("/download", async (request, response) => {
    const video = request.body
    if(!video || !video.url) {
        return response.status(400).json({ error: "Video URL is required" });
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
    const rawPathTemplate = path.join(downloadsDir, `${downloadId}-raw.%(ext)s`);

    try {
        await new Promise<void>((resolve, reject) => {
            ytDlpWrap
                .exec([
                    video.url,
                    // Pin the codec, not just the container - YouTube also
                    // serves AV1/VP9 inside mp4 containers, which Premiere
                    // doesn't reliably decode, so ext=mp4 alone isn't enough.
                    "-f", "bv*[vcodec^=avc1]+ba[ext=m4a]/b[vcodec^=avc1]/best",
                    "--merge-output-format", "mp4",
                    "--ffmpeg-location", ffmpegPath.path,
                    "-o", rawPathTemplate,
                ])
                .on("progress", (progress: { percent?: number }) => {
                    response.write(JSON.stringify({ type: "progress", percent: Math.round(progress.percent ?? 0) }) + "\n");
                })
                .on("error", (err: Error) => reject(err))
                .on("close", () => resolve());
        });

        const downloadedFiles = await fs.readdir(downloadsDir);
        const rawFilename = downloadedFiles.find((name) => name.startsWith(`${downloadId}-raw.`));
        if (!rawFilename) {
            throw new Error("yt-dlp did not produce an output file");
        }
        const rawPath = path.join(downloadsDir, rawFilename);
        const isAlreadyMp4 = rawFilename.endsWith(".mp4");

        let finalPath = rawPath;
        let filename = rawFilename;

        if (!isAlreadyMp4) {
            response.write(JSON.stringify({ type: "converting" }) + "\n");
            const convertedPath = path.join(downloadsDir, `${downloadId}.mp4`);
            await convertToMp4(rawPath, convertedPath);
            await fs.unlink(rawPath);
            finalPath = convertedPath;
            filename = `${downloadId}.mp4`;
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
    if (!parsed.hostname.endsWith("ytimg.com")) {
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

    try {
        new URL(url);
    } catch {
        return response.status(400).json({ error: "Invalid URL" });
    }

    try {
        // Not getVideoInfo() - it silently injects "-f best", which fails
        // outright on videos with no single pre-merged best stream. Plain
        // --dump-json needs no format resolution at all for metadata.
        const stdout = await ytDlpWrap.execPromise([url, "--dump-json", "--no-warnings"]);
        const entry = JSON.parse(stdout);
        return response.status(200).json({
            id: entry.id,
            title: entry.title,
            url: entry.webpage_url,
            duration: entry.duration ?? 0,
            thumbnail: entry.thumbnail ?? "",
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

