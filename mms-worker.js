// Filipino-language speech with Meta MMS-TTS (VITS), run with ONNX Runtime Web.
// Models: facebook/mms-tts-* (CC BY-NC 4.0), ONNX export by willwade. See NOTICE.txt.
"use strict";

const ORT_CDN_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
const MODEL_BASE = "https://huggingface.co/willwade/mms-tts-multilingual-models-onnx/resolve/main";
const CACHE_NAME = "ovtts-mms-v1";
const LANGUAGES = ["tgl", "ceb", "war", "hil"];
const SAMPLE_RATE = 16000;
const SENTENCE_GAP = 0.35;
const CLAUSE_GAP = 0.15;
const MAX_PIECE_CHARS = 220;

let session = null;
let vocab = null;
let currentLang = null;
let generating = false;
let stopRequested = false;
const downloads = new Map();
let lastReport = 0;

function isIOSOrSafari() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ||
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

function loadOrt() {
  if (typeof ort !== "undefined") return;
  postMessage({ type: "status", status: "Loading ONNX Runtime…" });
  importScripts(`${ORT_CDN_BASE}ort.min.js`);
  ort.env.wasm.wasmPaths = ORT_CDN_BASE;
  ort.env.logLevel = "error";
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = self.crossOriginIsolated && !isIOSOrSafari()
    ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;
}

function report(force = false) {
  const now = performance.now();
  if (!force && now - lastReport < 150) return;
  lastReport = now;
  let loaded = 0, total = 0, known = true;
  for (const d of downloads.values()) {
    loaded += d.loaded;
    if (d.total) total += Math.max(d.total, d.loaded); else known = false;
  }
  postMessage({ type: "download", loaded, total: known ? total : 0 });
}

// Downloads with progress and keeps a copy in Cache Storage for the next visit.
async function fetchFile(url) {
  let cache = null;
  if (typeof caches !== "undefined" && !isIOSOrSafari()) {
    try {
      cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        downloads.set(url, { loaded: bytes.byteLength, total: bytes.byteLength });
        report(true);
        return bytes;
      }
    } catch { cache = null; }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url.split("/").slice(-2).join("/")}`);
  const entry = { loaded: 0, total: Number(response.headers.get("content-length")) || 0 };
  downloads.set(url, entry);
  report(true);
  let bytes;
  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      entry.loaded += value.byteLength;
      report();
    }
    bytes = new Uint8Array(entry.loaded);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
    entry.loaded = bytes.byteLength;
  }
  entry.total = entry.loaded;
  report(true);
  if (cache) {
    try { await cache.put(url, new Response(bytes)); } catch (e) { console.warn("Could not cache:", e); }
  }
  return bytes;
}

// tokens.txt: one "<symbol> <id>" per line; the space symbol's line starts with a space.
function parseTokens(text) {
  const map = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const cut = line.lastIndexOf(" ");
    if (cut < 0) continue;
    const id = Number(line.slice(cut + 1));
    let symbol = line.slice(0, cut);
    if (symbol === "") symbol = " ";
    if (Number.isInteger(id)) map.set(symbol, id);
  }
  return map;
}

// MMS models read lowercase characters, with a blank (id 0) between symbols.
function encode(text) {
  const clean = text.normalize("NFC").toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();
  const ids = [];
  for (const ch of clean) {
    let id = vocab.get(ch);
    if (id === undefined) id = vocab.get(ch.normalize("NFD")[0]); // é -> e, ñ -> n where missing
    if (id !== undefined) ids.push(id);
  }
  const out = new Array(ids.length * 2 + 1).fill(0);
  ids.forEach((id, k) => { out[2 * k + 1] = id; });
  return { ids: out, symbols: ids.length };
}

// Splits text into pieces, each with the pause that follows it.
function splitText(text) {
  const pieces = [];
  const sentences = text.replace(/\r/g, "").split(/(?<=[.!?…])\s+|\n+/);
  for (const sentence of sentences) {
    const clauses = sentence.split(/(?<=[,;:])\s+/);
    clauses.forEach((clause, i) => {
      let rest = clause.trim();
      while (rest.length > MAX_PIECE_CHARS) {
        let cut = rest.lastIndexOf(" ", MAX_PIECE_CHARS);
        if (cut < 40) cut = MAX_PIECE_CHARS;
        pieces.push({ text: rest.slice(0, cut), gap: CLAUSE_GAP });
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push({ text: rest, gap: i === clauses.length - 1 ? SENTENCE_GAP : CLAUSE_GAP });
    });
  }
  return pieces;
}

async function loadLanguage(lang) {
  if (!LANGUAGES.includes(lang)) throw new Error(`Unknown language: ${lang}`);
  loadOrt();
  downloads.clear();
  if (session) { try { await session.release(); } catch { /* ignore */ } }
  session = null; vocab = null; currentLang = null;

  postMessage({ type: "status", status: "Downloading the voice model…" });
  const tokenBytes = await fetchFile(`${MODEL_BASE}/${lang}/tokens.txt`);
  const modelBytes = await fetchFile(`${MODEL_BASE}/${lang}/model.onnx`);
  vocab = parseTokens(new TextDecoder().decode(tokenBytes));

  postMessage({ type: "status", status: "Starting the voice model…" });
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  if (isIOSOrSafari()) {
    options.enableCpuMemArena = false;
    options.enableMemPattern = false;
  }
  session = await ort.InferenceSession.create(modelBytes, options);
  currentLang = lang;
  postMessage({ type: "loaded", lang });
}

const f32 = (v) => new ort.Tensor("float32", Float32Array.from([v]), [1]);

async function synthesize(text, speed, variation) {
  const { ids, symbols } = encode(text);
  if (!symbols) return new Float32Array(0);
  const all = {
    x: new ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
    x_length: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    noise_scale: f32(0.667 * variation),
    length_scale: f32(1 / speed),
    noise_scale_w: f32(0.8 * variation),
  };
  const feeds = {};
  for (const name of session.inputNames) if (all[name]) feeds[name] = all[name];
  const out = await session.run(feeds);
  return new Float32Array(out[session.outputNames[0]].data);
}

async function generate({ text, speed = 1, variation = 1 }) {
  generating = true;
  stopRequested = false;
  let failed = false;
  try {
    const pieces = splitText(text);
    if (!pieces.length) throw new Error("No text to read.");
    for (let i = 0; i < pieces.length && !stopRequested; i++) {
      postMessage({ type: "progress", part: i + 1, parts: pieces.length });
      const audio = await synthesize(pieces[i].text, speed, variation);
      if (stopRequested) break;
      if (audio.length) postMessage({ type: "audio_chunk", data: audio }, [audio.buffer]);
      if (i < pieces.length - 1) {
        const gap = new Float32Array(Math.round(pieces[i].gap * SAMPLE_RATE));
        postMessage({ type: "audio_chunk", data: gap }, [gap.buffer]);
      }
      await new Promise((r) => setTimeout(r, 0)); // lets a Stop message in
    }
  } catch (e) {
    failed = true;
    postMessage({ type: "error", error: e.message || String(e) });
  } finally {
    generating = false;
    postMessage({ type: "generation_done", stopped: stopRequested, failed });
  }
}

self.onmessage = async (event) => {
  const { type, data } = event.data;
  try {
    if (type === "load") {
      if (generating) throw new Error("Wait for the current run to finish.");
      await loadLanguage(data.lang);
    } else if (type === "stop") {
      if (generating) stopRequested = true;
    } else if (type === "generate") {
      if (!session) throw new Error("Load a language first.");
      if (!generating) await generate(data);
    }
  } catch (e) {
    console.error(e);
    postMessage({ type: "error", error: e.message || String(e) });
  }
};
