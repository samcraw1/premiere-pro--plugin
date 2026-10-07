import "dotenv/config";
import fileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
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

const scanMediaExtensions = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".aac"]);
const scanMaxDepth = 6;
const scanMaxFiles = 2000;

// Recursively lists media files under dir. Capped on depth and count, skips
// symlinks and unreadable folders. Callers must only pass a root that is safe
// to expose (e.g. downloadsDir), never a path taken straight from a request.
async function scanDir(dir: string, found: string[] = [], depth = 0): Promise<string[]> {
    if(depth > scanMaxDepth || found.length >= scanMaxFiles) return found;

    let entries;
    try {
        entries = await fileSystem.readdir(dir, { withFileTypes: true });
    } catch {
        return found;
    }

    for (const entry of entries) {
        if(found.length >= scanMaxFiles) break;
        const full = path.join(dir, entry.name);
        if(entry.isSymbolicLink()) continue;
        if(entry.isDirectory()) {
            await scanDir(full, found, depth + 1);
        } else if(scanMediaExtensions.has(path.extname(entry.name).toLowerCase())) {
            found.push(full);
        }
    }
    return found;
}

app.use(cors());
app.use(express.json());
app.use("/previews", express.static(path.join(process.cwd(), "previews")));
app.use("/downloads", express.static(downloadsDir));


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

const aiScratchDir = path.join(os.tmpdir(), "media-finder-ai");
const aiTimeoutMs = 120_000;
const mcpServerPath = path.join(process.cwd(), "mcp", "media-tools.mjs");
const aiTools = ["search_videos", "get_url_info", "propose_import", "propose_move", "propose_audio_adjust"];

type MoveProposal = {
    type: "move";
    items: { name: string; bin: string }[];
    targetBin: string;
};

type AudioProposal = {
    type: "audio";
    deltaDb: number;
};

type ImportProposal = {
    type: "import";
    id: string;
    title: string;
    url: string;
    duration?: number;
    thumbnail?: string;
    binName?: string;
};

// Proposals the assistant made during an in-flight /ai-assistant request,
// keyed by that request's id. An id only exists while its request is running.
const aiProposals = new Map<string, (ImportProposal | MoveProposal | AudioProposal)[]>();

type ProjectClip = { name: string; bin: string };
type ChatTurn = { role: "user" | "assistant"; text: string };

// The CLI is stateless, so earlier turns ride along in the prompt text.
function buildAiPrompt(question: string, history: ChatTurn[]) {
    if(history.length === 0) return question;
    const lines = history
        .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
        .join("\n");
    return `Conversation so far:\n${lines}\n\nUser: ${question}`;
}

function buildAiSystemPrompt(bins: string[], clips: ProjectClip[]) {
    const binList = bins.length ? bins.map((name) => `- ${name}`).join("\n") : "(none loaded)";
    const clipList = clips.length
        ? clips.map((clip) => `- ${clip.bin ? `${clip.bin} / ` : ""}${clip.name}`).join("\n")
        : "(none loaded)";
    return [
        "You are the assistant inside a Premiere Pro media-finder panel.",
        "Be brief. Reply in plain text only: no markdown, no asterisks, no headings.",
        "You can search YouTube (search_videos), look up a pasted URL (get_url_info), and propose imports (propose_import).",
        "You can also propose moving existing project items into a bin (propose_move), creating the bin if needed.",
        "You can propose raising or lowering the volume of the audio clips the user has selected on the timeline by a number of dB (propose_audio_adjust, negative = quieter).",
        "propose_import, propose_move and propose_audio_adjust never change anything. The user confirms each one with a button, so say you proposed it, never that it was imported, moved or changed.",
        "For propose_move, copy each item's name and bin exactly as listed under Project items. Match what the user means even if they misspell it.",
        "You cannot see the user's timeline or clip contents, only the bin and item names below. Answer questions about the project from these lists.",
        "Project bins:",
        binList,
        "Project items (bin / name):",
        clipList,
    ].join("\n");
}

// Runs the Claude CLI headless with only our three MCP tools, no built-in
// tools and no user config, so each call stays small and cheap. The question
// goes in over stdin, not argv, so text starting with "-" can't be read as a flag.
function askClaude(question: string, bins: string[], clips: ProjectClip[], requestId: string): Promise<string> {
    const mcpConfig = JSON.stringify({
        mcpServers: {
            media: {
                command: process.execPath,
                args: [mcpServerPath],
                env: { AI_REQUEST_ID: requestId, MEDIA_SERVER_URL: "http://127.0.0.1:3000" },
            },
        },
    });

    return new Promise((resolve, reject) => {
        const child = spawn("claude", [
            "-p",
            "--output-format", "json",
            "--tools", "",
            "--allowedTools", ...aiTools.map((name) => `mcp__media__${name}`),
            "--mcp-config", mcpConfig,
            "--strict-mcp-config",
            "--no-session-persistence",
            "--setting-sources", "",
            "--system-prompt", buildAiSystemPrompt(bins, clips),
            "--model", "claude-haiku-4-5-20251001",
        ], { cwd: aiScratchDir, stdio: ["pipe", "pipe", "pipe"] });

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("claude timed out"));
        }, aiTimeoutMs);

        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if(code !== 0) {
                return reject(new Error(`claude exited with ${code}: ${stderr.slice(0, 500)}`));
            }
            try {
                const output = JSON.parse(stdout);
                if(output.is_error) return reject(new Error(output.result ?? "claude returned an error"));
                resolve(String(output.result ?? ""));
            } catch {
                reject(new Error("claude returned unreadable output"));
            }
        });

        child.stdin.end(question);
    });
}

// Called by the MCP tool process while a request is running.
app.post("/ai-assistant/proposals/:requestId", (request, response) => {
    const proposals = aiProposals.get(request.params.requestId);
    if(!proposals) {
        return response.status(404).json({ error: "Unknown request" });
    }
    if(proposals.length >= 5) {
        return response.status(429).json({ error: "Too many proposals for one question" });
    }

    const body = request.body ?? {};

    if(body.type === "move") {
        const { items, target_bin } = body;
        if(!Array.isArray(items) || typeof target_bin !== "string" || !target_bin.trim()) {
            return response.status(400).json({ error: "items and target_bin are required" });
        }
        const cleanItems = items
            .filter((item: any): item is { name: string; bin: string } => typeof item?.name === "string" && typeof item?.bin === "string")
            .slice(0, 50)
            .map((item: { name: string; bin: string }) => ({ name: item.name.slice(0, 120), bin: item.bin.slice(0, 200) }));
        if(cleanItems.length === 0) {
            return response.status(400).json({ error: "At least one item is required" });
        }
        proposals.push({ type: "move", items: cleanItems, targetBin: target_bin.trim().slice(0, 200) });
        return response.status(200).json({ ok: true });
    }

    if(body.type === "audio") {
        const { delta_db } = body;
        if(typeof delta_db !== "number" || !Number.isFinite(delta_db) || Math.abs(delta_db) > 40) {
            return response.status(400).json({ error: "delta_db must be a number between -40 and 40" });
        }
        proposals.push({ type: "audio", deltaDb: delta_db });
        return response.status(200).json({ ok: true });
    }

    const { id, title, url, duration, thumbnail, bin_name } = body;
    if(typeof id !== "string" || typeof title !== "string" || typeof url !== "string") {
        return response.status(400).json({ error: "id, title and url are required" });
    }
    const videoUrl = validateVideoUrl(url);
    if(!videoUrl) {
        return response.status(400).json({ error: "Invalid or unsupported URL" });
    }

    proposals.push({
        type: "import",
        id: id.slice(0, 100),
        title: title.slice(0, 300),
        url: videoUrl,
        duration: typeof duration === "number" ? duration : undefined,
        thumbnail: typeof thumbnail === "string" ? thumbnail : undefined,
        binName: typeof bin_name === "string" ? bin_name.slice(0, 200) : undefined,
    });
    return response.status(200).json({ ok: true });
});

app.post("/ai-assistant", async (request, response) => {
    const { questionForAi, bins, clips, history } = request.body;

    if(typeof questionForAi !== "string" || !questionForAi.trim()) {
        return response.status(400).json({ error: "Question for AI is required" });
    }
    if(questionForAi.length > 2000) {
        return response.status(400).json({ error: "Question for AI is too long" });
    }
    const binNames: string[] = Array.isArray(bins)
        ? bins.filter((name): name is string => typeof name === "string").slice(0, 100).map((name) => name.slice(0, 200))
        : [];

    const projectClips: ProjectClip[] = Array.isArray(clips)
        ? clips
            .filter((clip): clip is ProjectClip => typeof clip?.name === "string" && typeof clip?.bin === "string")
            .slice(0, 300)
            .map((clip) => ({ name: clip.name.slice(0, 120), bin: clip.bin.slice(0, 200) }))
        : [];

    const chatHistory: ChatTurn[] = Array.isArray(history)
        ? history
            .filter((turn: any): turn is ChatTurn =>
                (turn?.role === "user" || turn?.role === "assistant") &&
                typeof turn?.text === "string" && turn.text.trim() !== "")
            .slice(-6)
            .map((turn: ChatTurn) => ({ role: turn.role, text: turn.text.slice(0, 1000) }))
        : [];

    const requestId = randomUUID();
    aiProposals.set(requestId, []);
    try {
        await fileSystem.mkdir(aiScratchDir, { recursive: true });
        const answer = await askClaude(buildAiPrompt(questionForAi.trim(), chatHistory), binNames, projectClips, requestId);
        return response.status(200).json({ answer, proposals: aiProposals.get(requestId) ?? [] });
    } catch (err) {
        console.error("AI assistant failed:", err);
        return response.status(500).json({ error: "AI assistant failed" });
    } finally {
        aiProposals.delete(requestId);
    }
});

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

