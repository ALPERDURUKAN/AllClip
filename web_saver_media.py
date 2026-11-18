#!/usr/bin/env python3
"""Local YouTube quality picker for AllClip. Python 3.10+."""
import argparse
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 47831
VIDEO = re.compile(r"[A-Za-z0-9_-]{11}\Z")
FORMAT = re.compile(r"[A-Za-z0-9_.-]{1,80}\Z")
MIB = 1024 * 1024
LOCK = threading.RLock()
SLOTS = threading.BoundedSemaphore(2)
JOBS, LISTS = {}, {}
FORMATS_TTL, JOB_TTL = 15 * 60, 60 * 60


def available_formats(info, can_merge):
    if info.get("live_status") in {"is_live", "is_upcoming"} or info.get("is_live"):
        raise ValueError("This media helper supports finished videos.")
    formats = [f for f in info.get("formats", []) if f.get("url") and not f.get("has_drm")
               and FORMAT.fullmatch(str(f.get("format_id", ""))) and f.get("ext") in {"mp4", "webm", "m4a", "ogg", "mp3", "opus"}]
    audio = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none")]
    def bitrate(f):
        return f.get("abr") or f.get("tbr") or 0
    choices = []
    for f in formats:
        fid, ext = f["format_id"], f["ext"]
        if f.get("vcodec") == "none" and f not in audio:
            continue
        is_audio = f in audio
        companion = None
        if not is_audio and f.get("acodec") in (None, "none") and can_merge:
            matching = [a for a in audio if (ext == "mp4" and a["ext"] == "m4a") or (ext == "webm" and a["ext"] == "webm")]
            companion = max(matching, key=bitrate, default=None)
        size = f.get("filesize") or f.get("filesize_approx")
        if companion:
            aid_size = companion.get("filesize") or companion.get("filesize_approx")
            size = size + aid_size if size and aid_size else None
        quality = (f'{round(bitrate(f))} kbps' if is_audio else f'{f.get("height") or "?"}p')
        if not is_audio and (f.get("fps") or 0) > 30:
            quality += f' {f["fps"]:g} fps'
        tracks = "audio only" if is_audio else "video + audio" if companion or f.get("acodec") not in (None, "none") else "video only"
        label = f'{quality} · {ext.upper()} · {tracks}'
        if f.get("language"):
            label += " · " + str(f["language"])
        if size:
            label += f' · ~{size / MIB:.1f} MiB'
        selector = fid + "+" + companion["format_id"] if companion else fid
        choices.append({"id": selector, "label": label, "ext": ext, "audio": is_audio,
                        "size": size, "height": f.get("height") or 0, "fps": f.get("fps") or 0,
                        "sound": bool(is_audio or companion or f.get("acodec") not in (None, "none"))})
    return sorted(choices, key=lambda x: (x["audio"], -x["height"], -x["fps"], not x["sound"], x["ext"] != "mp4", x["id"]))


def video_url(video_id):
    if not isinstance(video_id, str) or not VIDEO.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID.")
    return "https://www.youtube.com/watch?v=" + video_id


def options():
    return {"quiet": True, "no_warnings": True, "noplaylist": True, "socket_timeout": 25,
            "retries": 1, "fragment_retries": 1, "cachedir": False, "ignoreconfig": True}


def list_formats(video_id):
    url = video_url(video_id)
    with LOCK:
        cached = LISTS.get(video_id)
        if cached and time.time() - cached[0] < FORMATS_TTL:
            return cached[1]
    if not SLOTS.acquire(blocking=False):
        raise ValueError("The helper is busy. Try again when the current download finishes.")
    try:
        with YDL(options()) as ydl:
            info = ydl.extract_info(url, download=False)
        choices = available_formats(info, shutil.which("ffmpeg") is not None)
        if not choices:
            raise ValueError("No downloadable formats were returned for this video.")
        data = {"title": str(info.get("title") or video_id), "formats": choices}
        with LOCK:
            LISTS[video_id] = (time.time(), data)
        return data
    finally:
        SLOTS.release()


def phase(job, **fields):
    with LOCK:
        job.update(fields)


def download_job(job, choice):
    try:
        limit = job["limit"]
        def progress(event):
            if job["cancel"].is_set():
                raise ValueError("Canceled.")
            size = event.get("downloaded_bytes") or 0
            if limit and size > limit:
                raise ValueError("The selected file exceeds the archive limit.")
            phase(job, bytes=size)
        opts = {**options(), "format": choice["id"], "outtmpl": str(job["dir"] / "media.%(ext)s"),
                "progress_hooks": [progress], "overwrites": False}
        if limit:
            opts["max_filesize"] = limit
        with YDL(opts) as ydl:
            ydl.extract_info(video_url(job["video"]), download=True)
        if job["cancel"].is_set():
            raise ValueError("Canceled.")
        finished = [p for p in job["dir"].iterdir() if p.is_file() and p.stem == "media" and p.suffix in {".mp4", ".m4a", ".webm", ".mp3", ".opus", ".ogg", ".mkv"}]
        if len(finished) != 1:
            raise ValueError("The requested format was unavailable or exceeded its size limit.")
        file = finished[0]; size = file.stat().st_size
        if not size or (limit and size > limit):
            raise ValueError("The file is empty or exceeds the archive limit.")
        if job["keep"]:
            OUTPUT.mkdir(parents=True, exist_ok=True)
            basename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", job["title"]).strip(" .")[:75]
            # Exclusive creation also handles two jobs choosing the same name.
            destination = OUTPUT / f'Web clip - {basename} [{job["video"]}] {job["id"][:8]}{file.suffix}'
            try:
                with destination.open("xb") as dst, file.open("rb") as src:
                    shutil.copyfileobj(src, dst)
            except FileExistsError:
                raise ValueError("The output name already exists. Start a new download.") from None
            except Exception:
                destination.unlink(missing_ok=True)
                raise
            file = destination
        phase(job, state="done", bytes=size, file=file, updated=time.time())
    except Exception as exc:
        detail = str(exc) if type(exc) is ValueError else "The source or selected format is unavailable. Refresh qualities and try again."
        phase(job, state="failed", error=detail, updated=time.time())
    finally:
        if job["keep"] or job["state"] != "done":
            shutil.rmtree(job["dir"], ignore_errors=True)
        SLOTS.release()


def start_job(data):
    video = data.get("video"); video_url(video)
    keep = data.get("keep") is True
    limit = 0 if keep else data.get("limit")
    if not keep and (type(limit) is not int or not 1 <= limit <= 1024 * MIB):
        raise ValueError("Invalid archive byte limit.")
    with LOCK:
        cached = LISTS.get(video)
        if not cached or time.time() - cached[0] >= FORMATS_TTL:
            raise ValueError("Refresh the available qualities first.")
        choice = next((f for f in cached[1]["formats"] if f["id"] == data.get("format")), None)
        if not choice:
            raise ValueError("Select one of the listed qualities.")
        if limit and choice["size"] and choice["size"] > limit:
            raise ValueError("The selected quality exceeds the archive limit. Choose a smaller format or Download separately.")
        if not SLOTS.acquire(blocking=False):
            raise ValueError("The helper is busy.")
        try:
            job = {"id": secrets.token_hex(16), "dir": Path(tempfile.mkdtemp(dir=TEMP)), "keep": keep,
                   "state": "running", "updated": time.time(), "video": video, "title": cached[1]["title"],
                   "limit": limit, "cancel": threading.Event(), "bytes": 0}
            JOBS[job["id"]] = job
            threading.Thread(target=download_job, args=(job, choice), daemon=True).start()
            return {"job": job["id"]}
        except Exception:
            SLOTS.release()
            raise


def cleanup():
    with LOCK:
        now = time.time()
        for k, job in list(JOBS.items()):
            if job["state"] != "running" and now - job["updated"] > JOB_TTL:
                shutil.rmtree(job["dir"], ignore_errors=True)
                del JOBS[k]
        for k, value in list(LISTS.items()):
            if now - value[0] >= FORMATS_TTL:
                del LISTS[k]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, data, code=200):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.headers.get("Host") != f"{HOST}:{self.server.server_port}" or not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + TOKEN).encode()):
            return self.reply({"message": "Pair the helper in Media options."}, 403)
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if not 0 < n <= 4096:
                raise ValueError("Invalid request size.")
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict):
                raise ValueError("Invalid request.")
            cleanup()
            if self.path == "/formats":
                return self.reply(list_formats(data.get("video")))
            if self.path == "/download":
                return self.reply(start_job(data))
            if self.path == "/ping":
                return self.reply({"ready": True})
            with LOCK:
                job = JOBS.get(data.get("job")) if isinstance(data.get("job"), str) else None
                if not job:
                    return self.reply({"message": "Download job expired."}, 404)
                if self.path == "/cancel":
                    job["cancel"].set()
                    return self.reply({"canceled": True})
                if self.path == "/status":
                    out = {k:job[k] for k in ("state", "bytes", "error") if k in job}
                    if job.get("file"):
                        out["filename"] = job["file"].name
                        out["ext"] = job["file"].suffix[1:]
                    return self.reply(out)
                if self.path != "/file" or job["state"] != "done" or job["keep"]:
                    return self.reply({"message": "No archive file for this job."}, 404)
                src = job["file"].open("rb")
            with src:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(os.fstat(src.fileno()).st_size))
                self.send_header("Cache-Control", "no-store"); self.end_headers()
                shutil.copyfileobj(src, self.wfile)
        except (ValueError, TypeError) as exc:
            self.reply({"message": str(exc)[:240]}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.reply({"message": "The helper could not retrieve that video. Check availability and update yt-dlp."}, 502)


def main():
    global TOKEN, OUTPUT, TEMP, YDL
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path.home() / "Downloads" / "AllClip")
    args = parser.parse_args()
    try:
        from yt_dlp import YoutubeDL
    except ImportError:
        sys.exit('Install yt-dlp first: python -m pip install -U "yt-dlp[default]"')
    YDL = YoutubeDL
    OUTPUT = args.output.expanduser().resolve()
    TOKEN = secrets.token_urlsafe(24)
    with tempfile.TemporaryDirectory(prefix="web-content-saver-") as temp:
        TEMP = temp
        with ThreadingHTTPServer((HOST, PORT), Handler) as http:
            print(f"Pairing code: {TOKEN}\nDownloads: {OUTPUT}\nKeep this window open. Press Ctrl+C to stop.", flush=True)
            try:
                http.serve_forever()
            except KeyboardInterrupt:
                pass

if __name__ == "__main__":
    main()

