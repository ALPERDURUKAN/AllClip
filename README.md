# AllClip

<img src="assets/allclip-logo.webp" alt="AllClip logo: a paperclip over stacked pages" width="104">

Save a reference, collect sources for a project, or build a reading list. Capture a whole page, the main article, a text selection, or a single element. Each export includes the source URL and capture date.

**[Install AllClip](https://raw.githubusercontent.com/ALPERDURUKAN/AllClip/main/AllClip.user.js)**

## Quick start

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the install link and confirm the installation in your userscript manager.
3. Reload the page you want to capture. Select text and press **Ctrl+Shift+S**, or open the script menu to choose a capture mode. **Ctrl+Shift+A** lets you pick an element.

If the install link shows code, copy it into a new script in your manager and save. If you use the earlier Universal Web Content Saver, disable it before using AllClip so both scripts do not handle the same shortcut. A new installation may require you to enter your AI settings again.

| For this task | Use this option |
| --- | --- |
| Save a passage for your notes | Select text and press **Ctrl+Shift+S**. |
| Save the whole page or just its main article | Use **Save full page** or **Save main article** in the script menu. |
| Keep text and available media together | Select **ZIP** in **Settings → Capture**. Extract the archive before opening `capture.html`. |
| Keep a PDF or video with the source | Open **Save with media options** and choose which files to embed or download. |

## Exports and media

Choose Markdown for notes, HTML for reading, JSON for structured data, or ZIP for local media files and a manifest. A selection saved as ZIP also includes the original selected text in `selection.txt`.

**Save with media options** can embed PDF bytes in a single HTML file, include a PDF as a local file in a ZIP, or insert a YouTube player in the HTML. Direct audio and video use the sources made available by the page. When the browser cannot retrieve a file, a ZIP records the reason and keeps the link. Streaming playlists are saved separately from their media segments.

### Optional YouTube downloads

The local helper lists the qualities that yt-dlp can retrieve. Use it for videos you have permission to download. Install Python 3.10 or later, then run these commands in a folder containing [web_saver_media.py](web_saver_media.py).

```powershell
py -m pip install -U "yt-dlp[default]"
py web_saver_media.py
```

On macOS or Linux, use `python3` in place of `py`. In **Save with media options → Connect the optional download helper**, enter the code printed by the helper. Choose **List qualities**, then **Download separately** or **Include selected quality in ZIP**. Separate downloads go to `Downloads/AllClip`. FFmpeg on PATH enables formats that need separate video and audio tracks combined.

If a YouTube player gives error 153 when you open the local HTML directly, run `py -m http.server 8000 --bind 127.0.0.1` from the capture folder and open [http://127.0.0.1:8000](http://127.0.0.1:8000). The original video link is also in the export.

## Optional AI titles and summaries

Open **Providers and models**, enter the provider API key if needed, and select a model. Add and reorder backup models under **Fallback order**. The catalog refreshes from each provider and supports filters for the fields that provider returns.

Options include OpenRouter, NVIDIA NIM, Kilo Gateway, OpenAI, Anthropic, Google Gemini, Groq, local Ollama, and custom OpenAI-compatible endpoints. A fresh installation saves captures locally. When you enable AI, the script sends a sample of the captured text and media labels to the configured provider. If the configured models fail, capture still saves without an AI summary.

## License

The [AllClip Use-Only License](LICENSE) allows free use of the official, unmodified software, including at school and at work. Modification, redistribution, repackaging, and sale require prior written permission, subject to applicable law and the hosting platform's terms. You can share the link to this repository or the official installer.
