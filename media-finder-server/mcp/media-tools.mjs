// Minimal MCP server (stdio, newline-delimited JSON-RPC) for the AI assistant.
// Launched by the `claude` CLI via --mcp-config. It only wraps the local
// media-finder server's own routes, so the assistant can search and propose
// imports but can't touch files, the shell, or Premiere directly.
import readline from "node:readline";
import fileSystem from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SERVER_URL = process.env.MEDIA_SERVER_URL ?? "http://127.0.0.1:3000";
const REQUEST_ID = process.env.AI_REQUEST_ID ?? "";

// Local file search is limited to these folders and media types. The server checks the
// same lists again before it accepts an import proposal (see resolveLocalMediaPath in index.ts).
const LOCAL_MEDIA_EXTENSIONS = new Set([
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mxf",
    ".m4a", ".mp3", ".wav", ".aif", ".aiff", ".flac", ".aac",
    ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".psd",
]);
const LOCAL_SEARCH_ROOTS = ["Downloads", "Desktop", "Movies", "Music"].map((name) => path.join(os.homedir(), name));
const LOCAL_SEARCH_MAX_RESULTS = 10;
const LOCAL_SEARCH_MAX_VISITED = 5000;
const LOCAL_SEARCH_MAX_DEPTH = 4;

// Finds media files whose name contains every word of `term`. Skips hidden entries and
// symlinks (Dirent reports a symlink as neither file nor directory).
async function findLocalMedia(term) {
    const words = String(term).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0) return [];
    const found = [];
    let visited = 0;

    async function walk(dir, depth) {
        if (depth > LOCAL_SEARCH_MAX_DEPTH) return;
        let entries;
        try {
            entries = await fileSystem.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (found.length >= LOCAL_SEARCH_MAX_RESULTS || ++visited > LOCAL_SEARCH_MAX_VISITED) return;
            if (entry.name.startsWith(".")) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, depth + 1);
            } else if (entry.isFile() && LOCAL_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                const lower = entry.name.toLowerCase();
                if (words.every((word) => lower.includes(word))) found.push(full);
            }
        }
    }

    for (const root of LOCAL_SEARCH_ROOTS) await walk(root, 0);

    return Promise.all(found.map(async (full) => {
        const { size } = await fileSystem.stat(full);
        return { name: path.basename(full), path: full, size };
    }));
}

const tools = [
    {
        name: "search_videos",
        description: "Search YouTube for videos. Returns up to 12 results with id, title, url, duration (seconds).",
        inputSchema: {
            type: "object",
            properties: { term: { type: "string", description: "Search terms" } },
            required: ["term"],
        },
    },
    {
        name: "get_url_info",
        description: "Look up title, duration and uploader for a pasted YouTube, X or TikTok URL.",
        inputSchema: {
            type: "object",
            properties: { url: { type: "string", description: "Full video URL" } },
            required: ["url"],
        },
    },
    {
        name: "propose_import",
        description:
            "Propose downloading a video and importing it into the user's Premiere project. " +
            "This does NOT import anything: the user sees a confirm button and decides. " +
            "Use ids/urls exactly as returned by search_videos or get_url_info.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                duration: { type: "number" },
                thumbnail: { type: "string" },
                bin_name: { type: "string", description: "Target bin name, exactly as listed in the project bins. Omit for the currently selected bin." },
            },
            required: ["id", "title", "url"],
        },
    },
    {
        name: "propose_move",
        description:
            "Propose moving existing project items into a bin (creating the bin if it does not exist). " +
            "This does NOT move anything: the user sees a confirm button and decides. " +
            "Copy each item's name and bin exactly as listed under 'Project items'. Use an empty string for bin when an item is at the project root.",
        inputSchema: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { name: { type: "string" }, bin: { type: "string" } },
                        required: ["name", "bin"],
                    },
                },
                target_bin: { type: "string", description: "Bin to move the items into. Created at the project root if missing." },
            },
            required: ["items", "target_bin"],
        },
    },
    {
        name: "propose_audio_adjust",
        description:
            "Propose raising or lowering the volume of the audio clips the user has selected on the timeline, by a number of dB. " +
            "Negative lowers, positive raises (e.g. -6 for 'turn it down 6 dB'). " +
            "This does NOT change anything: the user sees a confirm button and decides.",
        inputSchema: {
            type: "object",
            properties: {
                delta_db: { type: "number", description: "Change in dB, e.g. -6 or 3" },
            },
            required: ["delta_db"],
        },
    },
    {
        name: "search_local_files",
        description:
            "Search the user's Downloads, Desktop, Movies and Music folders for media files (video, audio, images) " +
            "whose file name contains all the words in term. Returns up to 10 matches with name, full path and size in bytes. " +
            "Search by words from the title, not the extension.",
        inputSchema: {
            type: "object",
            properties: { term: { type: "string", description: "Words from the file name" } },
            required: ["term"],
        },
    },
    {
        name: "propose_import_local",
        description:
            "Propose importing a file from the user's own computer (not a URL) into the project root. " +
            "Pass path exactly as returned by search_local_files. If you could not find the file, omit path: " +
            "the confirm button then opens a file picker and the user chooses it themselves. " +
            "This does NOT import anything until the user confirms.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "Full path from search_local_files" } },
        },
    },
];

async function callServer(path, options) {
    const response = await fetch(`${SERVER_URL}${path}`, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Server returned ${response.status}`);
    return body;
}

const handlers = {
    async search_videos({ term }) {
        const { results } = await callServer(`/search?term=${encodeURIComponent(String(term))}`);
        return results.map(({ id, title, url, duration }) => ({ id, title, url, duration }));
    },
    async get_url_info({ url }) {
        const info = await callServer(`/url-info?url=${encodeURIComponent(String(url))}`);
        const { id, title, url: canonical, duration, uploader, thumbnail } = info;
        return { id, title, url: canonical, duration, uploader, thumbnail };
    },
    async propose_import(args) {
        if (!REQUEST_ID) throw new Error("No request id; cannot record a proposal");
        await callServer(`/ai-assistant/proposals/${encodeURIComponent(REQUEST_ID)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
        });
        return { status: "proposed", note: "The user will see a confirm button. Do not say it was imported." };
    },
    async propose_move({ items, target_bin }) {
        if (!REQUEST_ID) throw new Error("No request id; cannot record a proposal");
        await callServer(`/ai-assistant/proposals/${encodeURIComponent(REQUEST_ID)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "move", items, target_bin }),
        });
        return { status: "proposed", note: "The user will see a confirm button. Do not say it was moved." };
    },
    async propose_audio_adjust({ delta_db }) {
        if (!REQUEST_ID) throw new Error("No request id; cannot record a proposal");
        await callServer(`/ai-assistant/proposals/${encodeURIComponent(REQUEST_ID)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "audio", delta_db }),
        });
        return { status: "proposed", note: "The user will see a confirm button. Do not say the volume was changed." };
    },
    async search_local_files({ term }) {
        return await findLocalMedia(term);
    },
    async propose_import_local({ path: filePath } = {}) {
        if (!REQUEST_ID) throw new Error("No request id; cannot record a proposal");
        await callServer(`/ai-assistant/proposals/${encodeURIComponent(REQUEST_ID)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(filePath === undefined ? { type: "local_import" } : { type: "local_import", path: filePath }),
        });
        return {
            status: "proposed",
            note: filePath === undefined
                ? "The user will see a confirm button that opens a file picker. Do not say anything was imported."
                : "The user will see a confirm button for that file. Do not say it was imported.",
        };
    },
};

function send(message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function handle(request) {
    const { id, method, params } = request;
    const isNotification = id === undefined;

    try {
        if (method === "initialize") {
            return send({
                id,
                result: {
                    protocolVersion: params?.protocolVersion ?? "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "media-tools", version: "1.0.0" },
                },
            });
        }
        if (method === "ping") return send({ id, result: {} });
        if (method === "tools/list") return send({ id, result: { tools } });
        if (method === "tools/call") {
            const handler = handlers[params?.name];
            if (!handler) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
            try {
                const output = await handler(params.arguments ?? {});
                return send({ id, result: { content: [{ type: "text", text: JSON.stringify(output) }] } });
            } catch (err) {
                return send({ id, result: { isError: true, content: [{ type: "text", text: String(err.message ?? err) }] } });
            }
        }
        if (!isNotification) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (err) {
        if (!isNotification) send({ id, error: { code: -32603, message: String(err.message ?? err) } });
    }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try {
        request = JSON.parse(line);
    } catch {
        return;
    }
    handle(request);
});
