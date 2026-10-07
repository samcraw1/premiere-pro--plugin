import React from "react";
import { useState, useEffect, useRef } from "react";
import "./App.css";

const SERVER_URL = "http://localhost:3000";

const X_HOSTS = ["x.com", "twitter.com", "mobile.twitter.com", "t.co"]




// "x" for X/Twitter links, "tiktok" for TikTok, otherwise "youtube". Entries
// saved before sources existed have no `source`, so callers treat a missing
// value as "youtube".
// what if we add more social media sources in the future?

function detectSource(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok"
    return X_HOSTS.includes(host) ? "x" : host === "instagram.com" || host === "cdninstagram.com" || host === "fbcdn.net" ? "instagram" : "youtube"
  } catch {
    return "youtube"
  }
}

// "@handle – first words of the tweet" instead of the whole tweet text.
function xTitle(video) {
  const text = (video.description || video.title || "").replace(/\s+/g, " ").trim()
  const snippet = text.length > 60 ? `${text.slice(0, 60).trim()}…` : text
  const handle = video.uploaderId ? `@${video.uploaderId}` : (video.uploader || "X")
  return snippet ? `${handle} – ${snippet}` : handle
}

// "@handle – first words of the caption". TikTok's uploader_id is a long number;
// the readable handle is in `uploader`.
function tiktokTitle(video) {
  const text = (video.description || video.title || "").replace(/\s+/g, " ").trim()
  const snippet = text.length > 60 ? `${text.slice(0, 60).trim()}…` : text
  const handle = video.uploader ? `@${video.uploader}` : "TikTok"
  return snippet ? `${handle} – ${snippet}` : handle
}

// Badge text and CSS modifier per source (a missing source means YouTube).
const SOURCE_LABELS = {
  youtube: { text: "YT", modifier: "" },
  x: { text: "X", modifier: "x" },
  tiktok: { text: "TT", modifier: "tt" },
  instagram: { text: "IG", modifier: "ig" },
}

// URL lookups return .webp thumbnails, which UXP can't draw; swap to the jpg.
function toJpgThumbnail(url) {
  const match = url.match(/\/vi_webp\/([^/]+)\//)
  return match ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : url
}

// UXP's webview can't load YouTube thumbnail images cross-origin directly,
// so route them through the server's /thumbnail proxy.
function proxyThumbnail(video) {
  return {
    ...video,
    thumbnail: video.thumbnail
      ? `${SERVER_URL}/thumbnail?url=${encodeURIComponent(toJpgThumbnail(video.thumbnail))}`
      : '',
  }
}

const RECENT_KEY = "mediaFinder.recentVideos"
const RECENT_LIMIT = 50

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch (err) {
    console.error("Could not save recent videos", err)
  }
}

const AI_CHAT_KEY = "mediaFinder.aiChat"
const AI_CHAT_LIMIT = 50
const AI_HISTORY_TURNS = 6
const AI_QUESTION_MAX = 2000

// Proposals still pending from a previous session point at project state that
// may have changed, so they come back as "expired" with no buttons.
function loadAiChat() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CHAT_KEY))
    if (!Array.isArray(parsed)) return []
    return parsed.map((message) =>
      Array.isArray(message.proposals)
        ? {
            ...message,
            proposals: message.proposals.map((proposal) =>
              proposal.status === "pending" || proposal.status === "working"
                ? { ...proposal, status: "expired" }
                : proposal
            ),
          }
        : message
    )
  } catch {
    return []
  }
}

function saveAiChat(list) {
  try {
    localStorage.setItem(AI_CHAT_KEY, JSON.stringify(list))
  } catch (err) {
    console.error("Could not save AI chat", err)
  }
}

function newMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * @typedef {{ code: 400 | 401 | 403 | 404 | 409 | 500, message: string }} ErrorCodeForDebugging
 */

/** @returns {ErrorCodeForDebugging["code"]} */
function toErrorCode(status) {
  return [400, 401, 403, 404, 409].includes(status) ? status : 500
}

// Walks the bin tree under `folder`, returning a flat list labelled by path
// ("Footage / B-roll"). getItems() hands back plain ProjectItems, so each one
// has to be cast to a FolderItem to tell whether it's a bin and to recurse.
// The assistant is told to answer in plain text, but models slip. Render the
// bits of markdown that show up in short replies instead of printing raw
// asterisks: **bold**, `code`, # headings, "- " / "1." lists, line breaks.
function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.replace(/`/g, "")
  )
}

function renderAiText(text) {
  return String(text ?? "").split("\n").map((line, i) => {
    if (!line.trim()) return <div key={i} className="ai-gap" />
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (heading) return <div key={i}><strong>{renderInline(heading[1])}</strong></div>
    const item = line.match(/^\s*(?:[-*\u2022]|\d+[.)])\s+(.*)$/)
    if (item) return <div key={i} className="ai-item">{"\u2022 "}{renderInline(item[1])}</div>
    return <div key={i}>{renderInline(line)}</div>
  })
}

async function collectBins(premierepro, folder, prefix = "") {
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    let bin = null
    try {
      bin = premierepro.FolderItem.cast(item)
    } catch {
      bin = null
    }
    if (!bin) continue
    const name = prefix ? `${prefix} / ${item.name}` : item.name
    found.push({ id: item.guid?.toString() ?? name, name, item: bin })
    found.push(...(await collectBins(premierepro, bin, name)))
  }
  return found
}

// Names of every non-folder item in the project (clips, sequences, ...), with
// the bin each lives in, so the assistant can answer questions about them.
async function collectClips(premierepro, folder, prefix = "") {
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    let bin = null
    try {
      bin = premierepro.FolderItem.cast(item)
    } catch {
      bin = null
    }
    if (bin) {
      const name = prefix ? `${prefix} / ${item.name}` : item.name
      found.push(...(await collectClips(premierepro, bin, name)))
    } else {
      found.push({ name: item.name, bin: prefix })
    }
  }
  return found
}

// Resolves {name, bin} pairs (as listed by collectClips) back to live
// ProjectItems so they can be moved. Async, so it runs before any transaction.
async function findProjectItems(premierepro, folder, wanted, prefix = "") {
  const found = []
  const items = await folder.getItems()
  for (const item of items) {
    let bin = null
    try {
      bin = premierepro.FolderItem.cast(item)
    } catch {
      bin = null
    }
    if (bin) {
      const name = prefix ? `${prefix} / ${item.name}` : item.name
      found.push(...(await findProjectItems(premierepro, bin, wanted, name)))
    } else if (wanted.has(`${prefix}\u0000${item.name}`)) {
      found.push(item)
    }
  }
  return found
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function VideoRow({ video, importing, onPreview, onImport, onPreviewClip }) {
  const label = SOURCE_LABELS[video.source] ?? SOURCE_LABELS.youtube
  const detail = video.binName
    ? `${formatDuration(video.duration)} · ${video.binName}`
    : formatDuration(video.duration)
  return (
    <li className={`row${label.modifier ? ` row--${label.modifier}` : ""}`}>
      <div className="row-thumb-wrap" onClick={onPreview}>
        {video.thumbnail && (
          <img
            className="row-thumb"
            src={video.thumbnail}
            alt=""
            onError={(event) => { event.target.style.display = "none" }}
          />
        )}
      </div>
      <div className="row-main" onClick={onPreview}>
        <span className="row-title">{video.title}</span>
        <span className="row-meta">
          <span className={`badge${label.modifier ? ` badge--${label.modifier}` : ""}`}>{label.text}</span>
          {detail}
        </span>
      </div>
      {onPreviewClip && (
        <button className="btn btn--sm" onClick={onPreviewClip}>
          Preview
        </button>
      )}
      {onImport ? (
        <button className="btn btn--primary btn--sm" onClick={onImport} disabled={importing}>
          {importing ? "Importing…" : "Import"}
        </button>
      ) : (
        <span className="row-done" title="Imported">✓</span>
      )}
    </li>
  )
}

export const App = () => {

  const [query, setQuery] = useState('')
  const [videos, setVideos] = useState([])
  const [downloadedVideos, setDownloadedVideos] = useState(loadRecent)
  const [previewVideo, setPreviewVideo] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  /** @type {[ErrorCodeForDebugging | null, Function]} */
  const [error, setError] = useState(null)
  const [importingId, setImportingId] = useState(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [isFetchingUrlInfo, setIsFetchingUrlInfo] = useState(false)
  const [tab, setTab] = useState("results")
  const ytRef = useRef(null)
  const [ytHeight, setYtHeight] = useState(400)
  const aiAssistantRef = useRef(null)
  const [messages, setMessages] = useState(loadAiChat)
  const [isAiAssistantLoading, setIsAiAssistantLoading] = useState(false)
  const [aiQuestion, setAiQuestion] = useState("")

  useEffect(() => {
    saveAiChat(messages)
  }, [messages])

  // Keep the newest message in view.
  useEffect(() => {
    if (tab !== "ai assistant" || !aiAssistantRef.current) return
    aiAssistantRef.current.scrollTop = aiAssistantRef.current.scrollHeight
  }, [messages, isAiAssistantLoading, tab])
  

  // Fill the panel below the tab row, and follow panel resizes.
  useEffect(() => {
    if (tab !== "youtube") return
    const fit = () => {
      try {
        const top = ytRef.current.getBoundingClientRect().top
        const h = Math.floor(window.innerHeight - top)
        setYtHeight(Number.isFinite(h) && h >= 240 ? h : 400)
      } catch {
        setYtHeight(400)
      }
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [tab])
  const [bins, setBins] = useState([])
  const [selectedBinId, setSelectedBinId] = useState("")
  const [clip, setClip] = useState(null)
  const clipRef = useRef(null)

  async function loadBins() {
    try {
      const premierepro = require("premierepro")
      const project = await premierepro.Project.getActiveProject()
      if (!project) {
        setBins([])
        setError({ code: 404, message: "No active Premiere project - open a project first." })
        return
      }
      const root = await project.getRootItem()
      const found = await collectBins(premierepro, root)
      setBins(found)
      setSelectedBinId((current) => (found.some((b) => b.id === current) ? current : ""))
    } catch (err) {
      console.error(err)
      setBins([])
      setError({ code: 500, message: "Could not load project bins." })
    }
  }

  useEffect(() => {
    loadBins()
  }, [])

  useEffect(() => {
    saveRecent(downloadedVideos)
  }, [downloadedVideos])

  async function searchVideo() {
    if (query.trim() === "")
      return;

    setIsLoading(true)
    setError(null)
    setTab("results")
    setVideos([])
    let code = 500

    try {
      const response = await fetch(
        `${SERVER_URL}/search?term=${encodeURIComponent(query)}`
      )

      if (!response.ok) {
        code = toErrorCode(response.status)
        throw new Error(`Search request failed: ${response.status}`)
      }

      const data = await response.json()

      setVideos(data.results.map((v) => ({ ...proxyThumbnail(v), source: "youtube" })))
      setTab("results")
    } catch (err) {
      console.error(err)
      setError({ code, message: "Something went wrong fetching videos." })
      setVideos([])
    } finally {
      setIsLoading(false)
    }
  }

  async function openPreview(video) {
    setClip({ video, status: "loading", url: ""})
    try{
      const response = await fetch(`${SERVER_URL}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: video.url, id: video.id }),
      })
      if (!response.ok) throw new Error(`Preview request failed: ${response.status}`)
        const data = await response.json()
      setClip({ video, status: "ready", url: data.previewUrl })
    } catch (err) {
      console.error(err)
      setClip({ video, status: "error", url: "" })
    }
  }

  async function handleImport(video, binId = selectedBinId) {
    if (downloadedVideos.some((v) => v.id === video.id)) {
      console.log("Video already imported", video)
      return true
    }

    setImportingId(video.id)
    setError(null)
    let code = 500
    let message = "Failed to download video."

    try {
      const response = await fetch(`${SERVER_URL}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: video.url, title: video.title }),
      })

      if (!response.ok) {
        code = toErrorCode(response.status)
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error ?? `Download failed: ${response.status}`)
      }

      // UXP's fetch doesn't deliver streaming/chunked response bodies
      // incrementally, so unlike the browser prototype, we can't read
      // live progress here — just wait for the whole NDJSON response
      // and parse it once it's fully arrived.
      const text = await response.text()
      const lines = text.split("\n").filter((line) => line.trim())
      let result = null

      for (const line of lines) {
        const message = JSON.parse(line)
        if (message.type === "done") {
          result = message
        } else if (message.type === "error") {
          throw new Error(message.message)
        }
      }

      if (!result) {
        throw new Error("Download did not complete")
      }

      console.log("Downloaded to", result.filePath)
      const binName = bins.find((b) => b.id === binId)?.name ?? "Project root"
      setDownloadedVideos((currentVideos) =>
        [{ ...video, url: result.filePath, binName }, ...currentVideos].slice(0, RECENT_LIMIT)
      )
      message = "Downloaded, but importing into Premiere failed."
      const premierepro = require("premierepro")
      const project = await premierepro.Project.getActiveProject()
      if(!project){
        code = 404
        throw new Error("no active premiere pro project - open a project first")
      }
      // null target bin = project root
      const targetBin = bins.find((b) => b.id === binId)?.item ?? null
      await project.importFiles([result.filePath], true, targetBin, false)
      return true
    } catch (err) {
      console.error(err)
      setError({ code, message })
      return false
    } finally {
      setImportingId(null)
    }
  }

  async function handlePasteYoutubeUrl() {
    const pastedUrl = youtubeUrl.trim()

    if (!pastedUrl) {
      setError({ code: 400, message: "Please paste a YouTube URL." })
      return
    }

    setError(null)
    setTab("results")
    setIsFetchingUrlInfo(true)
    let code = 500

    try {
      const response = await fetch(
        `${SERVER_URL}/url-info?url=${encodeURIComponent(pastedUrl)}`
      )

      if (!response.ok) {
        code = toErrorCode(response.status)
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error ?? `Could not fetch video info: ${response.status}`)
      }

      const video = await response.json()

      const source = detectSource(pastedUrl)
      const item = {
        ...proxyThumbnail(video),
        source,
        ...(source === "x" ? { title: xTitle(video) } : {}),
        ...(source === "tiktok" ? { title: tiktokTitle(video) } : {}),
      }
      setVideos((current) => [item, ...current.filter((v) => v.id !== item.id)])
      setTab("results")
      setYoutubeUrl("")
    } catch (err) {
      console.error(err)
      setError({ code, message: "Failed to fetch info for the pasted URL." })
    } finally {
      setIsFetchingUrlInfo(false)
    }
  }

  // Proposals name a bin by text; fall back to the bin picked in the panel.
  function binIdForProposal(proposal) {
    const wanted = (proposal.binName ?? "").trim().toLowerCase()
    return bins.find((b) => b.name.toLowerCase() === wanted)?.id ?? selectedBinId
  }

  function setProposalStatus(messageId, index, status) {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, proposals: message.proposals.map((p, i) => (i === index ? { ...p, status } : p)) }
          : message
      )
    )
  }

  async function confirmMove(messageId, index, proposal) {
    setProposalStatus(messageId, index, "working")
    setError(null)
    let code = 500
    let message = "Could not move items."

    try {
      const premierepro = require("premierepro")
      const project = await premierepro.Project.getActiveProject()
      if (!project) {
        code = 404
        throw new Error("no active premiere pro project - open a project first")
      }
      const root = await project.getRootItem()

      const wanted = new Set(proposal.items.map((item) => `${item.bin}\u0000${item.name}`))
      const matches = await findProjectItems(premierepro, root, wanted)
      if (matches.length === 0) {
        code = 404
        message = "Those items are no longer in the project."
        throw new Error("no matching project items")
      }

      const findTarget = async () =>
        (await collectBins(premierepro, root)).find(
          (b) => b.name.toLowerCase() === proposal.targetBin.toLowerCase()
        )

      let target = await findTarget()
      if (!target) {
        // Transaction callbacks must be synchronous, so create the bin first,
        // then look it up again before moving anything into it.
        project.lockedAccess(() => {
          project.executeTransaction((compound) => {
            compound.addAction(root.createBinAction(proposal.targetBin, true))
          }, "Create bin")
        })
        target = await findTarget()
        if (!target) throw new Error("bin was not created")
      }

      message = "Created the bin, but moving items failed."
      project.lockedAccess(() => {
        project.executeTransaction((compound) => {
          for (const item of matches) {
            const action = root.createMoveItemAction(item, target.item)
            if (action) compound.addAction(action)
          }
        }, "Move items to bin")
      })

      setProposalStatus(messageId, index, "done")
      await loadBins()
    } catch (err) {
      console.error(err)
      setProposalStatus(messageId, index, "pending")
      setError({ code, message })
    }
  }

  async function confirmProposal(messageId, index, proposal) {
    setProposalStatus(messageId, index, "working")
    const ok = await handleImport(
      { id: proposal.id, title: proposal.title, url: proposal.url, duration: proposal.duration ?? 0, thumbnail: proposal.thumbnail ?? "" },
      binIdForProposal(proposal)
    )
    setProposalStatus(messageId, index, ok ? "done" : "pending")
  }

  async function handleAiAssistantSearch(search) {
    const question = search.trim()
    if (!question || isAiAssistantLoading) return

    // Earlier turns only; the new question goes in separately.
    const history = messages
      .filter((message) => !message.error)
      .slice(-AI_HISTORY_TURNS)
      .map((message) => ({ role: message.role, text: message.text.slice(0, 1000) }))

    setMessages((current) =>
      [...current, { id: newMessageId(), role: "user", text: question }].slice(-AI_CHAT_LIMIT)
    )
    setAiQuestion("")
    setIsAiAssistantLoading(true)

    let clips = []
    try {
      const premierepro = require("premierepro")
      const project = await premierepro.Project.getActiveProject()
      if (project) clips = await collectClips(premierepro, await project.getRootItem())
    } catch (err) {
      console.error("Could not read project clips", err)
    }

    try {
      const response = await fetch(`${SERVER_URL}/ai-assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionForAi: question, bins: bins.map((b) => b.name), clips, history }),
      })

      if(!response.ok){
        throw new Error(`AI Assistant search failed: ${response.status}`)
      }
      const aiAssistantData = await response.json()
      setMessages((current) =>
        [
          ...current,
          {
            id: newMessageId(),
            role: "assistant",
            text: aiAssistantData.answer,
            proposals: (aiAssistantData.proposals ?? []).map((proposal) => ({ ...proposal, status: "pending" })),
          },
        ].slice(-AI_CHAT_LIMIT)
      )
    } catch (err) {
      console.error(err)
      setMessages((current) =>
        [...current, { id: newMessageId(), role: "assistant", text: "Something went wrong. Try again.", error: true }].slice(-AI_CHAT_LIMIT)
      )
    } finally {
      setIsAiAssistantLoading(false)
    }
  }

  function renderProposal(messageId, proposal, index) {
    const isMove = proposal.type === "move"
    const status = proposal.status ?? "pending"
    const statusLabel = { working: "Working…", done: "Done", dismissed: "Dismissed", expired: "Expired" }[status]
    return (
      <div className={`ai-proposal${statusLabel ? " ai-proposal--resolved" : ""}`} key={`${proposal.type}-${index}`}>
        <div className="ai-proposal-text">
          <span className="ai-proposal-title">
            {isMove
              ? `Move ${proposal.items.length} item${proposal.items.length === 1 ? "" : "s"} into "${proposal.targetBin}"`
              : proposal.title}
          </span>
          <span className="ai-proposal-bin">
            {isMove
              ? `${proposal.items.slice(0, 3).map((item) => item.name).join(", ")}${proposal.items.length > 3 ? ` +${proposal.items.length - 3} more` : ""}`
              : `Import into: ${bins.find((b) => b.id === binIdForProposal(proposal))?.name ?? "Project root"}`}
          </span>
        </div>
        {statusLabel ? (
          <span className="ai-proposal-status">{statusLabel}</span>
        ) : (
          <>
            <button
              className="btn"
              disabled={!isMove && importingId !== null}
              onClick={() => (isMove ? confirmMove(messageId, index, proposal) : confirmProposal(messageId, index, proposal))}
            >
              Confirm
            </button>
            <button className="btn" onClick={() => setProposalStatus(messageId, index, "dismissed")}>Dismiss</button>
          </>
        )}
      </div>
    )
  }

  const alreadyImported = (video) => downloadedVideos.some((v) => v.id === video.id)

  return (
  <main className="panel">
    <header className="header">
      <h1>Media Finder</h1>

      <div className="search-row">
        <input
          className="search-input"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search for a video"
        />
        <button className="btn btn--primary" onClick={searchVideo} disabled={isLoading}>
          {isLoading ? "Searching…" : "Search"}
        </button>
      </div>

      <div className="search-row">
        <input
          className="search-input"
          type="text"
          value={youtubeUrl}
          onChange={(event) => setYoutubeUrl(event.target.value)}
          placeholder="…or paste a YouTube, X or TikTok URL"
        />
        <button className="btn" onClick={handlePasteYoutubeUrl} disabled={isFetchingUrlInfo}>
          {isFetchingUrlInfo ? "Fetching…" : "Paste"}
        </button>
      </div>

      <div className="bin-row">
        <label className="label" htmlFor="bin-select">Import into</label>
        <div className="search-row">
          <select
            id="bin-select"
            className="select"
            value={selectedBinId}
            onChange={(event) => setSelectedBinId(event.target.value)}
          >
            <option value="">Project root</option>
            {bins.map((bin) => (
              <option key={bin.id} value={bin.id}>{bin.name}</option>
            ))}
          </select>
          <button className="btn" onClick={loadBins}>Refresh</button>
        </div>
      </div>
      <div className="tabs">
        <button className={`tab${tab === "results" ? " tab--active" : ""}`} onClick={() => setTab("results")}>
          Results ({videos.length})
        </button>
        <button className={`tab${tab === "recent" ? " tab--active" : ""}`} onClick={() => setTab("recent")}>
          Recent ({downloadedVideos.length})
        </button>
        <button className={`tab${tab === "youtube" ? " tab--active" : ""}`} onClick={() => setTab("youtube")}>
          YouTube
        </button>
        <button className={`tab${tab === "ai assistant" ? " tab--active" : ""}`} onClick={() => setTab("ai assistant")}>
          AI Assistant
        </button> 
      </div>
    </header>

    {(isLoading || isFetchingUrlInfo) && (
      <div className="loading-box">
        <img className="loading-gif" src={isLoading ? "searching.gif" : "fetching.gif"} alt="" />
        <p className="loading">{isLoading ? "Searching YouTube…" : "Fetching video info…"}</p>
      </div>
    )}
    {error && (
      <p className="banner"><strong>Error {error.code}</strong> {error.message}</p>
    )}

    {previewVideo && (
      <section className="preview">
        {previewVideo.thumbnail && (
          <img className="preview-thumb" src={previewVideo.thumbnail} alt={previewVideo.title} />
        )}
        <h3 className="preview-title">{previewVideo.title}</h3>
        <p className="row-meta">{formatDuration(previewVideo.duration)}</p>
        <div className="preview-actions">
          <button
            className="btn btn--primary"
            onClick={() => handleImport(previewVideo)}
            disabled={importingId === previewVideo.id || alreadyImported(previewVideo)}
          >
            {importingId === previewVideo.id ? "Importing…" : alreadyImported(previewVideo) ? "Imported" : "Import"}
          </button>
          <button className="btn" onClick={() => setPreviewVideo(null)}>Close</button>
        </div>
      </section>
    )}

    {tab === "results" && (
      videos.length > 0 ? (
        <ul className="list">
          {videos.map((video) => (
            <VideoRow
              key={video.id}
              video={alreadyImported(video) ? downloadedVideos.find((v) => v.id === video.id) : video}
              importing={importingId === video.id}
              onPreview={() => setPreviewVideo(video)}
              onPreviewClip={() => openPreview(video)}
              onImport={alreadyImported(video) ? null : () => handleImport(video)}
            />
          ))}
        </ul>
      ) : (
        !isLoading && !isFetchingUrlInfo && <p className="status">No results yet. Search or paste a URL.</p>
      )
    )}
    
    {tab === "ai assistant" && (
      <section>
        <div className="ai-chat">
          <div className="ai-log" ref={aiAssistantRef}>
            {messages.length === 0 && !isAiAssistantLoading && (
              <p className="status">Ask about your project, or tell me what to find and import.</p>
            )}
            {messages.map((message) => (
              <div key={message.id} className={`ai-msg ai-msg--${message.role}${message.error ? " ai-msg--error" : ""}`}>
                <div className="ai-bubble">
                  {message.role === "assistant" ? renderAiText(message.text) : message.text}
                </div>
                {(message.proposals ?? []).map((proposal, index) => renderProposal(message.id, proposal, index))}
              </div>
            ))}
            {isAiAssistantLoading && (
              <div className="ai-msg ai-msg--assistant">
                <div className="ai-bubble ai-bubble--thinking">Thinking…</div>
              </div>
            )}
          </div>
          <div className="ai-input-row">
            <input
              type="text"
              placeholder="Ask the AI Assistant"
              maxLength={AI_QUESTION_MAX}
              value={aiQuestion}
              disabled={isAiAssistantLoading}
              onChange={(e) => setAiQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleAiAssistantSearch(aiQuestion)
                }
              }}
            />
            <button
              className="btn"
              disabled={isAiAssistantLoading || !aiQuestion.trim()}
              onClick={() => handleAiAssistantSearch(aiQuestion)}
            >
              Send
            </button>
          </div>
          {messages.length > 0 && (
            <button className="btn ai-clear" onClick={() => setMessages([])}>Clear chat</button>
          )}
        </div>
      </section>
    )}

    {tab === "youtube" && (
      <webview
        ref={ytRef}
        src="https://www.youtube.com"
        style={{ display: "block", width: "auto", height: "500px", margin: "0 -10px -10px" }}
      ></webview>
    )}

    {tab === "recent" && (
      downloadedVideos.length > 0 ? (
        <section>
          <div className="section-head">
            <span className="label">Newest first</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setDownloadedVideos([])}>Clear</button>
          </div>
          <ul className="list">
            {downloadedVideos.map((video) => (
              <VideoRow key={video.id} video={video} onPreview={() => setPreviewVideo(video)} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="status">Nothing imported yet.</p>
      )
    )}
    {clip && (
      <div className="overlay">
        <div className="overlay-card">
          <h3 className="preview-title">{clip.video.title}</h3>

          {clip.status === "loading" && (
            <div className="loading-box">
              <img className="loading-gif" src="searching.gif" alt="" />
              <p className="loading">Making preview…</p>
            </div>
          )}

          {clip.status === "error" && (
            <p className="banner"><strong>Error</strong> Couldn't make a preview.</p>
          )}

          {clip.status === "ready" && (
            <>
              <video ref={clipRef} width="300" height="170" autoPlay src={clip.url}></video>
              <div className="search-row">
                <button className="btn btn--sm" onClick={() => clipRef.current.play()}>Play</button>
                <button className="btn btn--sm" onClick={() => clipRef.current.pause()}>Pause</button>
              </div>
            </>
          )}

          <p className="row-meta">{formatDuration(clip.video.duration)}</p>
          <div className="preview-actions">
            <button
              className="btn btn--primary"
              onClick={() => handleImport(clip.video)}
              disabled={importingId === clip.video.id || alreadyImported(clip.video)}
            >
              {importingId === clip.video.id ? "Importing…" : alreadyImported(clip.video) ? "Imported" : "Import"}
            </button>
            <button className="btn" onClick={() => setClip(null)}>Close</button>
          </div>
        </div>
      </div>
    )}
  </main>
);
}
  