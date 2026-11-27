// Page logic for Philippine languages. The model runs in mms-worker.js.
"use strict";
const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 16000;
const CACHE_PREFIX = "ovtts-mms-";
const STORE_KEY = "open-voice-tts-fil";

const LANGS = {
  tgl: { name: "Tagalog", sample: "Magandang araw! Paalala mula sa Bureau of Fire Protection: huwag iwanang nakasaksak ang mga appliances kapag hindi ginagamit." },
  ceb: { name: "Bisaya", sample: "Maayong adlaw! Pahinumdom gikan sa Bureau of Fire Protection: ayaw biyai nga nakasaksak ang mga appliances kung dili gamiton." },
  war: { name: "Waray", sample: "Maupay nga adlaw! Pahinumdom tikang ha Bureau of Fire Protection: ayaw pagbilin nga nakasaksak an mga appliances kon diri ginagamit." },
  hil: { name: "Hiligaynon", sample: "Maayong adlaw! Paandam halin sa Bureau of Fire Protection: indi pagbayai nga nakasaksak ang mga appliances kon wala ginagamit." },
};
const isSample = (text) => !text.trim() || Object.values(LANGS).some((l) => l.sample === text.trim());

let worker = null;
let loadedLang = null;
let busy = false;
let generating = false;
let chunks = [];
let urls = [];
let runLang = "tgl";
let runStarted = 0;
let mp3Job = 0;

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}
function setProgress(value) {
  const bar = $("progress");
  if (value === null) { bar.hidden = true; return; }
  bar.hidden = false;
  if (value === undefined) bar.removeAttribute("value"); else bar.value = Math.max(0, Math.min(1, value));
}
const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
const seconds = (n) => n / SAMPLE_RATE;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      text: $("text").value, lang: $("lang").value, speed: $("speed").value,
      variation: $("variation").value, live: $("live").checked,
    }));
  } catch { /* storage unavailable */ }
}
function saved() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }

function refresh() {
  const ready = loadedLang !== null;
  const idle = !busy;
  const lang = $("lang").value;
  $("lang").disabled = !idle;
  $("load").hidden = ready && loadedLang === lang;
  $("load").disabled = !idle;
  $("load").textContent = `Load ${LANGS[lang].name} voice`;
  $("generate").disabled = !(idle && ready && loadedLang === lang);
  $("generate").textContent = generating ? "Generating…" : "Generate speech";
  $("stop").disabled = !generating;
  document.body.classList.toggle("busy", busy);
}

// ---------- live playback ----------
let audioCtx = null, playHead = 0, liveSources = [];
function startLive() {
  stopLive();
  if (!$("live").checked) return;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { audioCtx = null; }
}
function playLive(samples) {
  if (!audioCtx || !$("live").checked || !samples.length) return;
  const buffer = audioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.copyToChannel(samples, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  const at = playHead > now ? playHead : now + 0.2;
  source.start(at);
  playHead = at + buffer.duration;
  liveSources.push(source);
  source.onended = () => { liveSources = liveSources.filter((s) => s !== source); };
}
function stopLive() {
  for (const s of liveSources) { try { s.stop(); } catch { /* done */ } }
  liveSources = []; playHead = 0;
}

// ---------- worker ----------
function ensureWorker() {
  if (worker) return;
  worker = new Worker("mms-worker.js");
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => {
    worker = null; loadedLang = null;
    fail(e.message || "The voice worker could not start.");
  };
}

function load() {
  ensureWorker();
  busy = true;
  loadedLang = null;
  setStatus("Starting…");
  setProgress(undefined);
  worker.postMessage({ type: "load", data: { lang: $("lang").value } });
  refresh();
}

function fail(message) {
  busy = generating = false;
  stopLive();
  setProgress(null);
  setStatus(loadedLang === null
    ? `The voice did not load. Check that you can reach huggingface.co and cdn.jsdelivr.net, then try again. (${message})`
    : `Something went wrong: ${message}`, true);
  refresh();
}

function handle(m) {
  switch (m.type) {
    case "status":
      if (busy && !generating) setStatus(m.status);
      if (m.status.startsWith("Starting")) setProgress(undefined);
      return;
    case "download":
      if (m.total) {
        setProgress(m.loaded / m.total);
        setStatus(`Downloading ${LANGS[$("lang").value].name} voice… ${mb(m.loaded)} of ${mb(m.total)} MB (${Math.floor((m.loaded / m.total) * 100)}%)`);
      } else {
        setProgress(undefined);
        setStatus(`Downloading voice… ${mb(m.loaded)} MB`);
      }
      return;
    case "loaded":
      loadedLang = m.lang; busy = false;
      setProgress(null);
      setStatus(`${LANGS[m.lang].name} voice is ready.`);
      checkCache();
      break;
    case "progress":
      if (generating && m.parts > 1) {
        setProgress((m.part - 1) / m.parts);
        $("status").dataset.part = `Part ${m.part} of ${m.parts}. `;
      }
      return;
    case "audio_chunk":
      chunks.push(m.data);
      playLive(m.data);
      setStatus(`Generating… ${$("status").dataset.part || ""}${seconds(chunks.reduce((n, c) => n + c.length, 0)).toFixed(1)} s of audio so far.`);
      return;
    case "generation_done":
      finish(m);
      break;
    case "error":
      if (generating) setStatus(`Something went wrong: ${m.error}`, true);
      else fail(m.error);
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
  runLang = loadedLang;
  runStarted = performance.now();
  busy = generating = true;
  delete $("status").dataset.part;
  $("player").pause();
  startLive();
  setStatus("Generating…");
  setProgress(undefined);
  worker.postMessage({ type: "generate", data: { text, speed: Number($("speed").value), variation: Number($("variation").value) } });
  save();
  refresh();
}

function finish({ stopped, failed }) {
  busy = generating = false;
  setProgress(null);
  delete $("status").dataset.part;
  if (failed) { stopLive(); chunks = []; return; }
  // Drop a trailing pause, if any.
  while (chunks.length && chunks[chunks.length - 1].every((v) => v === 0)) chunks.pop();
  if (!chunks.length) { setStatus(stopped ? "Stopped." : "Nothing to read. Use letters the language uses.", !stopped); return; }
  const samples = AudioTools.joinChunks(chunks);
  chunks = [];
  normalize(samples);
  showResult(samples, stopped, (performance.now() - runStarted) / 1000);
}

function normalize(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0) { const g = Math.min(0.95 / peak, 4); for (let i = 0; i < samples.length; i++) samples[i] *= g; }
}

function fileName(ext) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `speech-${LANGS[runLang].name.toLowerCase()}-${stamp}.${ext}`;
}

function showResult(samples, stopped, took) {
  urls.forEach((u) => URL.revokeObjectURL(u));
  const wavUrl = URL.createObjectURL(new Blob([AudioTools.encodeWav(samples, SAMPLE_RATE)], { type: "audio/wav" }));
  urls = [wavUrl];
  drawWave(samples);
  $("player").src = wavUrl;
  $("download-wav").href = wavUrl;
  $("download-wav").download = fileName("wav");
  const length = seconds(samples.length);
  $("meta").textContent = `${LANGS[runLang].name} · ${length.toFixed(1)} s${stopped ? "" : ` · made in ${took.toFixed(1)} s`}`;
  $("result").hidden = false;
  setStatus(stopped ? `Stopped. Kept the first ${length.toFixed(1)} s of audio.` : "Done. Press play or download your audio.");

  const job = ++mp3Job;
  const link = $("download-mp3");
  link.removeAttribute("href");
  link.setAttribute("aria-disabled", "true");
  link.textContent = "Preparing MP3…";
  AudioTools.encodeMp3(samples, SAMPLE_RATE, {
    kbps: 64,
    onProgress: (p) => { if (job === mp3Job) link.textContent = `Preparing MP3… ${Math.floor(p * 100)}%`; },
  }).then((parts) => {
    if (job !== mp3Job) return;
    const u = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    urls.push(u);
    link.href = u;
    link.download = fileName("mp3");
    link.removeAttribute("aria-disabled");
    link.textContent = "Download MP3";
  }).catch((e) => { if (job === mp3Job) link.textContent = `MP3 failed: ${e.message}`; });
}

function drawWave(samples) {
  const bars = Math.max(32, Math.min(96, Math.round($("wave").clientWidth / 6) || 64));
  const size = Math.max(1, Math.floor(samples.length / bars));
  const peaks = Array.from({ length: bars }, (_, b) => {
    let peak = 0;
    for (let i = b * size; i < Math.min(samples.length, (b + 1) * size); i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak;
  });
  const loudest = Math.max(...peaks) || 1;
  $("wave").replaceChildren(...peaks.map((p) => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(6, (p / loudest) * 100)}%`;
    return bar;
  }));
}
function showPlayed() {
  const { currentTime, duration } = $("player");
  const bars = $("wave").children;
  const played = duration ? (currentTime / duration) * bars.length : 0;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("played", i < played);
}
function seek(e) {
  const p = $("player");
  if (!p.duration) return;
  const box = $("wave").getBoundingClientRect();
  p.currentTime = ((e.clientX - box.left) / box.width) * p.duration;
  p.play();
}

function countText() {
  const f = $("text");
  $("count").textContent = `${f.value.length.toLocaleString()} / ${f.maxLength.toLocaleString()} characters`;
  $("count").classList.toggle("warn", f.maxLength - f.value.length < 250);
}
function showSliders() {
  $("speed-value").textContent = `${Number($("speed").value).toFixed(2).replace(/0$/, "")}×`;
  const v = Number($("variation").value);
  $("variation-value").textContent = v < 0.6 ? "Steady" : v > 1.05 ? "Expressive" : "Normal";
}

function changeLang() {
  if (isSample($("text").value)) { $("text").value = LANGS[$("lang").value].sample; countText(); }
  save();
  // Switching after a voice is loaded downloads the new one straight away.
  if (loadedLang !== null && loadedLang !== $("lang").value) load();
  else refresh();
}

async function checkCache() {
  try { $("clear-cache").hidden = !(await caches.keys()).some((k) => k.startsWith(CACHE_PREFIX)); }
  catch { $("clear-cache").hidden = true; }
}
async function clearCache() {
  try {
    const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
    await Promise.all(keys.map((k) => caches.delete(k)));
    $("clear-cache").hidden = true;
    setStatus("Downloaded voices were removed from this browser.");
  } catch (e) { setStatus(`Could not remove the files: ${e.message}`, true); }
}

// ---------- wiring ----------
$("load").onclick = load;
$("generate").onclick = generate;
$("stop").onclick = () => { worker.postMessage({ type: "stop" }); stopLive(); setStatus("Stopping…"); };
$("lang").onchange = changeLang;
$("speed").oninput = () => { showSliders(); save(); };
$("variation").oninput = () => { showSliders(); save(); };
$("live").onchange = () => { if (!$("live").checked) stopLive(); save(); };
$("text").oninput = () => { countText(); save(); };
$("text").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); } };
$("player").ontimeupdate = showPlayed;
$("player").onplay = stopLive;
$("wave").onclick = seek;
$("clear-cache").onclick = clearCache;
$("download-mp3").onclick = (e) => { if (!$("download-mp3").href) e.preventDefault(); };

(() => {
  const s = saved();
  if (s.lang && LANGS[s.lang]) $("lang").value = s.lang;
  if (s.speed) $("speed").value = s.speed;
  if (s.variation) $("variation").value = s.variation;
  if (typeof s.live === "boolean") $("live").checked = s.live;
  $("text").value = typeof s.text === "string" && s.text.trim() ? s.text : LANGS[$("lang").value].sample;
})();
countText();
showSliders();
checkCache();
refresh();
