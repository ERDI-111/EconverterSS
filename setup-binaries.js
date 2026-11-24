const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

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
  https.get(url, { timeout: 30000 }, (res) => {
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

function tryPipInstall() {
  // Fallback: install via pip and symlink/copy to bin/
  console.log('Trying pip install yt-dlp as fallback...');
  const pipCandidates = ['pip3', 'pip', 'python3 -m pip', 'python -m pip'];
  for (const pip of pipCandidates) {
    try {
      execSync(`${pip} install -q yt-dlp`, { stdio: 'inherit', timeout: 120000 });
      // Find where pip installed yt-dlp
      const whichCandidates = ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`];
      for (const candidate of whichCandidates) {
        if (fs.existsSync(candidate)) {
          fs.copyFileSync(candidate, targetPath);
          try { fs.chmodSync(targetPath, 0o755); } catch (e) {}
          console.log(`Copied yt-dlp from ${candidate} to ${targetPath}`);
          return true;
        }
      }
      // Try which command
      try {
        const which = execSync('which yt-dlp', { encoding: 'utf-8' }).trim();
        if (which && fs.existsSync(which)) {
          fs.copyFileSync(which, targetPath);
          try { fs.chmodSync(targetPath, 0o755); } catch (e) {}
          console.log(`Copied yt-dlp from ${which} to ${targetPath}`);
          return true;
        }
      } catch (e) {}
    } catch (e) {
      console.log(`pip install with ${pip} failed: ${e.message}`);
    }
  }
  return false;
}

downloadFile(downloadUrl, targetPath, (err) => {
  if (err) {
    console.warn('Direct download failed:', err.message);
    if (!isWin) {
      const ok = tryPipInstall();
      if (!ok) {
        console.warn('pip fallback also failed. yt-dlp may not be available at runtime.');
      }
    }
    // Don't exit with error — allow build to continue; yt-dlp may still be on PATH
    process.exit(0);
  }
  console.log('Successfully installed yt-dlp to', targetPath);
});
