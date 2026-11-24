# EconverterS — Deployment & Operations Guide

> **Status**: Staging (password-protected). Do not share the URL or credentials publicly before the public launch is approved.

---

## 1. Prerequisites

| Requirement | Version Confirmed |
|---|---|
| Node.js | 18+ |
| FFmpeg + FFprobe | Available on `PATH` (v9.0.2 verified) |
| OS | Windows (PowerShell) or Linux |

Verify before deploying:
```powershell
node --version
ffmpeg -version
ffprobe -version
```

---

## 2. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3080` | HTTP port the server listens on |
| `STAGING_AUTH` | `true` | Set to `false` to disable HTTP Basic Auth (do NOT do this in staging) |
| `STAGING_USER` | `econverters` | Basic Auth username |
| `STAGING_PASS` | `staging-access-2026` | Basic Auth password |
| `MAX_FILE_SIZE_MB` | `500` | Maximum upload size in MB |
| `JOB_DURATION_SEC` | `120` | FFmpeg conversion timeout per job in seconds |
| `MAX_CONCURRENT_JOBS` | `2` | Maximum simultaneous FFmpeg workers |
| `DOWNLOAD_EXPIRY_MIN` | `30` | Minutes before converted output is auto-deleted |
| `MAX_QUEUE_SIZE` | `10` | Max jobs that can be queued + running. Set to `0` to pause new conversions immediately. |
| `RATE_LIMIT_MAX` | `5` | Max new conversion jobs per IP per rate-limit window |
| `RATE_LIMIT_WINDOW_MIN` | `10` | Rate-limit sliding window in minutes |

---

## 3. Starting the Server

```powershell
# From the project directory
cd C:\Users\erdis\.gemini\antigravity\scratch\econverters

# Start with default settings
node server.js

# Start with custom limits
$env:PORT = "3080"
$env:MAX_FILE_SIZE_MB = "250"
$env:MAX_CONCURRENT_JOBS = "2"
$env:DOWNLOAD_EXPIRY_MIN = "30"
node server.js
```

The server prints:
```
EconverterS staging server running at http://localhost:3080
Staging protection active: User "econverters"
Limits: Max Upload 500 MB | Timeout 120s | Concurrency 2 | Expiry 30m
```

---

## 4. Stopping the Server

```powershell
# Kill all Node.js processes (use with care if other Node apps are running)
Stop-Process -Name node -Force

# Or find the specific PID first:
Get-Process node | Select-Object Id, StartTime
Stop-Process -Id <PID> -Force
```

---

## 5. Pausing New Conversions (without stopping the server)

Set `MAX_QUEUE_SIZE=0` and restart the server. All new `/api/convert` requests immediately return:

```json
{ "success": false, "busyQueue": true, "error": "EconverterS is busy. Try again in a few minutes." }
```

```powershell
$env:MAX_QUEUE_SIZE = "0"
node server.js
```

To re-enable, restart with the normal `MAX_QUEUE_SIZE` (or omit it to use the default of 10).

---

## 6. Rollback Procedure

### Using Git

```powershell
# Check commit history
git log --oneline -10

# Roll back to a specific commit (non-destructive: creates new state)
git checkout <commit-hash> -- server.js app.js index.html style.css

# Clear temporary files from the old run
Remove-Item "tmp\uploads\*" -Force -ErrorAction SilentlyContinue
Remove-Item "tmp\outputs\*" -Force -ErrorAction SilentlyContinue

# Restart the server
node server.js
```

> **Note**: Jobs are stored in memory. Restarting the server clears all in-progress or completed jobs. Any pending downloads will be lost.

---

## 7. Checking Admin Stats

The `/api/admin/stats` endpoint (requires staging auth) returns:

```
GET http://localhost:3080/api/admin/stats
Authorization: Basic <base64 of econverters:staging-access-2026>
```

Response:
```json
{
  "failedJobs": 0,
  "completedJobs": 12,
  "peakQueueLength": 3,
  "currentQueueLength": 1,
  "currentWorkers": 2,
  "diskUsageMB": 14.5,
  "rateLimit": { "maxPerWindow": 5, "windowMinutes": 10 },
  "maxQueueSize": 10
}
```

> No filenames, URLs, or session IDs are included in this response.

---

## 8. Temporary File Locations

| Path | Contents | Auto-cleaned |
|---|---|---|
| `tmp/uploads/` | Raw uploaded files and downloaded link sources | Input files deleted after job. Orphaned files cleaned every 30s. |
| `tmp/outputs/` | FFmpeg-converted output files | Deleted 30 minutes after job completes. |

Manual cleanup (e.g. after a crash):
```powershell
Remove-Item "tmp\uploads\*" -Force -ErrorAction SilentlyContinue
Remove-Item "tmp\outputs\*" -Force -ErrorAction SilentlyContinue
```

---

## 9. Pre-Deploy Checklist

Before each deployment:

- [ ] `node --version` → 18+
- [ ] `ffmpeg -version` → available on PATH
- [ ] `ffprobe -version` → available on PATH
- [ ] Environment variables set correctly (staging credentials unchanged)
- [ ] `tmp/uploads/` and `tmp/outputs/` directories writable
- [ ] Server starts and prints correct limits
- [ ] `GET /api/admin/stats` returns valid JSON
- [ ] Upload `sample-video.mov` → MP3 conversion completes and downloads correctly
- [ ] Upload `sample-video.mov` → MP4 conversion completes and downloads correctly
- [ ] Cross-session isolation: Session B cannot download Session A's job (HTTP 403)
- [ ] Expired job returns HTTP 410

---

## 10. What Still Needs Manual Verification Before Public Launch

| Item | Status |
|---|---|
| Domain registration | Not started — no domain registered yet |
| DNS configuration | Blocked by domain |
| HTTPS / TLS certificate | Blocked by domain — configure after domain is set |
| Production hosting platform (VPS / container required for FFmpeg) | Not selected |
| Contact address in Privacy page | Needs operator input |
| Data controller identity & jurisdiction | Needs operator input |
| Governing law in Terms | Needs operator input |
| Age requirement in Terms | Needs operator input |
| Cookie consent banner (jurisdiction-dependent) | Needs legal review |
| Formal copyright/DRM policy review | Needs legal review |

---

## 11. Architecture Notes

- **In-memory job store**: All jobs are held in RAM. Restarting the server loses all job state. For production, consider a persistent queue (e.g. Redis or SQLite).
- **FFmpeg required locally**: Serverless platforms (Vercel, Netlify, Cloudflare Workers) cannot run FFmpeg. Use a VPS, Fly.io, Railway, or Render (with Docker) for production.
- **Session isolation**: Downloads are protected by a session cookie (`econverters_sid`). No signed URLs are used; the server checks session ownership on every download request.
- **SSRF protection**: All URLs are validated against a blocklist of private/loopback/cloud-metadata IP ranges before any HTTP request is made, and after DNS resolution.
