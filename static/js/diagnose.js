"use strict";

let audioCtx, analyser, frameData, displayBuffer, mediaStream, mediaRecorder;

let drawing = false;
let durationSec = 0;
let recChunks = [];
let selectedDeviceId = null;
let lastBlob = null;
let lastSpectrogramDataUrl = null;

// ~how many seconds of history to display (ECG strip length)
const historySeconds = 2.0;

// visual gain (for drawing only, not audio)
let visualGain = 1.0;

const $ = (id) => document.getElementById(id);

const scope = $("scope");
const ctx = scope.getContext("2d");

const deviceSelect = $("deviceSelect");
const modeSelect = $("modeSelect");
const modeBadge = $("modeBadge");
const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnRecord = $("btnRecord");
const btnSave = $("btnSave");
const btnAnalyze = $("btnAnalyze");
const notesEl = $("notes");
const recordingName = $("recordingName");
const previewWrap = $("previewWrap");
const previewAudio = $("previewAudio");
const downloadLink = $("downloadLink");
const analyzeResult = $("analyzeResult");
const statusEl = $("status");
const durEl = $("dur");

function setStatus(msg, type = "info") {
  statusEl.textContent = msg || "";
  statusEl.classList.remove(
    "text-slate-500",
    "text-red-600",
    "text-emerald-600"
  );
  if (!msg) return;

  if (type === "error") statusEl.classList.add("text-red-600");
  else if (type === "success") statusEl.classList.add("text-emerald-600");
  else statusEl.classList.add("text-slate-500");

  // Mirror to global screen-reader live region if present
  const global = document.getElementById("globalStatus");
  if (global) {
    try {
      global.textContent = msg;
    } catch (e) {
      // ignore DOM exceptions
    }
  }
}

/* ---------- Devices ---------- */

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  deviceSelect.innerHTML = "";
  for (const d of devices) {
    if (d.kind === "audioinput") {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic (${d.deviceId.slice(0, 6)}…)`;
      deviceSelect.appendChild(opt);
    }
  }
  if (deviceSelect.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No audio inputs found";
    deviceSelect.appendChild(opt);
  }
  selectedDeviceId = deviceSelect.value;
}

deviceSelect?.addEventListener("change", (e) => {
  selectedDeviceId = e.target.value;
});

modeSelect?.addEventListener("change", () => {
  modeBadge.textContent = modeSelect.value;
});

/* ---------- Canvas / ECG-style waveform with measurements ---------- */

function resizeCanvas() {
  if (!scope.parentElement) return;
  scope.width = scope.parentElement.clientWidth;
  scope.height = scope.height || 260;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

let lastDrawTime = 0; // for FPS limiting

function drawWave(ts = 0) {
  if (!drawing || !analyser || !frameData || !displayBuffer) return;

  // ~30 FPS
  if (ts - lastDrawTime < 33) {
    requestAnimationFrame(drawWave);
    return;
  }
  lastDrawTime = ts;

  const w = scope.width;
  const h = scope.height;

  // Background
  ctx.fillStyle = "#020617"; // near-black
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.lineWidth = 1;

  // fine grid
  ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
  for (let x = 0; x < w; x += 10) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // bold grid
  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
  for (let x = 0; x < w; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Axes + measurements
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.5)";
  ctx.fillStyle = "rgba(148, 163, 184, 0.9)";
  ctx.lineWidth = 1;
  ctx.font =
    "10px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const leftMargin = 40; // space for Y labels
  const bottomMargin = 18; // space for time labels

  // y-axis line
  ctx.beginPath();
  ctx.moveTo(leftMargin, 0);
  ctx.lineTo(leftMargin, h - bottomMargin);
  ctx.stroke();

  // x-axis line
  ctx.beginPath();
  ctx.moveTo(leftMargin, h - bottomMargin);
  ctx.lineTo(w, h - bottomMargin);
  ctx.stroke();

  // Y-axis labels (normalized amplitude)
  const midY = (h - bottomMargin) / 2;
  const baseAmplitude = (h - bottomMargin) * 0.4;

  const yVals = [1, 0.5, 0, -0.5, -1];
  yVals.forEach((val) => {
    const y = midY - val * baseAmplitude;
    ctx.beginPath();
    ctx.moveTo(leftMargin - 4, y);
    ctx.lineTo(leftMargin + 4, y);
    ctx.stroke();
    ctx.fillText(val.toFixed(1), leftMargin - 6, y);
  });

  // X-axis time labels (0 to historySeconds)
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const usableWidth = w - leftMargin;
  const step = 0.5; // seconds per tick label

  for (let t = 0; t <= historySeconds + 1e-6; t += step) {
    const x = leftMargin + (t / historySeconds) * usableWidth;
    ctx.beginPath();
    ctx.moveTo(x, h - bottomMargin);
    ctx.lineTo(x, h - bottomMargin + 4);
    ctx.stroke();

    ctx.fillText(`${t.toFixed(1)}s`, x, h - bottomMargin + 4);
  }
  ctx.restore();

  // Get analyser data
  analyser.getFloatTimeDomainData(frameData);

  // --- Auto visual gain based on current frame amplitude ---
  let peak = 0;
  for (let i = 0; i < frameData.length; i++) {
    const v = Math.abs(frameData[i]);
    if (v > peak) peak = v;
  }

  // if almost silence, keep gain=1
  if (peak < 0.0005) {
    // very quiet, don't explode gain
    // slightly decay back toward 1
    visualGain = 0.98 * visualGain + 0.02 * 1;
  } else {
    const targetPeak = 0.7; // we want the peaks to use ~70% of vertical range
    let desiredGain = targetPeak / peak;
    // Limit how crazy we go
    desiredGain = Math.min(Math.max(desiredGain, 1), 10); // 1x to 10x
    // Smooth the gain to avoid jitter
    visualGain = 0.9 * visualGain + 0.1 * desiredGain;
  }

  // Push new frame into history buffer
  displayBuffer.copyWithin(0, frameData.length);
  displayBuffer.set(frameData, displayBuffer.length - frameData.length);

  // Draw waveform (history)
  const len = displayBuffer.length;
  const slice = usableWidth / len;

  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    let v = displayBuffer[i];
    if (Number.isNaN(v)) v = 0;
    v = Math.max(-1, Math.min(1, v));

    // apply visual gain ONLY for drawing
    let vScaled = v * visualGain;
    vScaled = Math.max(-1, Math.min(1, vScaled)); // avoid going off-screen too much

    const x = leftMargin + i * slice;
    const y = midY - vScaled * baseAmplitude;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = "#22c55e"; // ECG green
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(34, 197, 94, 0.35)";
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Optional: small gain indicator (top-right)
  ctx.save();
  ctx.font =
    "10px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillStyle = "rgba(148,163,184,0.8)";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(`Gain x${visualGain.toFixed(1)}`, w - 6, 4);
  ctx.restore();

  requestAnimationFrame(drawWave);
}

/* ---------- Audio start/stop ---------- */

async function startAudio() {
  try {
    const constraints = {
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false, // audio is raw – gain only in visual
      },
      video: false,
    };

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(mediaStream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;

    const bufferLength = analyser.fftSize;
    frameData = new Float32Array(bufferLength);

    const sampleRate = audioCtx.sampleRate || 44100;
    let historySamples = Math.floor(sampleRate * historySeconds);

    // make historySamples multiple of frameData.length
    const multiple = Math.ceil(historySamples / bufferLength);
    historySamples = multiple * bufferLength;

    displayBuffer = new Float32Array(historySamples);

    src.connect(analyser);

    drawing = true;
    visualGain = 1.0; // reset visual gain on every start
    requestAnimationFrame(drawWave);

    btnStart.disabled = true;
    btnStop.disabled = false;
    btnRecord.disabled = false;

    setStatus("Live preview started.");
  } catch (e) {
    console.error(e);
    setStatus("Mic error: " + e.message, "error");
  }
}

function stopAudio() {
  drawing = false;

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  const w = scope.width;
  const h = scope.height;
  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, w, h);

  btnStart.disabled = false;
  btnStop.disabled = true;
  btnRecord.disabled = true;
  btnSave.disabled = true;
  btnAnalyze.disabled = true;
  btnRecord.textContent = "Record";

  setStatus("Stopped.");
}

btnStart?.addEventListener("click", startAudio);
btnStop?.addEventListener("click", stopAudio);

/* ---------- Recording ---------- */

let recTimer = null;

btnRecord?.addEventListener("click", () => {
  if (!mediaStream) {
    setStatus("No audio stream. Please start preview first.", "error");
    return;
  }

  // Toggle recording
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    setStatus("Finalizing recording...");
    btnRecord.disabled = true;
    return;
  }

  recChunks = [];
  durationSec = 0;
  durEl.textContent = durationSec.toFixed(1);
  previewWrap.classList.add("hidden");
  downloadLink.classList.add("hidden");
  lastBlob = null;

  // Choose supported mimeType
  let mime = "";
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
    if (MediaRecorder.isTypeSupported("audio/wav;codecs=opus")) {
      mime = "audio/wav;codecs=opus";
    } else if (MediaRecorder.isTypeSupported("audio/wav")) {
      mime = "audio/wav";
    } else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
      mime = "audio/ogg;codecs=opus";
    }
  }

  try {
    mediaRecorder = mime
      ? new MediaRecorder(mediaStream, { mimeType: mime })
      : new MediaRecorder(mediaStream);
  } catch (e) {
    try {
      mediaRecorder = new MediaRecorder(mediaStream);
    } catch (err) {
      setStatus("Recording not supported: " + err.message, "error");
      return;
    }
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    clearInterval(recTimer);

    if (!recChunks.length) {
      setStatus("No audio captured.", "error");
      btnRecord.textContent = "Record";
      btnRecord.disabled = false;
      return;
    }

    btnSave.disabled = false;
    btnAnalyze.disabled = false;

    setStatus(
      `Recorded ${durationSec.toFixed(
        1
      )}s. Click Save to upload or preview/download.`,
      "success"
    );

    lastBlob = new Blob(recChunks, {
      type: recChunks[0]?.type || "audio/wav",
    });

    const url = URL.createObjectURL(lastBlob);
    if (previewAudio) {
      previewAudio.src = url;
      previewWrap.classList.remove("hidden");
      downloadLink.href = url;
      downloadLink.classList.remove("hidden");
      // Try to generate a spectrogram preview on the server (Python)
      (async () => {
        try {
          const file = new File([lastBlob], "preview.wav", {
            type: lastBlob.type,
          });
          const fd = new FormData();
          fd.append("audio", file);
          const resp = await fetch("/api/spectrogram_preview", {
            method: "POST",
            body: fd,
          });
          if (!resp.ok) {
            // server didn't return an image; skip
            console.warn("Spectrogram preview failed", resp.status);
            return;
          }
          const blob = await resp.blob();
          const imgUrl = URL.createObjectURL(blob);
          const specWrap = document.getElementById("previewSpecWrap");
          const specImg = document.getElementById("previewSpecImg");
          if (specImg) {
            specImg.src = imgUrl;
            if (specWrap) specWrap.classList.remove("hidden");
          }
        } catch (e) {
          console.warn("Spectrogram preview error", e);
        }
      })();
    }

    btnRecord.textContent = "Record";
    btnRecord.disabled = false;
  };

  mediaRecorder.start(250);

  recTimer = setInterval(() => {
    durationSec += 0.25;
    durEl.textContent = durationSec.toFixed(1);
  }, 250);

  setStatus("Recording...");
  btnRecord.textContent = "Stop";
  btnRecord.disabled = false;
});

/* ---------- Save & Analyze (upload) ---------- */

btnSave?.addEventListener("click", async () => {
  if (!((recChunks && recChunks.length) || lastBlob)) return;

  const blob =
    lastBlob ||
    new Blob(recChunks, { type: recChunks[0]?.type || "audio/wav" });

  const file = new File([blob], "capture.wav", { type: blob.type });
  const fd = new FormData();

  fd.append("audio", file);
  fd.append(
    "meta",
    JSON.stringify({
      durationSec,
      deviceLabel:
        deviceSelect.options[deviceSelect.selectedIndex]?.text || null,
      mode: modeSelect.value,
      notes: notesEl?.value || null,
      title: recordingName?.value || null,
    })
  );

  try {
    setStatus("");
    statusEl.innerHTML = `
      <div style="width:100%">
        <div id="uploadBar"
             style="height:8px;background:#e5e7eb;border-radius:6px;overflow:hidden">
          <div id="uploadInner"
               style="width:0%;height:8px;background:#6366f1;transition:width 80ms linear;"></div>
        </div>
        <div id="uploadPct"
             style="font-size:12px;margin-top:6px;color:#6b7280">
          Uploading: 0%
        </div>
      </div>
    `;

    const uploadResult = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        const inner = document.getElementById("uploadInner");
        const pctEl = document.getElementById("uploadPct");
        if (inner) inner.style.width = pct + "%";
        if (pctEl) pctEl.textContent = "Uploading: " + pct + "%";
      };
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          try {
            const j = JSON.parse(xhr.responseText || "{}");
            if (xhr.status >= 200 && xhr.status < 300 && j.ok) {
              setStatus("Saved ✓", "success");
              resolve(j);
            } else {
              reject(new Error(j.error || "Upload failed"));
            }
          } catch (e) {
            reject(e);
          }
        }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(fd);
    });

    if (uploadResult && uploadResult.id) {
      setStatus("Uploaded. Running analysis...");
      try {
        const res = await fetch(`/api/analyze/${uploadResult.id}`, {
          method: "POST",
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text || "{}");
        } catch (parseErr) {
          // server returned non-JSON (likely HTML error page)
          showAnalysisError({
            error_type: "server_response_not_json",
            hint: "Server returned an HTML or non-JSON response.",
            detail: text.substring(0, 200),
          });
          setStatus(
            "Analysis failed: server error (non-JSON response)",
            "error"
          );
          console.error("Analyze response parse error", parseErr, text);
          return;
        }

        if (res.ok && json && json.ok) {
          showAnalysis(json.results, json.took_ms, uploadResult.id);
        } else {
          // Show friendly analysis error in the analysis panel
          showAnalysisError(json || { error: "analyze_failed", detail: text });
          setStatus(
            "Analysis failed: " +
              ((json && (json.hint || json.error)) || "Unknown"),
            "error"
          );
        }
      } catch (err) {
        setStatus("Analyze request failed: " + err.message, "error");
      }
    }
  } catch (e) {
    setStatus("Upload error: " + e.message, "error");
  } finally {
    btnSave.disabled = true;
    btnRecord.disabled = false;
  }
});

// Analyze button: quick upload+analyze with current blob
btnAnalyze?.addEventListener("click", async () => {
  if (!lastBlob) {
    setStatus("No recording to analyze.", "error");
    return;
  }

  btnAnalyze.disabled = true;

  try {
    setStatus("Generating spectrogram...");
    try {
      lastSpectrogramDataUrl = await generateSpectrogramFromBlob(lastBlob);
    } catch (e) {
      console.warn("Spectrogram generation failed", e);
      lastSpectrogramDataUrl = null;
    }

    // show a quick local analysis card with spectrogram while server runs
    // we call upload & analyze afterwards but keep the spectrogram visible
    // create a temporary placeholder analysis UI
    analyzeResult.innerHTML = `<div class="card p-4"><h4 class="font-semibold">Analysis (running)</h4><div class="mt-3">Generating analysis — please wait…</div><div class="mt-4"><div class="text-sm text-slate-600 mb-2">Spectrogram (preview)</div><div class="w-full bg-slate-50 p-2 rounded"><img id="specImg" src="${
      lastSpectrogramDataUrl || ""
    }" alt="Spectrogram preview" class="w-full rounded" style="max-height:320px;object-fit:contain" /></div></div></div>`;

    const file = new File([lastBlob], "capture.wav", { type: lastBlob.type });
    const fd = new FormData();
    fd.append("audio", file);
    fd.append(
      "meta",
      JSON.stringify({
        durationSec,
        deviceLabel:
          deviceSelect.options[deviceSelect.selectedIndex]?.text || null,
        mode: modeSelect.value,
        notes: notesEl?.value || null,
        title: recordingName?.value || null,
      })
    );

    setStatus("Uploading for analysis...");
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Upload failed");

    setStatus("Running analysis...");
    const res = await fetch(`/api/analyze/${j.id}`, { method: "POST" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text || "{}");
    } catch (parseErr) {
      showAnalysisError({
        error_type: "server_response_not_json",
        hint: "Server returned an HTML or non-JSON response.",
        detail: text.substring(0, 200),
      });
      setStatus("Analysis failed: server error (non-JSON response)", "error");
      console.error("Analyze response parse error", parseErr, text);
      return;
    }

    if (res.ok && json && json.ok) {
      showAnalysis(json.results, json.took_ms, j.id, lastSpectrogramDataUrl);
    } else {
      showAnalysisError(json || { error: "analyze_failed", detail: text });
      setStatus(
        "Analysis failed: " +
          ((json && (json.hint || json.error)) || "Unknown"),
        "error"
      );
    }
  } catch (err) {
    setStatus("Analyze flow failed: " + err.message, "error");
  } finally {
    btnAnalyze.disabled = false;
  }
});

/* ---------- Show analysis ---------- */

function showAnalysis(results, took_ms, rec_id) {
  if (!analyzeResult) return;

  const r = results || {};
  const took = took_ms || 0;
  const probs = r.class_probabilities || {};
  let barsHtml = "";
  for (const [cls, val] of Object.entries(probs)) {
    const pct = Math.round(val * 100);
    barsHtml += `
      <div class="mt-2">
        <div class="flex items-center justify-between text-xs text-slate-600 mb-1">
          <div class="font-medium">${cls}</div>
          <div class="text-xs">${pct}%</div>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-2">
          <div style="width:${pct}%" class="h-2 rounded-full bg-indigo-600"></div>
        </div>
      </div>`;
  }

  analyzeResult.innerHTML = `
    <div class="card p-4">
      <h4 class="font-semibold">Analysis Result</h4>
      <div class="mt-3 flex items-center justify-between">
        <div>
          <div class="text-sm text-slate-600">Decision</div>
          <div class="font-semibold text-lg">${r.overall_decision}</div>
        </div>
        <div class="text-right">
          <div class="text-sm text-slate-600">Predicted</div>
          <div class="font-semibold text-lg">${r.predicted_class}</div>
        </div>
      </div>

      <div class="mt-3">
        <div class="flex items-center justify-between text-xs text-slate-600 mb-1">
          <div>Confidence</div>
          <div class="font-medium">${r.confidence_percent}%</div>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-3">
          <div style="width:${r.confidence_percent}%" class="h-3 rounded-full ${
    r.confidence_percent >= 50 ? "bg-emerald-500" : "bg-rose-500"
  }"></div>
        </div>
      </div>

      <div class="mt-4">
        ${barsHtml}
      </div>

      <div class="mt-4">
        <div class="text-sm text-slate-600 mb-2">Spectrogram (first chunk)</div>
        <div class="w-full bg-slate-50 p-2 rounded">
          <img id="specImg" src="" alt="Spectrogram" class="w-full rounded" style="max-height:320px;object-fit:contain" />
        </div>
      </div>

      <div class="mt-3 text-xs text-slate-400">Processed in ${took} ms</div>
      <div class="mt-3 flex items-center gap-2">
        <button id="chatWithAiBtn" class="btn-outline">Chat with AI</button>
        <a href="/recordings" class="btn-outline">View Recordings</a>
      </div>
    </div>
  `;
  setStatus("Analysis complete", "success");

  // load spectrogram image if we have a recording id OR a local preview
  const specImg = document.getElementById("specImg");
  if (specImg) {
    if (window.__local_spec_dataurl) {
      specImg.src = window.__local_spec_dataurl;
    } else if (rec_id) {
      specImg.src = `/api/spectrogram/${rec_id}?chunk=0`;
    }
    specImg.addEventListener("error", () => {
      specImg.alt = "Spectrogram unavailable";
      specImg.style.display = "none";
    });
  }

  // wire chat button if available
  const chatBtn = document.getElementById("chatWithAiBtn");
  if (chatBtn && window.openChatWithAI) {
    const analysisText = `Decision: ${r.overall_decision}\nPredicted: ${
      r.predicted_class
    }\nConfidence: ${
      r.confidence_percent
    }%\nProcessed in ${took} ms\nClass probabilities:\n${Object.entries(probs)
      .map(([k, v]) => `${k}: ${(v * 100).toFixed(1)}%`)
      .join("\n")}`;
    chatBtn.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        window.openChatWithAI(analysisText);
      } catch (err) {
        console.error(err);
      }
    });
  }
}

/* ---------- Spectrogram generation (client-side) ---------- */

function hannWindow(N) {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++)
    w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  return w;
}

// simple in-place Cooley-Tukey radix-2 FFT (complex arrays)
function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("FFT length must be power of two");
  // bit reversal
  let j = 0;
  for (let i = 1; i < n - 1; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlen_r = Math.cos(ang);
    const wlen_i = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const u_r = re[i + j];
        const u_i = im[i + j];
        const v_r = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
        const v_i = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;

        re[i + j] = u_r + v_r;
        im[i + j] = u_i + v_i;
        re[i + j + len / 2] = u_r - v_r;
        im[i + j + len / 2] = u_i - v_i;

        const tmp_r = wr * wlen_r - wi * wlen_i;
        wi = wr * wlen_i + wi * wlen_r;
        wr = tmp_r;
      }
    }
  }
}

async function generateSpectrogramFromBlob(blob, opts = {}) {
  // opts: { fftSize, hopSize, maxHeight }
  const fftSize = opts.fftSize || 1024;
  const hopSize = opts.hopSize || 512;
  const maxHeight = opts.maxHeight || 256;

  const arrayBuffer = await blob.arrayBuffer();
  const audioCtxLocal = new (window.OfflineAudioContext ||
    window.webkitOfflineAudioContext)(1, 1, 44100);
  // decodeAudioData works on AudioContext too
  const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer.slice(0));
  try {
    tmpCtx.close && tmpCtx.close();
  } catch (e) {}

  // mix to mono
  const ch =
    audioBuffer.numberOfChannels > 0
      ? audioBuffer.getChannelData(0)
      : new Float32Array(0);
  if (audioBuffer.numberOfChannels > 1) {
    const len = audioBuffer.length;
    const mix = new Float32Array(len);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++)
        mix[i] = (mix[i] || 0) + d[i] / audioBuffer.numberOfChannels;
    }
    ch.set(mix);
  }

  const signal = ch;
  const sr = audioBuffer.sampleRate || 44100;
  const windowFn = hannWindow(fftSize);
  const frames = Math.max(
    1,
    Math.floor((signal.length - fftSize) / hopSize) + 1
  );
  const bins = Math.min(maxHeight, fftSize / 2);

  // compute spectrogram magnitude (dB)
  const spec = new Float32Array(frames * bins);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const off = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      const s = signal[off + i] || 0;
      re[i] = s * windowFn[i];
      im[i] = 0;
    }
    try {
      fft(re, im);
    } catch (e) {
      // FFT failed (non-power-of-two) fallback: zero spectrogram
      for (let b = 0; b < bins; b++) spec[f * bins + b] = -100;
      continue;
    }

    // magnitude for first bins
    for (let b = 0; b < bins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      // convert to dB
      const db = 20 * Math.log10(mag + 1e-8);
      spec[f * bins + b] = db;
    }
  }

  // normalize spectrogram to 0..1 by mapping dB range
  let minDb = Infinity,
    maxDb = -Infinity;
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] < minDb) minDb = spec[i];
    if (spec[i] > maxDb) maxDb = spec[i];
  }
  if (!isFinite(minDb) || !isFinite(maxDb) || maxDb === minDb) {
    minDb = -100;
    maxDb = 0;
  }

  // draw to canvas: width = frames, height = bins
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(32, frames);
  canvas.height = Math.max(32, bins);
  const cctx = canvas.getContext("2d");
  const img = cctx.createImageData(canvas.width, canvas.height);

  for (let x = 0; x < canvas.width; x++) {
    const srcF = Math.floor((x / canvas.width) * frames);
    for (let y = 0; y < canvas.height; y++) {
      // map y -> frequency bin (flip vertically so low freq bottom)
      const bin = canvas.height - 1 - y;
      const v = spec[srcF * bins + bin];
      const norm = (v - minDb) / (maxDb - minDb);
      const val = Math.max(0, Math.min(1, norm));
      // grayscale color mapping (can replace with gradient)
      const color = Math.round((1 - val) * 230);
      const idx = (y * canvas.width + x) * 4;
      img.data[idx] = color; // R
      img.data[idx + 1] = color; // G
      img.data[idx + 2] = color; // B
      img.data[idx + 3] = 255;
    }
  }
  cctx.putImageData(img, 0, 0);

  // scale canvas to a reasonable display height if needed
  const displayCanvas = document.createElement("canvas");
  const displayW = Math.min(800, canvas.width);
  const scale = Math.min(1, displayW / canvas.width);
  displayCanvas.width = Math.floor(canvas.width * scale);
  displayCanvas.height = Math.floor(canvas.height * scale);
  const dctx = displayCanvas.getContext("2d");
  dctx.drawImage(canvas, 0, 0, displayCanvas.width, displayCanvas.height);

  const dataUrl = displayCanvas.toDataURL("image/png");
  // store to window for showAnalysis to pick up if needed
  window.__local_spec_dataurl = dataUrl;
  return dataUrl;
}

function showAnalysisError(json) {
  if (!analyzeResult) return;
  const errType = json.error_type || "unknown_error";
  const hint = json.hint || "";
  const detail = json.detail || json.error || "";
  analyzeResult.innerHTML = `
    <div class="card p-3 bg-rose-50 border border-rose-100 text-rose-800">
      <div class="font-semibold">Analysis failed</div>
      <div class="mt-1 text-xs">Reason: ${errType}</div>
      ${hint ? `<div class="mt-2 text-xs text-slate-700">${hint}</div>` : ""}
      <details class="mt-2 text-xs"><summary>Technical details</summary><pre class="mt-2 p-2 bg-white text-xs text-slate-700 rounded">${detail}</pre></details>
    </div>`;
}

/* ---------- Init ---------- */

(async function init() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // user may allow later
  }
  await listDevices();
  setStatus("Select a device and click Start.");
})();
