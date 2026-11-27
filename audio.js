// Audio helpers: join generated chunks, clean up voice samples, and encode WAV and MP3.
(function (root) {
  function joinChunks(chunks) {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  function toInt16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i] || 0));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return pcm;
  }

  // 16-bit mono WAV. Fast, so the player can use it right away.
  function encodeWav(samples, sampleRate) {
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, n * 2, true);
    const pcm = toInt16(samples);
    for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, pcm[i], true);
    return buffer;
  }

  // MP3 encoding is slow for long audio, so it pauses between slices to keep the page responsive.
  async function encodeMp3(samples, sampleRate, { lame = root.lamejs, kbps = 96, onProgress } = {}) {
    const pcm = toInt16(samples);
    const encoder = new lame.Mp3Encoder(1, sampleRate, kbps);
    const parts = [];
    const FRAME = 1152, FRAMES_PER_SLICE = 200;
    for (let i = 0; i < pcm.length; i += FRAME) {
      const frame = encoder.encodeBuffer(pcm.subarray(i, i + FRAME));
      if (frame.length) parts.push(new Uint8Array(frame));
      if ((i / FRAME) % FRAMES_PER_SLICE === FRAMES_PER_SLICE - 1) {
        if (onProgress) onProgress(i / pcm.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    if (onProgress) onProgress(1);
    return parts;
  }

  // Trims quiet edges from a voice sample and raises its level, so cloning gets clean speech.
  function prepareVoiceSample(samples, sampleRate, maxSeconds) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak < 1e-4) return samples.subarray(0, 0);

    const win = Math.round(sampleRate * 0.02);
    const threshold = peak * 0.05;
    const loud = (start) => {
      let sum = 0;
      const end = Math.min(samples.length, start + win);
      for (let i = start; i < end; i++) sum += samples[i] * samples[i];
      return Math.sqrt(sum / Math.max(1, end - start)) > threshold;
    };
    let start = 0;
    while (start < samples.length && !loud(start)) start += win;
    let end = samples.length;
    while (end > start && !loud(Math.max(start, end - win))) end -= win;

    // Keep a little room around the speech.
    const pad = Math.round(sampleRate * 0.1);
    start = Math.max(0, start - pad);
    end = Math.min(samples.length, end + pad, start + sampleRate * maxSeconds);

    const out = samples.slice(start, end);
    const gain = Math.min(0.95 / peak, 10);
    for (let i = 0; i < out.length; i++) out[i] *= gain;
    return out;
  }

  root.AudioTools = { joinChunks, toInt16, encodeWav, encodeMp3, prepareVoiceSample };
})(typeof window !== "undefined" ? window : globalThis);
