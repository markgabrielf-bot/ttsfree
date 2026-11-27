// Page logic. The model runs in inference-worker.js.
"use strict";
const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 24000;
const MAX_CLONE_SECONDS = 10;
const MIN_CLONE_SECONDS = 3;

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
let mp3Url = null;

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}

function refresh() {
  const recording = recorder !== null;
  const idle = ready && !busy && !recording;
  $("load").disabled = worker !== null;
  $("voice").disabled = !idle;
  $("generate").disabled = !idle;
  $("stop").disabled = !generating;
  $("upload").disabled = !(idle && $("consent").checked);
  $("record").disabled = !(recording || (idle && $("consent").checked));
  $("record").textContent = recording ? "Stop recording" : "Record";
  $("record").classList.toggle("recording", recording);
  document.body.classList.toggle("busy", busy);
  $("load").hidden = ready;
}

function loadModel() {
  setStatus("Loading model. This can take a few minutes the first time…");
  busy = true;
  worker = new Worker("inference-worker.js");
  worker.onmessage = (event) => handle(event.data);
  worker.onerror = (event) => fail(event.message || "The model worker could not start.");
  worker.postMessage({ type: "load" });
  refresh();
}

function fail(message) {
  busy = false;
  const loading = !ready && worker !== null;
  if (loading) { worker.terminate(); worker = null; }
  setStatus(loading
    ? `The model did not load. Check that you can reach huggingface.co and cdn.jsdelivr.net, then try again. (${message})`
    : `Something went wrong: ${message}`, true);
  refresh();
}

function showVoices(names) {
  const options = names.filter((n) => ALLOWED_VOICES.includes(n)).map((n) =>
    new Option(n.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), n));
  $("voice").replaceChildren(...options);
  if (names.includes("alba")) $("voice").value = "alba";
}

function handle(message) {
  switch (message.type) {
    case "voices_loaded":
      showVoices(message.voices);
      break;
    case "loaded":
      ready = true; busy = false;
      setStatus("Ready.");
      break;
    case "status":
      if (busy && !generating && message.state === "loading") setStatus(message.status);
      return;
    case "voice_encoded":
      hasClone = true; busy = false;
      if (![...$("voice").options].some((o) => o.value === "custom")) {
        $("voice").prepend(new Option("My cloned voice", "custom"));
      }
      $("voice").value = "custom";
      setStatus("Cloned voice is ready.");
      break;
    case "audio_chunk":
      chunks.push(message.data);
      setStatus(`Generating… ${(chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE).toFixed(1)} s of audio so far.`);
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

function generate() {
  const text = $("text").value.trim();
  if (!text) { setStatus("Type some text first.", true); return; }
  chunks = [];
  busy = generating = true;
  $("result").hidden = true;
  $("player").pause();
  setStatus("Generating…");
  worker.postMessage({ type: "generate", data: { text, voice: $("voice").value } });
  refresh();
}

function finishGeneration({ stopped, failed }) {
  busy = generating = false;
  if (failed) return;
  if (stopped || !chunks.length) { setStatus("Stopped."); chunks = []; return; }
  try {
    const samples = AudioTools.joinChunks(chunks);
    const blob = new Blob(AudioTools.encodeMp3(samples, SAMPLE_RATE), { type: "audio/mpeg" });
    if (mp3Url) URL.revokeObjectURL(mp3Url);
    mp3Url = URL.createObjectURL(blob);
    drawWave(samples);
    $("player").src = mp3Url;
    $("download").href = mp3Url;
    $("result").hidden = false;
    setStatus("Done. Press play or download the MP3.");
  } catch (error) {
    setStatus(`Could not create the MP3: ${error.message}`, true);
  }
  chunks = [];
}

// Draws the loudness of the generated audio as bars.
function drawWave(samples, bars = 64) {
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

function countText() {
  const field = $("text");
  $("count").textContent = `${field.value.length} / ${field.maxLength} characters`;
}

async function cloneFrom(blob) {
  busy = true;
  setStatus("Reading the recording…");
  refresh();
  let context;
  try {
    // Decoding in a 24 kHz context resamples the audio to the model's rate.
    context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration < MIN_CLONE_SECONDS) {
      throw new Error(`the recording is too short. Use at least ${MIN_CLONE_SECONDS} seconds.`);
    }
    const length = Math.min(decoded.length, SAMPLE_RATE * MAX_CLONE_SECONDS);
    const audio = new Float32Array(length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < length; i++) audio[i] += data[i] / decoded.numberOfChannels;
    }
    setStatus("Cloning the voice…");
    worker.postMessage({ type: "encode_voice", data: { audio } }, [audio.buffer]);
  } catch (error) {
    fail(error.message || "this audio file could not be read.");
  }
}

async function toggleRecording() {
  if (recorder) { if (recorder.state === "recording") recorder.stop(); return; }
  busy = true;
  refresh();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const active = new MediaRecorder(stream);
    const parts = [];
    let timer;
    active.ondataavailable = (e) => parts.push(e.data);
    active.onstop = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      cloneFrom(new Blob(parts, { type: active.mimeType }));
    };
    active.start();
    recorder = active;
    busy = false;
    timer = setTimeout(() => { if (active.state === "recording") active.stop(); }, MAX_CLONE_SECONDS * 1000);
    setStatus(`Recording… speak now. Stops after ${MAX_CLONE_SECONDS} seconds.`);
    refresh();
  } catch (error) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    fail(`microphone unavailable (${error.message}).`);
  }
}

$("player").ontimeupdate = showProgress;
$("text").oninput = countText;
$("load").onclick = loadModel;
$("generate").onclick = generate;
$("stop").onclick = () => { worker.postMessage({ type: "stop" }); setStatus("Stopping…"); };
$("consent").onchange = refresh;
$("record").onclick = toggleRecording;
$("upload").onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) cloneFrom(file);
};
countText();
refresh();
