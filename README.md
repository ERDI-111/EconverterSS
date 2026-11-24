# EconverterS — Drop a link. Get your file.

**EconverterS** is a premium, high-fidelity media converter designed with a dark graphite and electric violet aesthetic. It converts audio and video links (including YouTube and direct HTTP(S) links) and uploaded media files into **MP3 (192 kbps)** or **MP4 (up to 1080p Full HD)** while preserving original titles, capitalization, punctuation, and emoji.

---

## ✨ Features

- **Original Title Guarantee:** Preserves spaces, accents, special characters, and emoji with RFC 5987/6266 UTF-8 headers.
- **YouTube & Direct Link Support:** Powered by `yt-dlp` for YouTube audio/video stream extraction and FFmpeg for transcoding.
- **Direct File Uploads:** Drag-and-drop support for files up to 500 MB.
- **MP3 & MP4 Formats:**
  - **MP3 · Audio only:** High-fidelity 192 kbps master via `libmp3lame`.
  - **MP4 · Video:** Up to 1080p Full HD video with AAC audio, fast-start streaming, and lossless stream copying when source matches.
- **Session Privacy & Security:**
  - Session-bound downloads (`econverters_sid` cookie). Cross-session downloads return `403 Forbidden`.
  - Auto-cleanup: Input files are removed immediately; output files expire automatically in 30 minutes.
  - SSRF protection against private networks, localhost, link-local, and cloud metadata endpoints.
  - Per-IP rate limiting and concurrency management.
- **Animated Waveform Canvas:** Smooth ambient audio visualization behind the converter.
- **Privacy & Terms Pages:** Built-in legal and privacy documentation.

---

## 🚀 Quick Start

### Prerequisites

Ensure you have the following installed on your machine:

1. [Node.js](https://nodejs.org/) (v18+)
2. [FFmpeg](https://ffmpeg.org/) (available in system `PATH`)
3. [yt-dlp](https://github.com/yt-dlp/yt-dlp) (available in system `PATH` for YouTube conversion)

Verify prerequisites:
```bash
node --version
ffmpeg -version
yt-dlp --version
```

### Running Locally

```bash
# Clone the repository
git clone https://github.com/ERDI-111/EconverterSS.git
cd EconverterSS

# Start the server
node server.js
```

By default, the server runs on `http://localhost:3080`.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3080` | Port for the HTTP server |
| `STAGING_AUTH` | `true` | Enables HTTP Basic Auth (`false` to disable) |
| `STAGING_USER` | `econverters` | Basic Auth username |
| `STAGING_PASS` | `staging-access-2026` | Basic Auth password |
| `MAX_FILE_SIZE_MB` | `500` | Max upload / download file size |
| `JOB_DURATION_SEC` | `300` | FFmpeg/yt-dlp process timeout |
| `MAX_CONCURRENT_JOBS` | `2` | Max concurrent conversions |
| `DOWNLOAD_EXPIRY_MIN` | `30` | Minutes before downloads expire |

---

## 📜 License

MIT License © 2026 EconverterS.
