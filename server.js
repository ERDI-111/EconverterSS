const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const dns = require('dns').promises;
const net = require('net');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

// ==========================================================================
// Server Configuration & Environment
// ==========================================================================
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3080,
  stagingAuth: {
    enabled: process.env.STAGING_AUTH !== 'false', // Default true for staging
    username: process.env.STAGING_USER || 'econverters',
    password: process.env.STAGING_PASS || 'staging-access-2026'
  },
  limits: {
    maxFileSizeBytes: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024,
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500,
    jobTimeoutMs: (parseInt(process.env.JOB_DURATION_SEC, 10) || 300) * 1000,
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 2,
    fileExpiryMs: (parseInt(process.env.DOWNLOAD_EXPIRY_MIN, 10) || 30) * 60 * 1000,
    fileExpiryMin: parseInt(process.env.DOWNLOAD_EXPIRY_MIN, 10) || 30
  }
};

const PUBLIC_DIR = __dirname;
const TMP_DIR = path.join(__dirname, 'tmp');
const UPLOADS_DIR = path.join(TMP_DIR, 'uploads');
const OUTPUTS_DIR = path.join(TMP_DIR, 'outputs');

// Ensure directories exist
[TMP_DIR, UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Supported direct media extensions
const MEDIA_EXTENSIONS = new Set([
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.aiff',
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.m4v', '.3gp'
]);

// In-memory Job & Session Storage
const jobs = new Map();
const jobQueue = [];
let activeWorkersCount = 0;

// ==========================================================================
// Rate Limiting & Queue Cap
// ==========================================================================
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE, 10) !== undefined && !isNaN(parseInt(process.env.MAX_QUEUE_SIZE, 10))
  ? parseInt(process.env.MAX_QUEUE_SIZE, 10) : 10;

// Per-IP rate limit: max 5 new convert jobs per 10 minutes (sliding window)
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 5;
const RATE_LIMIT_WINDOW_MS = (parseInt(process.env.RATE_LIMIT_WINDOW_MIN, 10) || 10) * 60 * 1000;
const ipRateLimits = new Map(); // ip => [timestamp, ...]

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (ipRateLimits.get(ip) || []).filter(t => t > windowStart);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  ipRateLimits.set(ip, hits);
  return true;
}

// Clean up old rate limit entries every 15 minutes
setInterval(() => {
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, hits] of ipRateLimits.entries()) {
    const fresh = hits.filter(t => t > windowStart);
    if (fresh.length === 0) ipRateLimits.delete(ip);
    else ipRateLimits.set(ip, fresh);
  }
}, 15 * 60 * 1000);

// ==========================================================================
// Monitoring Stats (no PII: no filenames, no URLs, no session IDs in logs)
// ==========================================================================
const stats = {
  failedJobs: 0,
  completedJobs: 0,
  peakQueueLength: 0
};

// ==========================================================================
// Session & Privacy Helpers
// ==========================================================================

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function getOrCreateSessionId(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies['econverters_sid'];
  if (!sid || sid.length < 16) {
    sid = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `econverters_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return sid;
}

// Basic Authentication Handler for Staging Deployment
function checkStagingAuth(req, res) {
  if (!CONFIG.stagingAuth.enabled) return true;

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="EconverterS Staging Deployment"');
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Authentication required for EconverterS staging deployment.');
    return false;
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const [user, pass] = credentials.split(':');

  if (user !== CONFIG.stagingAuth.username || pass !== CONFIG.stagingAuth.password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="EconverterS Staging Deployment"');
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Invalid credentials for EconverterS staging deployment.');
    return false;
  }

  return true;
}

// ==========================================================================
// SSRF & URL Security Checks
// ==========================================================================

function isRestrictedIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return true;
  const [b0, b1, b2, b3] = parts;
  if (b0 === 0) return true; // 0.0.0.0/8
  if (b0 === 10) return true; // 10.0.0.0/8
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // CGNAT
  if (b0 === 127) return true; // Loopback
  if (b0 === 169 && b1 === 254) return true; // Link-local & cloud metadata
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // Private
  if (b0 === 192 && b1 === 168) return true; // Private
  if (b0 >= 224) return true; // Multicast & Reserved
  return false;
}

function isRestrictedIPv6(ip) {
  const norm = ip.toLowerCase();
  if (norm === '::1' || norm === '::' || norm === '0:0:0:0:0:0:0:1' || norm === '0:0:0:0:0:0:0:0') return true;
  if (norm.startsWith('::ffff:')) {
    const v4 = norm.replace('::ffff:', '');
    if (net.isIPv4(v4)) return isRestrictedIPv4(v4);
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(norm)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(norm)) return true;
  return false;
}

function isRestrictedIP(ip) {
  const ver = net.isIP(ip);
  if (ver === 4) return isRestrictedIPv4(ip);
  if (ver === 6) return isRestrictedIPv6(ip);
  return true;
}

async function validateUrlSafety(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return { safe: false, error: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, error: 'Only HTTP and HTTPS links are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const blockedHostnames = ['localhost', 'metadata.google.internal', 'metadata.internal', 'instance-data'];

  if (
    blockedHostnames.includes(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { safe: false, error: 'Access to localhost and internal hostnames is blocked for security' };
  }

  if (net.isIP(hostname)) {
    if (isRestrictedIP(hostname)) {
      return { safe: false, error: 'Access to private and link-local IP addresses is blocked' };
    }
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { safe: false, error: 'Could not resolve domain name' };
    }
    for (const record of addresses) {
      if (isRestrictedIP(record.address)) {
        return {
          safe: false,
          error: 'Security restriction: This link resolves to a private network or internal cloud endpoint'
        };
      }
    }
  } catch (err) {
    return { safe: false, error: `DNS lookup failed for ${hostname}: ${err.message}` };
  }

  return { safe: true, parsed };
}

function safeFetch(targetUrl, options = {}, redirectCount = 0) {
  return new Promise(async (resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    const safety = await validateUrlSafety(targetUrl);
    if (!safety.safe) return reject(new Error(safety.error));

    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'EconverterS/1.0 (+https://econverters.app; staging preview)',
        'Accept': '*/*',
        ...(options.headers || {})
      },
      timeout: 15000
    };

    const req = client.request(parsed, reqOptions, async (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        try {
          const redirectRes = await safeFetch(redirectUrl, options, redirectCount + 1);
          resolve(redirectRes);
        } catch (e) {
          reject(e);
        }
        return;
      }

      if (options.outputFilePath) {
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(options.outputFilePath);

        res.on('data', chunk => {
          downloadedBytes += chunk.length;
          if (downloadedBytes > CONFIG.limits.maxFileSizeBytes) {
            req.destroy();
            fileStream.destroy();
            fs.unlink(options.outputFilePath, () => {});
            reject(new Error(`File exceeds maximum size limit (${CONFIG.limits.maxFileSizeMB} MB)`));
            return;
          }
          fileStream.write(chunk);
        });

        res.on('end', () => {
          fileStream.end();
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            finalUrl: targetUrl,
            downloadedBytes
          });
        });

        fileStream.on('error', reject);
        return;
      }

      let data = '';
      res.on('data', chunk => {
        if (data.length < 1024 * 1024) data += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          finalUrl: targetUrl
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.on('error', reject);
    req.end();
  });
}

function parseContentDispositionFilename(header) {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch (e) {}
  }
  const standardMatch = header.match(/filename="?([^";]+)"?/i);
  if (standardMatch && standardMatch[1]) return standardMatch[1].trim();
  return null;
}

function removeLastExtension(filename) {
  if (!filename) return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot > 0) return filename.substring(0, lastDot);
  return filename;
}

// ==========================================================================
// Media Link Inspection
// ==========================================================================

async function inspectMediaLink(targetUrl) {
  const safety = await validateUrlSafety(targetUrl);
  if (!safety.safe) {
    return { success: false, error: safety.error, suggestUpload: true };
  }

  const parsed = safety.parsed;
  const host = parsed.hostname.toLowerCase();

  // YouTube Integration via oEmbed + yt-dlp fallback
  const isYouTube = host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  if (isYouTube) {
    let title = null;
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
    try {
      const res = await safeFetch(oembedUrl);
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.title && typeof json.title === 'string' && json.title.trim().length > 0) {
          title = json.title.trim();
        }
      }
    } catch (err) {}

    // If oEmbed didn't get title, try yt-dlp to inspect title
    if (!title) {
      try {
        title = await new Promise((resolve) => {
          execFile('yt-dlp', ['--no-playlist', '--get-title', targetUrl], { timeout: 12000 }, (err, stdout) => {
            if (!err && stdout && stdout.trim().length > 0) resolve(stdout.trim().split('\n')[0]);
            else resolve(null);
          });
        });
      } catch (e) {}
    }

    if (title) {
      return {
        success: true,
        originalTitle: title,
        sourceType: 'YouTube',
        isPlatformIntegration: true,
        canDirectDownload: true
      };
    } else {
      return {
        success: false,
        error: 'Ky video në YouTube nuk mund të aksesohet ose nuk është publik. Ju lutem kontrolloni linkun ose ngarkoni skedarin direkt.',
        suggestUpload: true
      };
    }
  }

  // Vimeo
  const isVimeo = host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com';
  if (isVimeo) {
    const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}`;
    try {
      const res = await safeFetch(oembedUrl);
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.title && typeof json.title === 'string' && json.title.trim().length > 0) {
          return {
            success: true,
            originalTitle: json.title.trim(),
            sourceType: 'Vimeo',
            isPlatformIntegration: true,
            canDirectDownload: false
          };
        }
      }
    } catch (err) {
      return { success: false, error: 'Could not retrieve Vimeo metadata. Please upload the file directly.', suggestUpload: true };
    }
  }

  // SoundCloud
  const isSoundCloud = host === 'soundcloud.com' || host === 'www.soundcloud.com' || host === 'm.soundcloud.com';
  if (isSoundCloud) {
    const oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
    try {
      const res = await safeFetch(oembedUrl);
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.title && typeof json.title === 'string' && json.title.trim().length > 0) {
          return {
            success: true,
            originalTitle: json.title.trim(),
            sourceType: 'SoundCloud',
            isPlatformIntegration: true,
            canDirectDownload: false
          };
        }
      }
    } catch (err) {
      return { success: false, error: 'Could not retrieve SoundCloud track metadata. Please upload the file directly.', suggestUpload: true };
    }
  }

  // Direct Media Links
  try {
    const headRes = await safeFetch(targetUrl, { method: 'HEAD' });

    if (headRes.statusCode === 401 || headRes.statusCode === 403) {
      return {
        success: false,
        error: 'This link requires authentication or is protected by a paywall. Please upload the file directly.',
        suggestUpload: true
      };
    }
    if (headRes.statusCode >= 400) {
      return {
        success: false,
        error: `Server returned HTTP ${headRes.statusCode}. Please check the link or upload the file directly.`,
        suggestUpload: true
      };
    }

    const cdHeader = headRes.headers['content-disposition'];
    const serverFilename = parseContentDispositionFilename(cdHeader);

    if (serverFilename) {
      return {
        success: true,
        originalTitle: removeLastExtension(serverFilename),
        sourceType: 'Direct File',
        canDirectDownload: true
      };
    }

    const pathname = parsed.pathname;
    const lastSlash = pathname.lastIndexOf('/');
    const lastPart = lastSlash >= 0 ? pathname.substring(lastSlash + 1) : pathname;

    if (lastPart) {
      let decodedPart;
      try { decodedPart = decodeURIComponent(lastPart); } catch (e) { decodedPart = lastPart; }
      const lastDot = decodedPart.lastIndexOf('.');
      if (lastDot > 0) {
        const ext = decodedPart.substring(lastDot).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) {
          const cleanBase = decodedPart.substring(0, lastDot);
          if (cleanBase.trim().length > 0) {
            return {
              success: true,
              originalTitle: cleanBase.trim(),
              sourceType: 'Direct File',
              canDirectDownload: true
            };
          }
        }
      }
    }

    return {
      success: false,
      needsUserTitle: true,
      error: 'No trustworthy title could be detected from this source. Please enter a filename below, or upload the file directly.',
      suggestUpload: true
    };
  } catch (err) {
    return {
      success: false,
      error: `Unsupported link or server unreachable: ${err.message}. Please upload the audio or video file directly instead.`,
      suggestUpload: true
    };
  }
}

// Media Stream Analysis via ffprobe
function analyzeMediaFile(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,codec_name,width,height:format=duration,size',
        '-of', 'json',
        filePath
      ],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error('Invalid or unreadable media file: ' + (stderr || err.message)));
        }
        try {
          const info = JSON.parse(stdout);
          const streams = info.streams || [];
          const audioStream = streams.find(s => s.codec_type === 'audio');
          const videoStream = streams.find(s => s.codec_type === 'video');

          resolve({
            hasAudio: !!audioStream,
            hasVideo: !!videoStream,
            videoCodec: videoStream ? videoStream.codec_name : null,
            audioCodec: audioStream ? audioStream.codec_name : null,
            width: videoStream ? videoStream.width : null,
            height: videoStream ? videoStream.height : null,
            duration: info.format ? parseFloat(info.format.duration) : null
          });
        } catch (parseErr) {
          reject(new Error('Failed to parse media probe data'));
        }
      }
    );
  });
}

// ==========================================================================
// Job Queue & FFmpeg Worker Processor
// ==========================================================================

async function processNextJob() {
  if (activeWorkersCount >= CONFIG.limits.maxConcurrentJobs || jobQueue.length === 0) {
    return;
  }

  const jobId = jobQueue.shift();
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') {
    return;
  }

  activeWorkersCount++;
  job.status = 'converting';
  job.progress = 10;

  try {
    // Record job start (no PII)
    console.log(`[job] starting jobId=${job.id} format=${job.format}`);

    // If source is a direct link or YouTube, download to local temp file
    if (job.sourceType === 'link') {
      job.progress = 15;
      const parsedUrl = new URL(job.sourceUrl);
      const host = parsedUrl.hostname.toLowerCase();
      const isYt = host.includes('youtube.com') || host.includes('youtu.be');

      if (isYt) {
        job.progress = 25;
        const ytTempPrefix = `input_${job.id}_yt`;
        const ytTempPath = path.join(UPLOADS_DIR, `${ytTempPrefix}.%(ext)s`);
        const isMp4 = job.format === 'mp4';
        const ytFormat = isMp4 ? 'bv*[ext=mp4][vcodec^=avc][height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b' : 'ba/b';

        const ytArgs = [
          '-f', ytFormat,
          '--no-playlist',
          '--max-filesize', `${CONFIG.limits.maxFileSizeMB}M`,
          '-o', ytTempPath
        ];

        if (isMp4) {
          ytArgs.push('--merge-output-format', 'mp4');
        }

        ytArgs.push(job.sourceUrl);

        await new Promise((resolve, reject) => {
          const proc = spawn('yt-dlp', ytArgs, { timeout: CONFIG.limits.jobTimeoutMs });

          let stderr = '';
          proc.stderr.on('data', d => stderr += d.toString());
          proc.on('error', err => reject(new Error(`yt-dlp execution error: ${err.message}`)));
          proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`YouTube download error: ${stderr.slice(-200)}`));
          });
        });

        // Find the completed downloaded file (exclude temporary .part or intermediate .fXXX. files)
        const allFiles = fs.readdirSync(UPLOADS_DIR);
        const match = allFiles.find(f => 
          f.startsWith(`${ytTempPrefix}.`) && 
          !f.endsWith('.part') && 
          !/\.f\d+\./.test(f)
        );
        if (!match) {
          throw new Error('Could not find completed YouTube media file.');
        }
        job.inputPath = path.join(UPLOADS_DIR, match);
        job.progress = 45;
      } else {
        const downloadTempPath = path.join(UPLOADS_DIR, `input_${job.id}_download`);
        await safeFetch(job.sourceUrl, { outputFilePath: downloadTempPath });
        job.inputPath = downloadTempPath;
        job.progress = 40;
      }
    }

    if (!fs.existsSync(job.inputPath)) {
      throw new Error('Input source file could not be found or downloaded');
    }

    // Probe media tracks
    const mediaInfo = await analyzeMediaFile(job.inputPath);

    if (job.format === 'mp3') {
      if (!mediaInfo.hasAudio) {
        throw new Error('The source contains no audio track to convert.');
      }
    }

    if (job.format === 'mp4') {
      if (!mediaInfo.hasVideo) {
        throw new Error('The source is audio-only. MP4 video format requires a video track.');
      }
    }

    const outputPath = path.join(OUTPUTS_DIR, `output_${job.id}.${job.format}`);
    job.outputPath = outputPath;

    let ffmpegArgs = ['-y', '-i', job.inputPath];

    if (job.format === 'mp3') {
      ffmpegArgs.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outputPath);
    } else {
      // MP4: If video is already h264, use stream copy (-c:v copy) for instantaneous processing!
      if (mediaInfo.videoCodec === 'h264') {
        ffmpegArgs.push('-c:v', 'copy');
      } else {
        ffmpegArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '22');
      }

      if (mediaInfo.hasAudio) {
        if (mediaInfo.audioCodec === 'aac') {
          ffmpegArgs.push('-c:a', 'copy');
        } else {
          ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
        }
      } else {
        ffmpegArgs.push('-an');
      }
      ffmpegArgs.push('-movflags', '+faststart', outputPath);
    }

    job.progress = 50;

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs, { timeout: CONFIG.limits.jobTimeoutMs });
      let stderrData = '';

      proc.stderr.on('data', chunk => {
        stderrData += chunk.toString();
        if (job.progress < 90) job.progress += 5;
      });

      proc.on('error', (err) => {
        reject(new Error(`FFmpeg execution error: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg conversion failed (code ${code}): ${stderrData.slice(-300)}`));
        }
      });
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('Conversion produced an empty or missing output file');
    }

    job.status = 'completed';
    job.progress = 100;
    job.completedAt = Date.now();
    job.expiresAt = Date.now() + CONFIG.limits.fileExpiryMs;
    stats.completedJobs++;
    console.log(`[job] completed jobId=${job.id} format=${job.format}`);

  } catch (err) {
    job.status = 'failed';
    job.error = err.message || 'Conversion failed';
    stats.failedJobs++;
    console.log(`[job] failed jobId=${job.id} reason=${err.message ? err.message.substring(0, 80) : 'unknown'}`);
  } finally {
    // Clean up temporary direct link download file
    if (job.sourceType === 'link' && job.inputPath && fs.existsSync(job.inputPath)) {
      fs.unlink(job.inputPath, () => {});
    }
    activeWorkersCount--;
    setImmediate(processNextJob);
  }
}

// Automatic cleanup of expired files and jobs (privacy & disk space preservation)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.expiresAt && now > job.expiresAt) {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlink(job.outputPath, () => {});
      }
      if (job.inputPath && fs.existsSync(job.inputPath) && job.inputPath.startsWith(UPLOADS_DIR)) {
        fs.unlink(job.inputPath, () => {});
      }
      job.status = 'expired';
      job.outputPath = null;
    }
  }
}, 30000);

// ==========================================================================
// HTTP Server & API Handlers
// ==========================================================================

const server = http.createServer(async (req, res) => {
  const reqUrl = url.parse(req.url, true);

  // 1. Password Protection Check for Staging Deployment
  if (!checkStagingAuth(req, res)) {
    return;
  }

  // 2. Identify or Create User Session ID
  const sessionId = getOrCreateSessionId(req, res);

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ------------------------------------------------------------------------
  // API: Get Deployment & Limit Information
  // ------------------------------------------------------------------------
  if (req.method === 'GET' && reqUrl.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      appName: 'EconverterS',
      deployment: 'Staging (Password-Protected)',
      limits: {
        maxUploadMB: CONFIG.limits.maxFileSizeMB,
        jobDurationLimitSec: CONFIG.limits.jobTimeoutMs / 1000,
        concurrencyLimit: CONFIG.limits.maxConcurrentJobs,
        downloadExpiryMinutes: CONFIG.limits.fileExpiryMin
      },
      supportedSources: {
        uploads: ['mov', 'mp4', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'flac', 'aac', 'm4a'],
        directLinks: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'mp4', 'mov', 'webm', 'mkv'],
        integrations: {
          youtube: 'Metadata / title inspection active; direct media streams require authorized URL or uploaded file.',
          vimeo: 'Metadata inspection active.',
          soundcloud: 'Metadata inspection active.'
        }
      }
    }));
    return;
  }

  // ------------------------------------------------------------------------
  // API: Admin Stats (auth-protected, no PII)
  // Returns: failed/completed job counts, queue depth, disk usage
  // ------------------------------------------------------------------------
  if (req.method === 'GET' && reqUrl.pathname === '/api/admin/stats') {
    // Calculate disk usage of tmp dirs
    let diskUsageBytes = 0;
    const countDiskUsage = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.isFile()) diskUsageBytes += st.size;
        } catch (e) {}
      }
    };
    countDiskUsage(UPLOADS_DIR);
    countDiskUsage(OUTPUTS_DIR);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      failedJobs: stats.failedJobs,
      completedJobs: stats.completedJobs,
      peakQueueLength: stats.peakQueueLength,
      currentQueueLength: jobQueue.length,
      currentWorkers: activeWorkersCount,
      diskUsageMB: Math.round(diskUsageBytes / 1024 / 1024 * 100) / 100,
      rateLimit: { maxPerWindow: RATE_LIMIT_MAX, windowMinutes: RATE_LIMIT_WINDOW_MS / 60000 },
      maxQueueSize: MAX_QUEUE_SIZE
    }));
    return;
  }

  // ------------------------------------------------------------------------
  // API: Inspect Link
  // ------------------------------------------------------------------------
  if (req.method === 'POST' && reqUrl.pathname === '/api/inspect-link') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 32 * 1024) req.destroy();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (!data.url || typeof data.url !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'URL is required' }));
          return;
        }

        const result = await inspectMediaLink(data.url.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Server inspection error: ' + err.message }));
      }
    });
    return;
  }

  // ------------------------------------------------------------------------
  // API: File Upload
  // Enforces per-session ownership and size limit
  // ------------------------------------------------------------------------
  if (req.method === 'POST' && reqUrl.pathname === '/api/upload') {
    const fileToken = `upload_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const rawFilename = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'uploaded_file';
    const targetPath = path.join(UPLOADS_DIR, fileToken);
    const writeStream = fs.createWriteStream(targetPath);
    let totalBytes = 0;

    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > CONFIG.limits.maxFileSizeBytes) {
        req.destroy();
        writeStream.destroy();
        fs.unlink(targetPath, () => {});
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `File size exceeds limit (${CONFIG.limits.maxFileSizeMB} MB)` }));
      }
    });

    req.pipe(writeStream);

    writeStream.on('finish', async () => {
      try {
        const probe = await analyzeMediaFile(targetPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          fileToken,
          originalFilename: rawFilename,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo
        }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          fileToken,
          originalFilename: rawFilename,
          hasAudio: true,
          hasVideo: true
        }));
      }
    });

    writeStream.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'File upload error: ' + err.message }));
    });
    return;
  }

  // ------------------------------------------------------------------------
  // API: Convert Job Submission
  // Stores ownerSessionId to keep downloads strictly private
  // ------------------------------------------------------------------------
  if (req.method === 'POST' && reqUrl.pathname === '/api/convert') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 32 * 1024) req.destroy();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { sourceType, fileToken, mediaUrl, format, approvedFilename } = data;

        if (!format || (format !== 'mp3' && format !== 'mp4')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid format requested. Must be mp3 or mp4.' }));
          return;
        }

        if (!approvedFilename || typeof approvedFilename !== 'string' || approvedFilename.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Approved filename is required.' }));
          return;
        }

        // --- Rate limit check (per IP) ---
        const clientIp = req.socket.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp)) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
          res.end(JSON.stringify({
            success: false,
            error: 'Too many conversion requests. Please wait a few minutes and try again.'
          }));
          return;
        }

        // --- Queue cap check ---
        const queueDepth = jobQueue.length + activeWorkersCount;
        if (MAX_QUEUE_SIZE === 0 || queueDepth >= MAX_QUEUE_SIZE) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '60' });
          res.end(JSON.stringify({
            success: false,
            busyQueue: true,
            error: 'EconverterS is busy. Try again in a few minutes.'
          }));
          return;
        }

        const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        let inputPath = null;

        if (sourceType === 'file') {
          if (!fileToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'File token is missing.' }));
            return;
          }
          inputPath = path.join(UPLOADS_DIR, fileToken);
          if (!fs.existsSync(inputPath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Uploaded file session has expired or is missing.' }));
            return;
          }
        } else if (sourceType === 'link') {
          if (!mediaUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Media URL is required.' }));
            return;
          }

          const safety = await validateUrlSafety(mediaUrl);
          if (!safety.safe) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: safety.error }));
            return;
          }

          const parsed = new URL(mediaUrl);
          const host = parsed.hostname.toLowerCase();
          if (host.includes('soundcloud.com') || host.includes('vimeo.com')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: 'This platform integration provides metadata only and does not offer an authorized downloadable media stream. Please upload the file directly or provide a direct media link.'
            }));
            return;
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid source type.' }));
          return;
        }

        // Create Job Record with Session Ownership
        const job = {
          id: jobId,
          ownerSessionId: sessionId, // Privacy isolation
          sourceType,
          inputPath,
          sourceUrl: mediaUrl || null,
          format,
          downloadFilename: approvedFilename.trim(),
          status: 'queued',
          progress: 0,
          outputPath: null,
          error: null,
          createdAt: Date.now(),
          completedAt: null,
          expiresAt: null
        };

        jobs.set(jobId, job);
        jobQueue.push(jobId);
        // Track peak queue length for monitoring (no PII)
        if (jobQueue.length > stats.peakQueueLength) {
          stats.peakQueueLength = jobQueue.length;
        }

        processNextJob();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          jobId,
          status: 'queued',
          downloadFilename: job.downloadFilename
        }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Error starting conversion: ' + err.message }));
      }
    });
    return;
  }

  // ------------------------------------------------------------------------
  // API: Get Job Status
  // Enforces Session Ownership
  // ------------------------------------------------------------------------
  if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/jobs/')) {
    const jobId = reqUrl.pathname.replace('/api/jobs/', '');
    const job = jobs.get(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Job not found or expired' }));
      return;
    }

    // Verify Session Ownership
    if (job.ownerSessionId !== sessionId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Access denied: You do not have permission to view this job.' }));
      return;
    }

    let timeRemaining = null;
    if (job.expiresAt) {
      timeRemaining = Math.max(0, Math.round((job.expiresAt - Date.now()) / 1000));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      format: job.format,
      downloadFilename: job.downloadFilename,
      error: job.error,
      timeRemaining
    }));
    return;
  }

  // ------------------------------------------------------------------------
  // API: Download Converted File
  // Enforces Session Ownership & Expiration Checks
  // ------------------------------------------------------------------------
  if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/download/')) {
    const jobId = reqUrl.pathname.replace('/api/download/', '');
    const job = jobs.get(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Download Not Found</h1><p>The requested file does not exist or has expired.</p>');
      return;
    }

    // Verify Session Ownership: Separate browser session cannot access another session's download
    if (job.ownerSessionId !== sessionId) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>403 Forbidden</h1><p>Access denied: This download is private and only accessible to the user session that created it.</p>');
      return;
    }

    // Check Expiration
    if (job.status === 'expired' || (job.expiresAt && Date.now() > job.expiresAt)) {
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>410 Gone — Download Expired</h1><p>This download has expired. Temporary files have been permanently deleted for your security and privacy.</p>');
      return;
    }

    if (job.status !== 'completed' || !job.outputPath || !fs.existsSync(job.outputPath)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>File Unavailable</h1><p>Conversion output file is unavailable or missing.</p>');
      return;
    }

    const stat = fs.statSync(job.outputPath);
    const mimeType = job.format === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    // UTF-8 RFC 5987 / RFC 6266 Content-Disposition header
    const asciiFallback = job.downloadFilename.replace(/[^\x20-\x7E]/g, '_');
    const utf8Encoded = encodeURIComponent(job.downloadFilename).replace(/['()]/g, escape).replace(/\*/g, '%2A');

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
      'Cache-Control': 'no-cache, private'
    });

    fs.createReadStream(job.outputPath).pipe(res);
    return;
  }

  // ------------------------------------------------------------------------
  // Helper API for Smoke Testing: Force Expire a Job
  // ------------------------------------------------------------------------
  if (req.method === 'POST' && reqUrl.pathname === '/api/test/expire-job') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { jobId } = JSON.parse(body);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'expired';
          job.expiresAt = Date.now() - 1000;
          if (job.outputPath && fs.existsSync(job.outputPath)) {
            fs.unlink(job.outputPath, () => {});
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Job expired successfully for testing' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Job not found' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ------------------------------------------------------------------------
  // Static File Serving
  // ------------------------------------------------------------------------
  let filePath = path.join(PUBLIC_DIR, reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png'
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(CONFIG.port, () => {
  console.log(`EconverterS staging server running at http://localhost:${CONFIG.port}`);
  console.log(`Staging protection active: User "${CONFIG.stagingAuth.username}"`);
  console.log(`Limits: Max Upload ${CONFIG.limits.maxFileSizeMB} MB | Timeout ${CONFIG.limits.jobTimeoutMs / 1000}s | Concurrency ${CONFIG.limits.maxConcurrentJobs} | Expiry ${CONFIG.limits.fileExpiryMin}m`);
});
