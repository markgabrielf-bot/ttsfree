# Open Voice TTS

English text to speech with voice cloning, MP3 and WAV download. Static files only; the
model runs in the visitor's browser (Pocket TTS, ONNX Runtime Web).

## Features
- 19 preset voices cleared for commercial use, plus voice cloning (with a consent check)
- Plays the speech while it is still being generated; Stop keeps what was made so far
- Download progress on first load; model files are kept in the browser's storage so
  later visits skip the download (iOS/Safari use the normal browser cache instead)
- Voice samples are trimmed of silence and raised to a good level before cloning
- MP3 is encoded in the background so long audio does not freeze the page
- Remembers your text, voice and settings; Ctrl + Enter (Cmd + Enter on Mac) generates

## Philippine languages (filipino.html)
Tagalog, Bisaya (Cebuano), Waray and Hiligaynon with Meta MMS-TTS, one standard voice per
language and no voice cloning. These models are CC BY-NC 4.0: non-commercial use only.
Each language downloads about 115 MB the first time.

## Publish
Upload every file in this folder to weejur (or GitHub Pages), keeping index.html at the top level.
Before publishing, put your name in LICENSE. The site must be served over HTTPS for
model caching and the microphone to work.

## Run locally
    python3 -m http.server 8080
Then open http://localhost:8080. Opening index.html directly as a file will not work.

## Requirements
Visitors need access to huggingface.co and cdn.jsdelivr.net.

See NOTICE.txt for credits and licenses.
