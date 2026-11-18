<p align="center">
  <img src="assets/allclip-logo.webp" alt="AllClip logo" width="112">
</p>

<h1 align="center">AllClip</h1>

<p align="center"><strong>Save web pages, excerpts, and media in the format you need.</strong></p>

<p align="center">
  <a href="https://raw.githubusercontent.com/ALPERDURUKAN/AllClip/main/AllClip.user.js"><img alt="Install AllClip" src="https://img.shields.io/badge/Install-AllClip-24C98A?style=for-the-badge"></a>
  <a href="#-quick-start"><img alt="Quick start" src="https://img.shields.io/badge/Quick-start-324368?style=for-the-badge"></a>
  <a href="https://github.com/ALPERDURUKAN/AllClip/issues"><img alt="Report an issue" src="https://img.shields.io/badge/Report-an%20issue-324368?style=for-the-badge"></a>
</p>

<p align="center">For reading lists, research notes, course materials, and everyday references.</p>

## ⚡ Quick start

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Click [**Install AllClip**](https://raw.githubusercontent.com/ALPERDURUKAN/AllClip/main/AllClip.user.js) and confirm in your userscript manager.
3. Reload the page. Highlight text and press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>, or open the script menu for more capture options.

> [!TIP]
> If the install link opens as plain code, paste it into a new script in your userscript manager and save it. Disable the earlier Universal Web Content Saver if it still uses the same shortcuts.

## ✂️ What you can capture

| I want to save… | Use this |
| --- | --- |
| A quote with its source | Highlight the passage and press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>. |
| A page or its main article | Choose **Save full page** or **Save main article** from the script menu. |
| One figure, table, or page section | Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd> and pick the element. |
| A PDF or a video alongside the page | Choose **Save with media options**. |

Every export includes the source URL and capture date.

## 📦 Choose an export format

| Format | Use it for |
| --- | --- |
| **Markdown** | Notes, reading lists, and text editors |
| **HTML** | Reading in a browser, with PDF or video embeds where available |
| **JSON** | Structured data and a media inventory |
| **ZIP** | HTML, Markdown, a manifest, and available local media files |

Extract a ZIP before opening `capture.html`. Selection ZIPs also include the original text in `selection.txt`. The manifest explains why a media file remains a link if the browser cannot retrieve it.

## 📄 PDFs and video

In **Save with media options**, you can embed a PDF in one HTML file, store the PDF as a local file in a ZIP, or add an online YouTube player. For direct audio or video, choose among the sources published by the page. Streaming playlists can be saved as source files. The media segments stay outside the ZIP.

<details>
<summary><strong>Set up optional YouTube quality downloads</strong></summary>

### Optional YouTube downloads

The local helper lists the qualities that yt-dlp can retrieve. Use it for videos you have permission to download. Install Python 3.10 or later, then run these commands in a folder containing [web_saver_media.py](web_saver_media.py).

```powershell
py -m pip install -U "yt-dlp[default]"
py web_saver_media.py
```

On macOS or Linux, use `python3` in place of `py`. In **Save with media options → Connect the optional download helper**, enter the code printed by the helper. Choose **List qualities**, then **Download separately** or **Include selected quality in ZIP**. Separate downloads go to `Downloads/AllClip`. FFmpeg on PATH enables formats that need separate video and audio tracks combined.

If a YouTube player gives error 153 when you open the local HTML directly, run `py -m http.server 8000 --bind 127.0.0.1` from the capture folder and open [http://127.0.0.1:8000](http://127.0.0.1:8000). The original video link is also in the export.

</details>

## ✨ Optional AI titles and summaries

Open **Providers and models**, add an API key if required, and choose a model. Use **Fallback order** to set which model runs next if a request fails. Search and filter the catalog using the fields each provider returns.

**Providers.** OpenRouter, NVIDIA NIM, Kilo Gateway, OpenAI, Anthropic, Google Gemini, Groq, local Ollama, and custom OpenAI-compatible endpoints.

> [!NOTE]
> A fresh installation saves captures locally. When you enable AI, AllClip sends a sample of your captured text and media labels to the provider you configure. If all configured models fail, AllClip still saves the capture.

## 💬 Feedback

[Report a problem or request a feature](https://github.com/ALPERDURUKAN/AllClip/issues). Include your browser, userscript manager, and the steps to reproduce the issue. Use a public example page when possible.

## License

The [AllClip Use-Only License](LICENSE) allows free use of the official, unmodified software, including at school and at work. Modification, redistribution, repackaging, and sale require prior written permission, subject to applicable law and the hosting platform's terms. You can share the link to this repository or the official installer.
