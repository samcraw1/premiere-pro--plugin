import "dotenv/config";
import fs from "node:fs/promises"
import path from "node:path"
import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath.path);

const downloadsDir = path.join(process.cwd(), "downloads");
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

    let videoResponse: Response;
    try {
        videoResponse = await fetch(video.url);
    } catch (error) {
        console.error(error);
        return response.status(502).json({ error: "Failed to fetch video" });
    }

    if (!videoResponse.ok || !videoResponse.body) {
        return response.status(502).json({ error: "Failed to fetch video" });
    }

    // From here on, we've committed to a 200 + streaming NDJSON response,
    // since we're already writing to disk. Errors past this point are
    // reported as an inline {"type":"error"} line, not an HTTP status.
    response.status(200);
    response.setHeader("Content-Type", "application/x-ndjson");

    const total = Number(videoResponse.headers.get("content-length")) || 0;
    const isAlreadyMp4 = (videoResponse.headers.get("content-type") ?? "").includes("mp4");
    const downloadId = Date.now();
    const rawPath = path.join(downloadsDir, `${downloadId}-raw.mp4`);

    try {
        const fileHandle = await fs.open(rawPath, "w");
        const reader = videoResponse.body.getReader();
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            received += value.length;
            await fileHandle.write(value);

            const percent = total ? Math.round((received / total) * 100) : 0;
            response.write(JSON.stringify({ type: "progress", received, total, percent }) + "\n");
        }

        await fileHandle.close();

        let finalPath = rawPath;
        let filename = `${downloadId}-raw.mp4`;

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
    if (!parsed.hostname.endsWith("pixabay.com")) {
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

app.get("/search", async (request, response) => {
    const term = request.query.term
    if(!term) {
        return response.status(400).json({ error: "Search term is required" });
    } 

    try {
        const url = `https://pixabay.com/api/videos/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(String(term))}&per_page=12`;
        const pixabayResponse = await fetch(url);

        if (!pixabayResponse.ok) {
            return response.status(502).json({ error: "Failed to fetch videos from Pixabay" });
        }

        const data = await pixabayResponse.json();
        return response.status(200).json(data);
    } catch (error) {
        console.error(error);
        return response.status(500).json({ error: "Failed to search videos" });
    }

});

