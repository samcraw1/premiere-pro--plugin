import React from "react";
import { useState } from "react";
import "./App.css";

const SERVER_URL = "http://localhost:3000";

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export const App = () => {

  const [query, setQuery] = useState('')
  const [videos, setVideos] = useState([])
  const [downloadedVideos, setDownloadedVideos] = useState([])
  const [previewVideo, setPreviewVideo] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [importingId, setImportingId] = useState(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [isFetchingUrlInfo, setIsFetchingUrlInfo] = useState(false)

  async function searchVideo() {
    if (query.trim() === "")
      return;

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `${SERVER_URL}/search?term=${encodeURIComponent(query)}`
      )

      if (!response.ok) {
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
      setError("Something went wrong fetching videos.")
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

    try {
      const response = await fetch(`${SERVER_URL}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: video.url }),
      })

      if (!response.ok) {
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
      setDownloadedVideos((currentVideos) => [...currentVideos, { ...video, url: result.filePath }])
      const premierepro = require("premierepro")
      const project = await premierepro.Project.getActiveProject()
      if(!project){
        throw new Error("no active premiere pro project - open a project first")
      }
      await project.importFiles([result.filePath], true, null, false)
    } catch (err) {
      console.error(err)
      setError("Failed to download video.")
    } finally {
      setImportingId(null)
    }
  }

  async function handlePasteYoutubeUrl() {
    const pastedUrl = youtubeUrl.trim()

    if (!pastedUrl) {
      setError("Please paste a YouTube URL.")
      return
    }

    setError(null)
    setIsFetchingUrlInfo(true)

    try {
      const response = await fetch(
        `${SERVER_URL}/url-info?url=${encodeURIComponent(pastedUrl)}`
      )

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error ?? `Could not fetch video info: ${response.status}`)
      }

      const video = await response.json()

      // UXP's webview can't load YouTube thumbnail images cross-origin
      // directly, so route them through the server's /thumbnail proxy.
      setPreviewVideo({
        ...video,
        thumbnail: video.thumbnail ? `${SERVER_URL}/thumbnail?url=${encodeURIComponent(video.thumbnail)}` : '',
      })
      setYoutubeUrl("")
    } catch (err) {
      console.error(err)
      setError("Failed to fetch info for the pasted URL.")
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

      placeholder="Search for a video"
    />

    <button className="btn" onClick={searchVideo}>
      Search
    </button>
    </div>

    <text> or </text>

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

    {isLoading && <p>Loading videos...</p>}
    {isFetchingUrlInfo && <p>Fetching video info...</p>}
    {error && <p>{error}</p>}

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
