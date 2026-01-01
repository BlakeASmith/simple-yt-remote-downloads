# YouTube Download Server

A simplified YouTube downloader server using Bun and yt-dlp. Accepts HTTP POST requests to trigger video downloads in the background.

## Features

- Download YouTube videos with thumbnails and subtitles
- Audio-only download option (MP3)
- Resolution selection (1080p or 720p)
- Embedded subtitles for VLC compatibility
- Duplicate download prevention
- Simple web interface
- Fire-and-forget background downloads

## Quick Start

### Build the Docker Image

```bash
docker build -t youtube-dl-server .
```

### Run the Container

```bash
docker run -d \
  --name youtube-dl \
  -p 8080:80 \
  -v /path/to/your/downloads:/downloads \
  youtube-dl-server
```

Replace `/path/to/your/downloads` with your desired download directory.

## Usage

### Web Interface

Open your browser to `http://localhost:8080` (or your configured port) to access the web interface.

### API

#### Start Download

**POST** `/api/download`

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "path": "optional/subfolder",
  "audioOnly": false,
  "resolution": "1080"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | YouTube URL or video ID |
| `path` | string | No | Subfolder path relative to downloads root |
| `audioOnly` | boolean | No | Download audio only as MP3 (default: false) |
| `resolution` | string | No | Video resolution: "1080" or "720" (default: "1080") |

**Response (202 Accepted):**

```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "message": "Download started"
}
```

**Response (409 Conflict):**

```json
{
  "success": false,
  "videoId": "dQw4w9WgXcQ",
  "message": "Video has already been downloaded"
}
```

### Example cURL Commands

Download video at 1080p:

```bash
curl -X POST http://localhost:8080/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

Download audio only:

```bash
curl -X POST http://localhost:8080/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "audioOnly": true}'
```

Download to specific folder:

```bash
curl -X POST http://localhost:8080/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "path": "music/favorites"}'
```

## Configuration

Downloads are stored in `/downloads` inside the container. Mount your desired host directory to this path.

The server listens on port `80` inside the container - map it to your preferred host port.

## Docker Compose Example

```yaml
version: '3'
services:
  youtube-dl:
    build: .
    ports:
      - "8080:80"
    volumes:
      - ./downloads:/downloads
    restart: unless-stopped
```

## Output Files

Downloads include:

- **Video**: MKV format with embedded subtitles and thumbnail
- **Audio**: MP3 format (when `audioOnly: true`)
- **Thumbnail**: Downloaded alongside video
- **Subtitles**: Auto-generated English subtitles embedded in video

Files are named: `{title} [{video_id}].{ext}`

## Security Notice

This server provides no authentication. It is designed for local network use only. Do not expose to the public internet. Use a VPN like Tailscale for remote access.

## Development

### Prerequisites

- [Bun](https://bun.sh) installed locally

### Run Locally

```bash
# Install dependencies
bun install

# Start development server
bun run dev
```

### Build Binary

```bash
bun run build
```

## Future Plans

- Playlist support
- Channel downloads
- Download progress tracking
- Additional format options
