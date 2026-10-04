import React from "react";
import { useState, useEffect } from "react";
import "./App.css";

const SERVER_URL = "http://localhost:3000";

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

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
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
  const [bins, setBins] = useState([])
  const [selectedBinId, setSelectedBinId] = useState("")

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

      // UXP's webview can't load YouTube thumbnail images cross-origin
      // directly, so route them through the server's /thumbnail proxy.
      const results = data.results.map((video) => ({
        ...video,
        thumbnail: video.thumbnail ? `${SERVER_URL}/thumbnail?url=${encodeURIComponent(video.thumbnail)}` : '',
      }))

      setVideos(results)
    } catch (err) {
      console.error(err)
      setError({ code, message: "Something went wrong fetching videos." })
      setVideos([])
    } finally {
      setIsLoading(false)
    }
  }

  async function handleImport(video) {
    if (downloadedVideos.some((v) => v.id === video.id)) {
      console.log("Video already imported", video)
      return
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
      setDownloadedVideos((currentVideos) =>
        [{ ...video, url: result.filePath }, ...currentVideos].slice(0, RECENT_LIMIT)
      )
      message = "Downloaded, but importing into Premiere failed."
      const premierepro = require("premierepro")
      const project = await premierepro.Project.getActiveProject()
      if(!project){
        code = 404
        throw new Error("no active premiere pro project - open a project first")
      }
      // null target bin = project root
      const targetBin = bins.find((b) => b.id === selectedBinId)?.item ?? null
      await project.importFiles([result.filePath], true, targetBin, false)
    } catch (err) {
      console.error(err)
      setError({ code, message })
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

      // Same as searchVideo - UXP's webview can't load YouTube thumbnails
      // cross-origin directly, so route it through the /thumbnail proxy.
      setPreviewVideo({
        ...video,
        thumbnail: video.thumbnail ? `${SERVER_URL}/thumbnail?url=${encodeURIComponent(video.thumbnail)}` : '',
      })
      setYoutubeUrl("")
    } catch (err) {
      console.error(err)
      setError({ code, message: "Failed to fetch info for the pasted URL." })
    } finally {
      setIsFetchingUrlInfo(false)
    }
  }

  return (
  <main className="panel">
    <h1>Media Finder</h1>

    <div className="search-row">
      <input
      className="search-input"
      type="text"
      value={query}
      onChange={(event) => setQuery(event.target.value)}

      placeholder="search for a video"
    />

    <button className="btn" onClick={searchVideo}>
      Search
    </button>
    </div>

    <p>or</p>

    <div className="search-row">
      <input
      className="search-input"
      type="text"
      value={youtubeUrl}
      onChange={(event) => setYoutubeUrl(event.target.value)}

      placeholder="paste a youtube url"
    />

    <button className="btn" onClick={handlePasteYoutubeUrl}>
      Paste
    </button>
    </div>

    <div className="search-row">
      <label htmlFor="bin-select">Import into:</label>
      <select
        id="bin-select"
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

    {isLoading && <p>Loading videos...</p>}
    {isFetchingUrlInfo && <p>Fetching video info...</p>}
    {error && <p>Error {error.code}: {error.message}</p>}

    {previewVideo && (
      <section className="preview">
        <h2>Preview</h2>
        <h3>{previewVideo.title}</h3>
        <img
          className="thumb"
          src={previewVideo.thumbnail}
          alt={previewVideo.title}
        />
        <p>Duration: {formatDuration(previewVideo.duration)}</p>
        <div className="preview-actions">
          <button className="btn btn--primary" onClick={() => handleImport(previewVideo)} disabled={importingId === previewVideo.id}>
            {importingId === previewVideo.id ? "Importing..." : "Import"}
          </button>
          <button className="btn" onClick={() => setPreviewVideo(null)}>Close Preview</button>
        </div>
      </section>
    )}

    <h2>Recently Added Videos</h2>
    {downloadedVideos.length > 0 && (
      <button className="btn" onClick={() => setDownloadedVideos([])}>Clear</button>
    )}
    <section className="grid">
      {downloadedVideos.map((video) => (
        <article className="card" key={video.id}>
          <h3> {video.title}</h3>
          <img
            className="thumb"
            src={video.thumbnail}
            alt={video.title}
          />
          <p>Duration: {formatDuration(video.duration)}</p>
        </article>
      ))}

    </section>

    <section className="grid">
      {videos.map((video) => (
        <article className="card" key={video.id}>
          <h3>{video.title}</h3>

          <img
            className="thumb"
            src={video.thumbnail}
            alt={video.title}
          />

          <p>Duration: {formatDuration(video.duration)}</p>
          <div className="card-actions">
            <button className="btn" onClick={() => setPreviewVideo(video)}>Preview</button>
            <button className="btn btn--primary" onClick={() => handleImport(video)} disabled={importingId === video.id}>
              {importingId === video.id ? "Importing..." : "Import"}
            </button>
          </div>
        </article>
      ))}
    </section>
  </main>
);
}
