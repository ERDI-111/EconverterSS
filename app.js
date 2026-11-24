/**
 * EconverterS — Media Converter Controller
 * Connects real FFmpeg backend workers for MP3 (192kbps) and MP4 conversion & downloads.
 * Preserves exact original title with accents, emoji, spaces, and UTF-8 Content-Disposition.
 * Enforces session-based privacy, upload limits, and expiration handling.
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- DOM Elements ---
  const mediaUrlInput = document.getElementById('mediaUrl');
  const pasteBtn = document.getElementById('pasteBtn');
  const dropzoneArea = document.getElementById('dropzoneArea');
  const fileUploadInput = document.getElementById('fileUpload');
  const fileSelectedBadge = document.getElementById('fileSelectedBadge');
  const fileSelectedName = document.getElementById('fileSelectedName');
  const clearFileBtn = document.getElementById('clearFileBtn');
  const dropzoneHint = document.getElementById('dropzoneHint');

  // Supported Sources Drawer
  const sourcesToggleBtn = document.getElementById('sourcesToggleBtn');
  const supportedSourcesPanel = document.getElementById('supportedSourcesPanel');
  const closeDrawerBtn = document.getElementById('closeDrawerBtn');

  // Status & Inspection UI
  const linkStatusPanel = document.getElementById('linkStatusPanel');
  const statusChecking = document.getElementById('statusChecking');
  const statusError = document.getElementById('statusError');
  const statusErrorText = document.getElementById('statusErrorText');
  const statusManualTitle = document.getElementById('statusManualTitle');
  const manualTitleInput = document.getElementById('manualTitleInput');

  // Format selection
  const formatCardMp3 = document.getElementById('formatCardMp3');
  const formatCardMp4 = document.getElementById('formatCardMp4');
  const formatRadioMp3 = document.getElementById('formatMp3');
  const formatRadioMp4 = document.getElementById('formatMp4');
  const formatDisabledNote = document.getElementById('formatDisabledNote');

  // Preview elements
  const filenamePreviewBox = document.getElementById('filenamePreviewBox');
  const previewLinesContainer = document.getElementById('previewLinesContainer');
  const previewIdleState = document.getElementById('previewIdleState');
  const originalNameDisplay = document.getElementById('originalNameDisplay');
  const savedBase = document.getElementById('savedBase');
  const filenameExt = document.getElementById('filenameExt');
  const adjustedNameLine = document.getElementById('adjustedNameLine');
  const adjustedNameNote = document.getElementById('adjustedNameNote');

  // Convert & Job Status Elements
  const convertBtn = document.getElementById('convertBtn');
  const convertBtnText = document.getElementById('convertBtnText');
  const jobStatusContainer = document.getElementById('jobStatusContainer');
  const jobProcessingView = document.getElementById('jobProcessingView');
  const jobStatusBadge = document.getElementById('jobStatusBadge');
  const jobStatusBadgeText = document.getElementById('jobStatusBadgeText');
  const jobProcessingFilename = document.getElementById('jobProcessingFilename');
  const progressBarFill = document.getElementById('progressBarFill');
  const jobStatusDesc = document.getElementById('jobStatusDesc');

  const jobReadyView = document.getElementById('jobReadyView');
  const jobExpiresText = document.getElementById('jobExpiresText');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadFilenameText = document.getElementById('downloadFilenameText');

  const jobFailedView = document.getElementById('jobFailedView');
  const jobErrorMessage = document.getElementById('jobErrorMessage');
  const retryBtn = document.getElementById('retryBtn');

  const toastContainer = document.getElementById('toastContainer');

  // State Management
  let currentFormat = 'mp3'; // 'mp3' or 'mp4'
  let activeSourceType = null; // 'file' | 'link' | null
  let activeFileToken = null;
  let activeMediaUrl = null;
  let activeMediaInfo = { hasAudio: true, hasVideo: true };
  let currentOriginalName = '';
  let inspectDebounceTimer = null;
  let activeAbortController = null;

  // Active Job Polling
  let currentJobId = null;
  let jobPollInterval = null;
  let lastJobApprovedFilename = '';
  let lastJobFormat = 'mp3';

  // --- Toggle Supported Sources Drawer ---
  function toggleSourcesDrawer(show) {
    const isVisible = supportedSourcesPanel.style.display !== 'none';
    const nextState = show !== undefined ? show : !isVisible;
    supportedSourcesPanel.style.display = nextState ? 'block' : 'none';
    sourcesToggleBtn.setAttribute('aria-expanded', String(nextState));
  }

  sourcesToggleBtn.addEventListener('click', () => toggleSourcesDrawer());
  closeDrawerBtn.addEventListener('click', () => toggleSourcesDrawer(false));

  // --- Filename Sanitization Helper ---
  function sanitizeForFilename(rawName) {
    if (!rawName) return '';
    let sanitized = rawName
      .replace(/[\/\\:]/g, ' — ')
      .replace(/[*?"<>|]/g, '')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    sanitized = sanitized.replace(/[. ]+$/, '');

    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(sanitized)) {
      sanitized = '_' + sanitized;
    }

    return sanitized || 'Untitled';
  }

  function removeLastExtension(filename) {
    if (!filename) return '';
    const lastDot = filename.lastIndexOf('.');
    if (lastDot > 0) return filename.substring(0, lastDot);
    return filename;
  }

  function formatSeconds(sec) {
    if (!sec || sec < 0) return '30m';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  }

  // --- Render Preview Function ---
  function renderPreview(originalName) {
    if (!originalName || originalName.trim().length === 0) {
      previewLinesContainer.style.display = 'none';
      previewIdleState.style.display = 'block';
      convertBtn.disabled = true;
      return;
    }

    currentOriginalName = originalName.trim();
    previewLinesContainer.style.display = 'flex';
    previewIdleState.style.display = 'none';

    // Line 1: Original name
    originalNameDisplay.textContent = currentOriginalName;

    // Line 2: Your file will be saved as
    const safeBase = sanitizeForFilename(currentOriginalName);
    savedBase.textContent = safeBase;
    filenameExt.textContent = `.${currentFormat}`;

    // Line 3: If adjusted for filesystem safety
    if (safeBase !== currentOriginalName) {
      adjustedNameLine.style.display = 'flex';
      adjustedNameNote.textContent = `Adjusted to "${safeBase}.${currentFormat}" for filesystem safety.`;
    } else {
      adjustedNameLine.style.display = 'none';
    }

    // Enable Convert if source is ready
    if (activeSourceType) {
      convertBtn.disabled = false;
    }
  }

  function clearPreview() {
    currentOriginalName = '';
    previewLinesContainer.style.display = 'none';
    previewIdleState.style.display = 'block';
    convertBtn.disabled = true;
    hideInspectionStatus();
  }

  function showToast(message, duration = 3200) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, duration);
  }

  function applyTrackAvailability(hasAudio, hasVideo) {
    activeMediaInfo = { hasAudio, hasVideo };

    if (!hasVideo) {
      formatCardMp4.classList.add('disabled');
      formatRadioMp4.disabled = true;
      formatDisabledNote.style.display = 'flex';
      updateFormat('mp3');
    } else {
      formatCardMp4.classList.remove('disabled');
      formatRadioMp4.disabled = false;
      formatDisabledNote.style.display = 'none';
    }
  }

  function updateFormat(format) {
    if (format === 'mp4' && formatRadioMp4.disabled) {
      showToast('Source is audio-only; MP4 video format is disabled.');
      return;
    }

    currentFormat = format;

    if (format === 'mp3') {
      formatRadioMp3.checked = true;
      formatCardMp3.classList.add('active');
      formatCardMp4.classList.remove('active');
    } else {
      formatRadioMp4.checked = true;
      formatCardMp4.classList.add('active');
      formatCardMp3.classList.remove('active');
    }

    filenameExt.textContent = `.${currentFormat}`;

    filenameExt.classList.remove('bump');
    void filenameExt.offsetWidth;
    filenameExt.classList.add('bump');

    if (adjustedNameLine.style.display !== 'none' && currentOriginalName) {
      const safeBase = sanitizeForFilename(currentOriginalName);
      adjustedNameNote.textContent = `Adjusted to "${safeBase}.${currentFormat}" for filesystem safety.`;
    }
  }

  formatCardMp3.addEventListener('click', (e) => {
    e.preventDefault();
    updateFormat('mp3');
  });

  formatCardMp4.addEventListener('click', (e) => {
    e.preventDefault();
    if (!formatRadioMp4.disabled) {
      updateFormat('mp4');
    }
  });

  function showCheckingStatus() {
    linkStatusPanel.style.display = 'flex';
    statusChecking.style.display = 'flex';
    statusError.style.display = 'none';
    statusManualTitle.style.display = 'none';
  }

  function showErrorStatus(message) {
    linkStatusPanel.style.display = 'flex';
    statusChecking.style.display = 'none';
    statusError.style.display = 'flex';
    statusErrorText.textContent = message;
    statusManualTitle.style.display = 'none';
  }

  function showManualTitlePrompt(message) {
    linkStatusPanel.style.display = 'flex';
    statusChecking.style.display = 'none';
    statusError.style.display = 'flex';
    statusErrorText.textContent = message;
    statusManualTitle.style.display = 'flex';
    manualTitleInput.value = '';
    manualTitleInput.focus();
  }

  function hideInspectionStatus() {
    linkStatusPanel.style.display = 'none';
    statusChecking.style.display = 'none';
    statusError.style.display = 'none';
    statusManualTitle.style.display = 'none';
  }

  async function inspectLink(rawUrl) {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      clearPreview();
      return;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        clearPreview();
        showErrorStatus('Only HTTP(S) links are supported. Please upload the file directly instead.');
        return;
      }
    } catch (e) {
      clearPreview();
      showErrorStatus('Invalid URL format. Please paste a full link (https://...) or upload the file.');
      return;
    }

    if (activeAbortController) activeAbortController.abort();
    activeAbortController = new AbortController();

    clearPreview();
    showCheckingStatus();

    try {
      const response = await fetch('/api/inspect-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
        signal: activeAbortController.signal
      });

      const result = await response.json();

      if (result.success && result.originalTitle) {
        if (result.isPlatformIntegration && !result.canDirectDownload) {
          clearPreview();
          activeSourceType = null;
          activeMediaUrl = null;
          showErrorStatus(`"${result.originalTitle}": Ky integrim shërben vetëm për leximin e titullit dhe nuk lejon shkarkim të drejtpërdrejtë. Ju lutem ngarkoni skedarin nga kompjuteri (Upload) ose vendosni një link direkt.`);
          return;
        }
        hideInspectionStatus();
        activeSourceType = 'link';
        activeMediaUrl = trimmed;
        activeFileToken = null;
        applyTrackAvailability(true, true);
        renderPreview(result.originalTitle);
        showToast(`Identified source: ${result.sourceType || 'Media Link'}`);
      } else if (result.needsUserTitle) {
        clearPreview();
        activeSourceType = 'link';
        activeMediaUrl = trimmed;
        showManualTitlePrompt(result.error);
      } else {
        clearPreview();
        activeSourceType = null;
        activeMediaUrl = null;
        showErrorStatus(result.error || 'Unsupported link or source unreachable. Please upload the file instead.');
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      clearPreview();
      activeSourceType = null;
      activeMediaUrl = null;
      showErrorStatus(`Inspection failed: ${err.message}. Please upload the file instead.`);
    }
  }

  mediaUrlInput.addEventListener('input', (e) => {
    clearPreview();
    activeSourceType = null;
    activeFileToken = null;

    if (fileUploadInput.files.length > 0) {
      fileUploadInput.value = '';
      fileSelectedBadge.style.display = 'none';
      dropzoneHint.style.display = 'inline';
    }

    const value = e.target.value.trim();
    if (!value) return;

    clearTimeout(inspectDebounceTimer);
    inspectDebounceTimer = setTimeout(() => {
      inspectLink(value);
    }, 450);
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim().length > 0) {
          mediaUrlInput.value = text.trim();
          clearPreview();
          inspectLink(text.trim());
          showToast('Link pasted');
        } else {
          showToast('Clipboard is empty');
        }
      } else {
        mediaUrlInput.focus();
        showToast('Press Ctrl+V to paste link');
      }
    } catch (err) {
      mediaUrlInput.focus();
      showToast('Clipboard access denied. Press Ctrl+V to paste');
    }
  });

  manualTitleInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val.length > 0) {
      renderPreview(val);
    } else {
      previewLinesContainer.style.display = 'none';
      previewIdleState.style.display = 'block';
      convertBtn.disabled = true;
    }
  });

  // Drag & Drop / Upload
  dropzoneArea.addEventListener('click', (e) => {
    if (e.target !== clearFileBtn && !clearFileBtn.contains(e.target)) {
      fileUploadInput.click();
    }
  });

  dropzoneArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileUploadInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzoneArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneArea.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzoneArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneArea.classList.remove('drag-over');
    });
  });

  dropzoneArea.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileSelected(files[0]);
    }
  });

  fileUploadInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  async function handleFileSelected(file) {
    mediaUrlInput.value = '';
    hideInspectionStatus();

    const originalFilename = file.name;
    const baseWithoutLastExt = removeLastExtension(originalFilename);

    activeSourceType = 'file';
    activeMediaUrl = null;
    fileSelectedName.textContent = originalFilename;
    fileSelectedBadge.style.display = 'flex';
    dropzoneHint.style.display = 'none';

    renderPreview(baseWithoutLastExt);
    showToast(`Uploading ${originalFilename}…`);

    try {
      const uploadRes = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(originalFilename)
        },
        body: file
      });

      const uploadData = await uploadRes.json();
      if (uploadData.success) {
        activeFileToken = uploadData.fileToken;
        applyTrackAvailability(uploadData.hasAudio, uploadData.hasVideo);
        convertBtn.disabled = false;
        showToast('Source file ready for conversion');
      } else {
        showToast(`Upload failed: ${uploadData.error || 'Server error'}`);
        convertBtn.disabled = true;
      }
    } catch (err) {
      showToast(`Upload failed: ${err.message}`);
      convertBtn.disabled = true;
    }
  }

  clearFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileUploadInput.value = '';
    activeSourceType = null;
    activeFileToken = null;
    fileSelectedBadge.style.display = 'none';
    dropzoneHint.style.display = 'inline';
    clearPreview();
    showToast('File removed');
  });

  // Conversion Job Start
  async function startConversionJob() {
    if (!activeSourceType) {
      showToast('Please select a file or link first');
      return;
    }

    const approvedBase = savedBase.textContent;
    const approvedExt = filenameExt.textContent;
    const approvedFilename = `${approvedBase}${approvedExt}`;
    lastJobApprovedFilename = approvedFilename;
    lastJobFormat = currentFormat;

    jobStatusContainer.style.display = 'block';
    jobProcessingView.style.display = 'block';
    jobReadyView.style.display = 'none';
    jobFailedView.style.display = 'none';

    jobProcessingFilename.textContent = approvedFilename;
    jobStatusBadgeText.textContent = 'Queued';
    jobStatusBadge.className = 'job-badge';
    progressBarFill.style.width = '15%';
    jobStatusDesc.textContent = 'Job sent to queue. Waiting for worker slot…';

    convertBtn.disabled = true;
    convertBtnText.textContent = 'Converting…';

    try {
      const response = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: activeSourceType,
          fileToken: activeFileToken,
          mediaUrl: activeMediaUrl,
          format: currentFormat,
          approvedFilename
        })
      });

      const data = await response.json();

      if (!data.success) {
        // Distinguish queue-full (503) from rate limit (429) from other errors
        if (data.busyQueue || response.status === 503) {
          handleJobFailure('EconverterS is busy. Try again in a few minutes.');
        } else if (response.status === 429) {
          handleJobFailure('Too many requests. Please wait a few minutes and try again.');
        } else {
          handleJobFailure(data.error || 'Failed to start conversion job');
        }
        return;
      }

      currentJobId = data.jobId;
      startJobPolling(currentJobId, approvedFilename, lastJobFormat);

    } catch (err) {
      handleJobFailure(`Network error starting job: ${err.message}`);
    }
  }

  function startJobPolling(jobId, frozenDownloadFilename, frozenFormat) {
    if (jobPollInterval) clearInterval(jobPollInterval);

    jobPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const job = await res.json();

        if (!job.success) {
          clearInterval(jobPollInterval);
          handleJobFailure(job.error || 'Job not found');
          return;
        }

        if (job.status === 'queued') {
          jobStatusBadgeText.textContent = 'Queued';
          progressBarFill.style.width = '20%';
          jobStatusDesc.textContent = 'Queued in worker pool…';
        } else if (job.status === 'converting') {
          jobStatusBadgeText.textContent = 'Converting';
          progressBarFill.style.width = `${Math.max(35, job.progress || 50)}%`;
          jobStatusDesc.textContent = `Transcoding to ${frozenFormat.toUpperCase()} with FFmpeg…`;
        } else if (job.status === 'completed') {
          clearInterval(jobPollInterval);
          handleJobSuccess(jobId, frozenDownloadFilename, job.timeRemaining);
        } else if (job.status === 'failed') {
          clearInterval(jobPollInterval);
          handleJobFailure(job.error || 'Conversion failed');
        }
      } catch (err) {
        // Continue on transient network hiccup
      }
    }, 750);
  }

  function handleJobSuccess(jobId, downloadFilename, timeRemaining) {
    jobProcessingView.style.display = 'none';
    jobReadyView.style.display = 'block';
    jobFailedView.style.display = 'none';

    downloadBtn.href = `/api/download/${jobId}`;
    downloadBtn.setAttribute('download', downloadFilename);
    downloadFilenameText.textContent = downloadFilename;
    jobExpiresText.textContent = `Expires in ${formatSeconds(timeRemaining)}`;

    convertBtn.disabled = false;
    convertBtnText.textContent = 'Convert';
    showToast(`Conversion complete: ${downloadFilename}`);
  }

  function handleJobFailure(errorMsg) {
    jobProcessingView.style.display = 'none';
    jobReadyView.style.display = 'none';
    jobFailedView.style.display = 'block';
    jobErrorMessage.textContent = errorMsg;

    convertBtn.disabled = false;
    convertBtnText.textContent = 'Convert';
  }

  convertBtn.addEventListener('click', () => {
    if (!convertBtn.disabled) {
      startConversionJob();
    }
  });

  retryBtn.addEventListener('click', () => {
    startConversionJob();
  });

  // ==========================================================================
  // Animated Waveform Canvas
  // ==========================================================================
  const canvas = document.getElementById('waveformCanvas');
  const ctx = canvas.getContext('2d');
  let phase = 0;

  function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth * window.devicePixelRatio;
    canvas.height = container.clientHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const waves = [
    { amplitude: 28, wavelength: 0.008, speed: 0.015, color: 'rgba(139, 92, 246, 0.45)', lineWidth: 2 },
    { amplitude: 42, wavelength: 0.005, speed: 0.010, color: 'rgba(168, 85, 247, 0.30)', lineWidth: 2.5 },
    { amplitude: 20, wavelength: 0.012, speed: 0.022, color: 'rgba(192, 132, 252, 0.20)', lineWidth: 1.5 },
    { amplitude: 35, wavelength: 0.007, speed: -0.012, color: 'rgba(91, 33, 182, 0.35)', lineWidth: 2 }
  ];

  function drawWaveform() {
    const displayWidth = canvas.width / window.devicePixelRatio;
    const displayHeight = canvas.height / window.devicePixelRatio;
    const centerY = displayHeight * 0.52;

    ctx.clearRect(0, 0, displayWidth, displayHeight);

    waves.forEach((wave, index) => {
      ctx.beginPath();
      ctx.lineWidth = wave.lineWidth;
      ctx.strokeStyle = wave.color;

      for (let x = 0; x <= displayWidth; x += 3) {
        const sin1 = Math.sin(x * wave.wavelength + phase * wave.speed * 60 + index);
        const sin2 = Math.cos(x * 0.003 - phase * 0.008);
        const envelope = Math.sin((x / displayWidth) * Math.PI);
        const y = centerY + (sin1 * wave.amplitude + sin2 * 12) * Math.pow(envelope, 0.85);

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.stroke();
    });

    phase += 0.016;
    requestAnimationFrame(drawWaveform);
  }

  drawWaveform();
});
