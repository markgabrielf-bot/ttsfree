// Page logic. The model runs in inference-worker.js.
"use strict";
const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 24000;
const MAX_CLONE_SECONDS = 10;
const MIN_CLONE_SECONDS = 3;
const CACHE_PREFIX = "open-voice-tts-";
const STORE_KEY = "open-voice-tts";

// Only voices whose source recordings allow commercial use (CC0 or CC BY 4.0).
// "cosette" and "jean" come from non-commercial datasets and are left out.
const ALLOWED_VOICES = ["alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles",
  "eponine", "eve", "fantine", "george", "jane", "javert", "marius", "mary", "michael",
  "paul", "peter_yearsley", "stuart_bell", "vera"];

let worker = null;
let ready = false;      // model loaded
let busy = false;       // loading, cloning or generating
let generating = false;
let hasClone = false;
let recorder = null;
let chunks = [];
let urls = [];          // object URLs of the current result
let lastMetrics = null;
let runVoice = "";
let mp3Job = 0;

// ---------- small helpers ----------
function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}

function setProgress(value) {
  const bar = $("progress");
  if (value === null) { bar.hidden = true; return; }
  bar.hidden = false;
  if (value === undefined) bar.removeAttribute("value"); // indeterminate
  else bar.value = Math.max(0, Math.min(1, value));
}

const mb = (bytes) => (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0);
const seconds = (samples) => samples / SAMPLE_RATE;
const voiceLabel = (name) => name === "custom" ? "My cloned voice"
  : name.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ text: $("text").value, voice: $("voice").value, live: $("live").checked }));
  } catch { /* storage unavailable */ }
}
function saved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

function refresh() {
  const recording = recorder !== null;
  const idle = ready && !busy && !recording;
  $("load").disabled = worker !== null;
  $("voice").disabled = !idle;
  $("generate").disabled = !idle;
  $("generate").textContent = generating ? "Generating…" : "Generate speech";
  $("stop").disabled = !generating;
  $("upload").disabled = !(idle && $("consent").checked);
  $("record").disabled = !(recording || (idle && $("consent").checked));
  $("record").textContent = recording ? "Stop recording" : "Record";
  $("record").classList.toggle("recording", recording);
  $("forget").hidden = !hasClone;
  $("forget").disabled = !idle;
  document.body.classList.toggle("busy", busy);
  $("load").hidden = ready;
}

// ---------- live playback while generating ----------
let audioCtx = null;
let playHead = 0;
let liveSources = [];

function startLive() {
  stopLive();
  if (!$("live").checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    playHead = 0;
  } catch { audioCtx = null; }
}

function playLive(samples) {
  if (!audioCtx || !$("live").checked || !samples.length) return;
  const buffer = audioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.copyToChannel(samples, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  // If playback caught up with generation, wait a moment so the next part does not stutter.
  const now = audioCtx.currentTime;
  const at = playHead > now ? playHead : now + 0.3;
  source.start(at);
  playHead = at + buffer.duration;
  liveSources.push(source);
  source.onended = () => { liveSources = liveSources.filter((s) => s !== source); };
}

function stopLive() {
  for (const s of liveSources) { try { s.stop(); } catch { /* already stopped */ } }
  liveSources = [];
  playHead = 0;
}

// ---------- model loading ----------
function loadModel() {
  setStatus("Starting…");
  setProgress(undefined);
  busy = true;
  worker = new Worker("inference-worker.js");
  worker.onmessage = (event) => handle(event.data);
  worker.onerror = (event) => fail(event.message || "The model worker could not start.");
  worker.postMessage({ type: "load" });
  refresh();
}

function fail(message) {
  busy = generating = false;
  stopLive();
  setProgress(null);
  const loading = !ready && worker !== null;
  if (loading) { worker.terminate(); worker = null; }
  setStatus(loading
    ? `The model did not load. Check that you can reach huggingface.co and cdn.jsdelivr.net, then try again. (${message})`
    : `Something went wrong: ${message}`, true);
  refresh();
}

function showVoices(names) {
  const options = names.filter((n) => ALLOWED_VOICES.includes(n)).map((n) => new Option(voiceLabel(n), n));
  $("voice").replaceChildren(...options);
  const wanted = saved().voice;
  if (wanted && names.includes(wanted)) $("voice").value = wanted;
  else if (names.includes("alba")) $("voice").value = "alba";
}

function showDownload({ label, loaded, total }) {
  if (ready && label !== "encoder") return;
  const what = label === "encoder" ? "voice encoder" : "voice model";
  if (total) {
    setProgress(loaded / total);
    setStatus(`Downloading ${what}… ${mb(loaded)} of ${mb(total)} MB (${Math.floor((loaded / total) * 100)}%)`);
  } else {
    setProgress(undefined);
    setStatus(`Downloading ${what}… ${mb(loaded)} MB`);
  }
}

function handle(message) {
  switch (message.type) {
    case "voices_loaded":
      showVoices(message.voices);
      break;
    case "loaded":
      ready = true; busy = false;
      setProgress(null);
      setStatus("Ready. Type something and press Generate speech.");
      checkCache();
      break;
    case "download":
      showDownload(message);
      return;
    case "status":
      if (message.metrics) lastMetrics = message.metrics;
      if (busy && !generating && message.state === "loading") {
        setStatus(message.status);
        if (!$("progress").hidden) setProgress(undefined);
      }
      return;
    case "progress":
      if (generating && message.parts > 1) {
        setProgress((message.part - 1) / message.parts);
        $("status").dataset.part = `Part ${message.part} of ${message.parts}. `;
      }
      return;
    case "voice_encoded":
      hasClone = true; busy = false;
      setProgress(null);
      if (![...$("voice").options].some((o) => o.value === "custom")) {
        $("voice").prepend(new Option(voiceLabel("custom"), "custom"));
      }
      $("voice").value = "custom";
      setStatus("Cloned voice is ready and selected.");
      break;
    case "voice_cleared":
      break;
    case "audio_chunk":
      chunks.push(message.data);
      playLive(message.data);
      setStatus(`Generating… ${$("status").dataset.part || ""}${seconds(chunks.reduce((n, c) => n + c.length, 0)).toFixed(1)} s of audio so far.`);
      return;
    case "generation_done":
      finishGeneration(message);
      break;
    case "error":
      // A generation error is followed by "generation_done", which unlocks the page.
      if (generating) setStatus(`Something went wrong: ${message.error}`, true);
      else fail(message.error);
      return;
    default:
      return;
  }
  refresh();
}

// ---------- generating ----------
function generate() {
  if ($("generate").disabled) return;
  const text = $("text").value.trim();
  if (!text) { setStatus("Type some text first.", true); $("text").focus(); return; }
  chunks = [];
  lastMetrics = null;
  runVoice = $("voice").value;
  busy = generating = true;
  delete $("status").dataset.part;
  $("player").pause();
  startLive();
  setStatus("Generating…");
  setProgress(undefined);
  worker.postMessage({ type: "generate", data: { text, voice: runVoice } });
  save();
  refresh();
}

function stopGeneration() {
  worker.postMessage({ type: "stop" });
  stopLive();
  setStatus("Stopping…");
}

function finishGeneration({ stopped, failed }) {
  busy = generating = false;
  setProgress(null);
  delete $("status").dataset.part;
  if (failed) { stopLive(); chunks = []; return; }
  if (!chunks.length) { setStatus("Stopped."); return; }
  try {
    showResult(AudioTools.joinChunks(chunks), stopped);
  } catch (error) {
    setStatus(`Could not prepare the audio: ${error.message}`, true);
  }
  chunks = [];
}

function fileName(ext) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `speech-${runVoice === "custom" ? "cloned" : runVoice}-${stamp}.${ext}`;
}

function showResult(samples, stopped) {
  urls.forEach((u) => URL.revokeObjectURL(u));
  const wavUrl = URL.createObjectURL(new Blob([AudioTools.encodeWav(samples, SAMPLE_RATE)], { type: "audio/wav" }));
  urls = [wavUrl];

  drawWave(samples);
  $("player").src = wavUrl;
  $("download-wav").href = wavUrl;
  $("download-wav").download = fileName("wav");

  const length = seconds(samples.length);
  const speed = lastMetrics && lastMetrics.genTime > 0 && !stopped
    ? ` · made in ${lastMetrics.genTime.toFixed(1)} s (${(length / lastMetrics.genTime).toFixed(1)}× real time)` : "";
  $("meta").textContent = `${voiceLabel(runVoice)} · ${length.toFixed(1)} s${speed}`;
  $("result").hidden = false;
  setStatus(stopped
    ? `Stopped. Kept the first ${length.toFixed(1)} s of audio.`
    : "Done. Press play or download your audio.");

  // MP3 takes longer to encode, so it is prepared in the background.
  const job = ++mp3Job;
  const link = $("download-mp3");
  link.removeAttribute("href");
  link.setAttribute("aria-disabled", "true");
  link.textContent = "Preparing MP3…";
  AudioTools.encodeMp3(samples, SAMPLE_RATE, {
    onProgress: (p) => { if (job === mp3Job) link.textContent = `Preparing MP3… ${Math.floor(p * 100)}%`; },
  }).then((parts) => {
    if (job !== mp3Job) return;
    const mp3Url = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    urls.push(mp3Url);
    link.href = mp3Url;
    link.download = fileName("mp3");
    link.removeAttribute("aria-disabled");
    link.textContent = "Download MP3";
  }).catch((error) => {
    if (job === mp3Job) link.textContent = `MP3 failed: ${error.message}`;
  });
}

// Draws the loudness of the generated audio as bars.
function drawWave(samples) {
  const bars = Math.max(32, Math.min(96, Math.round($("wave").clientWidth / 6) || 64));
  const size = Math.max(1, Math.floor(samples.length / bars));
  const peaks = Array.from({ length: bars }, (_, b) => {
    let peak = 0;
    for (let i = b * size; i < Math.min(samples.length, (b + 1) * size); i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    return peak;
  });
  const loudest = Math.max(...peaks) || 1;
  $("wave").replaceChildren(...peaks.map((peak) => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(6, (peak / loudest) * 100)}%`;
    return bar;
  }));
}

function showProgress() {
  const { currentTime, duration } = $("player");
  const bars = $("wave").children;
  const played = duration ? (currentTime / duration) * bars.length : 0;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("played", i < played);
}

function seek(event) {
  const player = $("player");
  if (!player.duration) return;
  const box = $("wave").getBoundingClientRect();
  player.currentTime = ((event.clientX - box.left) / box.width) * player.duration;
  player.play();
}

function countText() {
  const field = $("text");
  const left = field.maxLength - field.value.length;
  $("count").textContent = `${field.value.length.toLocaleString()} / ${field.maxLength.toLocaleString()} characters`;
  $("count").classList.toggle("warn", left < 250);
}

// ---------- cloning ----------
async function cloneFrom(blob) {
  busy = true;
  setStatus("Reading the recording…");
  setProgress(undefined);
  refresh();
  try {
    // Decoding in a 24 kHz context resamples the audio to the model's rate.
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    const audio = AudioTools.prepareVoiceSample(mono, SAMPLE_RATE, MAX_CLONE_SECONDS);
    if (seconds(audio.length) < MIN_CLONE_SECONDS) {
      throw new Error(`the recording has less than ${MIN_CLONE_SECONDS} seconds of speech. Try a longer or louder one.`);
    }
    setStatus(`Cloning the voice from ${seconds(audio.length).toFixed(1)} s of speech…`);
    worker.postMessage({ type: "encode_voice", data: { audio } }, [audio.buffer]);
  } catch (error) {
    fail(error.message || "this audio file could not be read.");
  }
}

async function toggleRecording() {
  if (recorder) {
    if (recorder.state === "recording") recorder.stop();
    return;
  }
  busy = true;
  refresh();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const active = new MediaRecorder(stream);
    const parts = [];
    const started = Date.now();
    let timer, ticker;
    active.ondataavailable = (e) => parts.push(e.data);
    active.onstop = () => {
      clearTimeout(timer);
      clearInterval(ticker);
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      cloneFrom(new Blob(parts, { type: active.mimeType }));
    };
    active.start();
    recorder = active;
    busy = false;
    timer = setTimeout(() => { if (active.state === "recording") active.stop(); }, MAX_CLONE_SECONDS * 1000);
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      setStatus(`Recording… speak now. ${s} s (stops at ${MAX_CLONE_SECONDS} s).`);
      setProgress(s / MAX_CLONE_SECONDS);
    };
    tick();
    ticker = setInterval(tick, 250);
    refresh();
  } catch (error) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    fail(`microphone unavailable (${error.message}).`);
  }
}

function forgetClone() {
  worker.postMessage({ type: "clear_voice" });
  hasClone = false;
  const option = [...$("voice").options].find((o) => o.value === "custom");
  if (option) option.remove();
  if (!$("voice").value && $("voice").options.length) $("voice").selectedIndex = 0;
  setStatus("Your cloned voice was forgotten.");
  refresh();
}

// ---------- stored model files ----------
async function checkCache() {
  try {
    const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
    $("clear-cache").hidden = keys.length === 0;
  } catch { $("clear-cache").hidden = true; }
}

async function clearCache() {
  try {
    const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
    await Promise.all(keys.map((k) => caches.delete(k)));
    $("clear-cache").hidden = true;
    setStatus("Downloaded model files were removed from this browser. They download again on the next load.");
  } catch (error) {
    setStatus(`Could not remove the files: ${error.message}`, true);
  }
}

// ---------- wiring ----------
$("player").ontimeupdate = showProgress;
$("player").onplay = stopLive;
$("wave").onclick = seek;
$("text").oninput = () => { countText(); save(); };
$("text").onkeydown = (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
};
$("voice").onchange = save;
$("live").onchange = () => { if (!$("live").checked) stopLive(); save(); };
$("load").onclick = loadModel;
$("generate").onclick = generate;
$("stop").onclick = stopGeneration;
$("consent").onchange = refresh;
$("record").onclick = toggleRecording;
$("forget").onclick = forgetClone;
$("clear-cache").onclick = clearCache;
$("download-mp3").onclick = (e) => { if (!$("download-mp3").href) e.preventDefault(); };
$("upload").onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) cloneFrom(file);
};

(() => {
  const state = saved();
  if (typeof state.text === "string" && state.text.trim()) $("text").value = state.text;
  if (typeof state.live === "boolean") $("live").checked = state.live;
})();
countText();
checkCache();
refresh();
