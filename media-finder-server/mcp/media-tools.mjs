// Minimal MCP server (stdio, newline-delimited JSON-RPC) for the AI assistant.
// Launched by the `claude` CLI via --mcp-config. It only wraps the local
// media-finder server's own routes, so the assistant can search and propose
// imports but can't touch files, the shell, or Premiere directly.
import readline from "node:readline";

const SERVER_URL = process.env.MEDIA_SERVER_URL ?? "http://127.0.0.1:3000";
const REQUEST_ID = process.env.AI_REQUEST_ID ?? "";

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
