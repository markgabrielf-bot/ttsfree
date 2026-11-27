# Open Voice TTS

English text to speech with voice cloning and MP3 download. Static files only; the
model runs in the visitor's browser (Pocket TTS, ONNX Runtime Web).

## Publish
Upload every file in this folder to weejur (or GitHub Pages), keeping index.html at the top level.
Before publishing, put your name in LICENSE.

## Run locally
    python3 -m http.server 8080
Then open http://localhost:8080. Opening index.html directly as a file will not work.

## Requirements
Visitors need access to huggingface.co and cdn.jsdelivr.net.

See NOTICE.txt for credits and licenses.
