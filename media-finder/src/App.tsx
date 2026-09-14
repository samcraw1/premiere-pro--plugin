import './App.css'
import  { useState } from 'react'

type Video = {
  id: number
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

  async function searchVideo() {
    if (query.trim() === "")
      return;

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=12`,
        { headers: { Authorization: import.meta.env.VITE_PEXELS_API_KEY } }
      )

      if (!response.ok) {
        throw new Error(`Pexels API error: ${response.status}`)
      }

      const data = await response.json()

      const results: Video[] = data.videos.map((video: any) => {
        const file = video.video_files.find((f: any) => f.quality === 'sd') ?? video.video_files[0]
        return {
          id: video.id,
          title: video.user?.name ? `Video by ${video.user.name}` : `Video ${video.id}`,
          url: file?.link ?? '',
          duration: video.duration,
          thumbnail: video.image,
        }
      })

      setVideos(results)
    } catch (err) {
      console.error(err)
      setError("Something went wrong fetching videos.")
      setVideos([])
    } finally {
      setIsLoading(false)
    }
  }

  function handleImport(video: Video) {
    console.log("Import clicked", video)
    setDownloadedVideos((currentVideos) => {
      if (currentVideos.some((v) => v.id === video.id)) {
        console.log("Video already imported", video)
        return currentVideos
      }
      return [...currentVideos, video]
    })
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

    {isLoading && <p>Loading videos...</p>}
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
          <button className="btn btn--primary" onClick={() => handleImport(previewVideo)}>Import</button>
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
            <button className="btn btn--primary" onClick={() => handleImport(video)}>Import</button>
          </div>
        </article>
      ))}
    </section>
  </main>
);
}

export default App
