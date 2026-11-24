const fs = require('fs');
const path = require('path');
const https = require('https');

const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const isWin = process.platform === 'win32';
const ytDlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const targetPath = path.join(binDir, ytDlpFilename);

// If yt-dlp already exists locally, skip
if (fs.existsSync(targetPath)) {
  console.log('yt-dlp already exists at', targetPath);
  process.exit(0);
}

// On Linux (Render) or Windows, download standalone binary
const downloadUrl = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

console.log(`Downloading yt-dlp for ${process.platform} from ${downloadUrl}...`);

function downloadFile(url, dest, cb) {
  https.get(url, (res) => {
    if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
      return downloadFile(res.headers.location, dest, cb);
    }
    if (res.statusCode !== 200) {
      return cb(new Error(`Download failed with status ${res.statusCode}`));
    }
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        try {
          fs.chmodSync(dest, 0o755);
        } catch (e) {}
        cb(null);
      });
    });
  }).on('error', (err) => {
    fs.unlink(dest, () => {});
    cb(err);
  });
}

downloadFile(downloadUrl, targetPath, (err) => {
  if (err) {
    console.error('Failed to download yt-dlp:', err.message);
    process.exit(0);
  }
  console.log('Successfully installed yt-dlp to', targetPath);
});
