import "dotenv/config";
import fs from "node:fs/promises"
import path from "node:path"
import express from "express";
import cors from "cors";

const downloadsDir = path.join(process.cwd(), "downloads");
const app = express();


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
    try{
            const videoResponse = await fetch(video.url);
            if(!videoResponse.ok) {
                return response.status(502).json({ error: "Failed to fetch video" });
            }

            const buffer = Buffer.from(await videoResponse.arrayBuffer());
            const filename = `${Date.now()}.mp4`;
            const filePath = path.join(downloadsDir, filename);
            await fs.writeFile(filePath, buffer);
            return response.status(200).json({ message: "Video downloaded successfully", filename, filePath });
        } catch (error) {
            console.error(error);
            return response.status(500).json({ error: "Failed to download video" });
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

