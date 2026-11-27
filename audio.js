// Audio helpers: join generated chunks and encode them as MP3.
(function (root) {
  function joinChunks(chunks) {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  function encodeMp3(samples, sampleRate, lame = root.lamejs, kbps = 96) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i] || 0));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    const encoder = new lame.Mp3Encoder(1, sampleRate, kbps);
    const parts = [];
    for (let i = 0; i < pcm.length; i += 1152) {
      const frame = encoder.encodeBuffer(pcm.subarray(i, i + 1152));
      if (frame.length) parts.push(new Uint8Array(frame));
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    return parts;
  }

  root.AudioTools = { joinChunks, encodeMp3 };
})(typeof window !== "undefined" ? window : globalThis);
