import './App.css'
import  { useState } from 'react'

type Video = {
  id: string
  title: string
  url: string
  duration: number
  thumbnail: string
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function App() {

  const [query, setQuery] = useState('')
  const [videos, setVideos] = useState<Video[]>([])
  const [downloadedVideos, setDownloadedVideos] = useState<Video[]>([])
  const [previewVideo, setPreviewVideo] = useState<Video | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<number | null>(null)
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [isFetchingUrlInfo, setIsFetchingUrlInfo] = useState(false)
 

  async function searchVideo() {
    if (query.trim() === "")
      return;

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `http://localhost:3000/search?term=${encodeURIComponent(query)}`
      )

      if (!response.ok) {
        throw new Error(`Search request failed: ${response.status}`)
      }

      const data = await response.json()

      setVideos(data.results as Video[])
    } catch (err) {
      console.error(err)
      setError("Something went wrong fetching videos.")
      setVideos([])
    } finally {
      setIsLoading(false)
    }
  }

  async function handleImport(video: Video) {
    if (downloadedVideos.some((v) => v.id === video.id)) {
      console.log("Video already imported", video)
      return
    }

    setImportingId(video.id)
    setImportProgress(0)
    setError(null)

    try {
      const response = await fetch("http://localhost:3000/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: video.url }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error ?? `Download failed: ${response.status}`)
      }

      if (!response.body) {
        throw new Error("Download response had no body")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let result: { filename: string; filePath: string } | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          const message = JSON.parse(line)

          if (message.type === "progress") {
            setImportProgress(message.percent)
          } else if (message.type === "converting") {
            setImportProgress(null)
          } else if (message.type === "done") {
            result = message
          } else if (message.type === "error") {
            throw new Error(message.message)
          }
        }
      }

      if (!result) {
        throw new Error("Download did not complete")
      }

      console.log("Downloaded to", result.filePath)
      setDownloadedVideos((currentVideos) => [...currentVideos, { ...video, url: result!.filePath }])
    } catch (err) {
      console.error(err)
      setError("Failed to download video.")
    } finally {
      setImportingId(null)
      setImportProgress(null)
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
        `http://localhost:3000/url-info?url=${encodeURIComponent(pastedUrl)}`
      )

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error ?? `Could not fetch video info: ${response.status}`)
      }

      const video: Video = await response.json()
      setPreviewVideo(video)
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
            {importingId === previewVideo.id
              ? (importProgress !== null ? `Importing... ${importProgress}%` : "Converting...")
              : "Import"}
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

    <p>Videos loaded: {videos.length}</p>

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
              {importingId === video.id
                ? (importProgress !== null ? `Importing... ${importProgress}%` : "Converting...")
                : "Import"}
            </button>
          </div>
        </article>
      ))}
    </section>
  </main>
);
}

export default App
