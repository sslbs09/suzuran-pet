# -*- coding: utf-8 -*-
"""Genie (GPT-SoVITS) 本地推理服务器 —— 苏苏洛桌宠配音用。

替代原 Qwen3-TTS 服务器，接口保持一致：
- GET  /health  -> "ok"（模型就绪）/ "loading"（加载中）
- GET  /status  -> JSON（角色 / 参考音频 / 语言 / 引擎版本）
- POST /tts     -> {"text": "...", "ref_audio": "xxx.wav", "ref_text": "参考文本"} => 返回 wav 字节

首次启动会自动从 HuggingFace 下载 GenieData（~391MB）与角色模型（v2ProPlus/feibi），
默认走 hf-mirror.com 镜像（可在 config.json 里改 hfEndpoint 或 --hf-endpoint 覆盖）。
"""
import argparse
import io
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# pythonw.exe 运行：无控制台时 stdout/stderr 为 None，fd 级重定向到空设备避免 print 崩溃
def _ensure_stdio():
    for _name, _fd in (("stdout", 1), ("stderr", 2)):
        if getattr(sys, _name) is None:
            _null = os.open(os.devnull, os.O_WRONLY)
            os.dup2(_null, _fd)
            setattr(sys, _name, os.fdopen(_fd, "w", encoding="utf-8", closefd=False))


_ensure_stdio()

DATA_DIR = Path(__file__).resolve().parent
CONFIG_FILE = DATA_DIR / "config.json"
LOG_FILE = DATA_DIR / "server.log"
DL_PART = DATA_DIR / "_download.part"  # 下载临时文件固定名（常量，与请求参数无关；串行下载共用）


def _download_to_part(url):
    """把 url 内容下载到固定临时文件 DL_PART（常量路径，与任何请求参数无关）。"""
    import socket
    import urllib.request
    socket.setdefaulttimeout(120)
    urllib.request.urlretrieve(url, DL_PART)

DEFAULT_CONFIG = {
    "character": "sussurro",                       # 自定义角色名（加载后引用）
    "modelDir": "",                                # 空 = 使用内置预置角色模型（v2ProPlus/feibi）
    "language": "Chinese",                         # Chinese | English | Japanese | Korean
    "refAudio": str(DATA_DIR / "ref" / "ref_sussurro.wav"),
    "refText": "你好呀，新手星，我是苏苏洛，罗德岛的医疗干员。今天也要好好休息哦。",
    "hfEndpoint": "https://hf-mirror.com",          # 空 = huggingface.co
}

engine = None
engine_ready = False
lock = threading.Lock()
FAIL_MSG = ""
CHARACTER = "sussurro"   # 当前加载的角色名（服务器自己记录，genie_tts 未导出 context）
LANGUAGE = "Chinese"
LAST_REF_AUDIO = ""      # 当前已应用的参考音频路径（避免每次 /tts 重复 set_reference_audio 导致合成劣化）


def log(msg):
    try:
        line = time.strftime("[%H:%M:%S] ") + str(msg)
        print(line, flush=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------- 资源准备
def load_config(args):
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_FILE.exists():
        try:
            user = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            cfg.update({k: v for k, v in user.items() if v is not None and v != ""})
        except Exception as e:
            log("config.json 解析失败: " + str(e))
    # CLI 参数优先
    if args.character:
        cfg["character"] = args.character
    if args.language:
        cfg["language"] = args.language
    if args.ref_audio:
        cfg["refAudio"] = args.ref_audio
    if args.ref_text:
        cfg["refText"] = args.ref_text
    if args.model_dir:
        cfg["modelDir"] = args.model_dir
    if args.hf_endpoint is not None:
        cfg["hfEndpoint"] = args.hf_endpoint
    return cfg


def _dl_file(endpoint, path, dest):
    """直接从镜像 resolve 地址下载单文件（跟随 307 → resolve-cache 重定向）。
    不用 huggingface_hub：其 1.28 版本跟随重定向后拿不到 X-Repo-Commit 头，镜像站会报错。"""
    # 路径守卫（防路径穿越）：远端相对路径不得含上跳段，落盘目标必须在本指南目录内
    if any(part == os.pardir for part in Path(path).parts):
        raise RuntimeError("非法下载路径: " + path)
    try:
        dest.resolve().relative_to(DATA_DIR.resolve())
    except ValueError:
        raise RuntimeError("下载目标越界: " + str(dest))
    url = f"{endpoint}/High-Logic/Genie/resolve/main/{path}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    _download_to_part(url)
    os.replace(DL_PART, dest)
    return dest.stat().st_size


# 仓库 High-Logic/Genie 需要的文件清单（GenieData 共享资源 + feibi 预置角色 v2ProPlus）
REPO_FILES = [
    "GenieData/G2P/ChineseG2P/opencpop-strict.txt",
    "GenieData/G2P/ChineseG2P/polyphonic.pickle",
    "GenieData/G2P/EnglishG2P/checkpoint20.npz",
    "GenieData/G2P/EnglishG2P/cmudict-fast.rep",
    "GenieData/G2P/EnglishG2P/cmudict.rep",
    "GenieData/G2P/EnglishG2P/engdict-hot.rep",
    "GenieData/G2P/EnglishG2P/engdict_cache.pickle",
    "GenieData/G2P/EnglishG2P/namedict_cache.pickle",
    "GenieData/G2P/EnglishG2P/taggers/averaged_perceptron_tagger_eng/averaged_perceptron_tagger_eng.classes.json",
    "GenieData/G2P/EnglishG2P/taggers/averaged_perceptron_tagger_eng/averaged_perceptron_tagger_eng.tagdict.json",
    "GenieData/G2P/EnglishG2P/taggers/averaged_perceptron_tagger_eng/averaged_perceptron_tagger_eng.weights.json",
    "GenieData/G2P/EnglishG2P/wordsegment/bigrams.txt",
    "GenieData/G2P/EnglishG2P/wordsegment/unigrams.txt",
    "GenieData/G2P/EnglishG2P/wordsegment/words.txt",
    "GenieData/chinese-hubert-base/chinese-hubert-base.onnx",
    "GenieData/chinese-hubert-base/chinese-hubert-base_weights_fp16.bin",
    "GenieData/speaker_encoder.onnx",
    "CharacterModels/v2ProPlus/feibi/prompt_wav.json",
    "CharacterModels/v2ProPlus/feibi/prompt_wav/zh_vo_Main_Linaxita_2_1_10_26.wav",
    "CharacterModels/v2ProPlus/feibi/tts_models/prompt_encoder_fp16.bin",
    "CharacterModels/v2ProPlus/feibi/tts_models/prompt_encoder_fp32.onnx",
    "CharacterModels/v2ProPlus/feibi/tts_models/t2s_encoder_fp32.bin",
    "CharacterModels/v2ProPlus/feibi/tts_models/t2s_encoder_fp32.onnx",
    "CharacterModels/v2ProPlus/feibi/tts_models/t2s_first_stage_decoder_fp32.onnx",
    "CharacterModels/v2ProPlus/feibi/tts_models/t2s_shared_fp16.bin",
    "CharacterModels/v2ProPlus/feibi/tts_models/t2s_stage_decoder_fp32.onnx",
    "CharacterModels/v2ProPlus/feibi/tts_models/vits_fp16.bin",
    "CharacterModels/v2ProPlus/feibi/tts_models/vits_fp32.onnx",
]


def provision(cfg):
    """下载 GenieData 与预置角色模型（缺啥补啥），返回角色 ONNX 模型目录"""
    endpoint = (cfg.get("hfEndpoint") or "https://huggingface.co").rstrip("/")
    total_mb = 0.0
    for f in REPO_FILES:
        dest = DATA_DIR / f
        if dest.exists() and dest.stat().st_size > 0:
            continue
        mb = _dl_file(endpoint, f, dest) / 1024 / 1024
        total_mb += mb
        log(f"下载 {f} ({mb:.1f} MB)")
    if total_mb > 0:
        log(f"资源下载完成，共 {total_mb:.1f} MB")

    model_dir = cfg.get("modelDir") or ""
    if not model_dir:
        tts_models = DATA_DIR / "CharacterModels" / "v2ProPlus" / "feibi" / "tts_models"
        if not (tts_models / "t2s_encoder_fp32.onnx").exists():
            raise RuntimeError("角色模型缺失: " + str(tts_models))
        model_dir = str(tts_models)
    return model_dir


# ---------------------------------------------------------------- 引擎
def init_engine(cfg, model_dir):
    global engine, engine_ready, FAIL_MSG, CHARACTER, LANGUAGE, LAST_REF_AUDIO
    # 必须在 import genie_tts 之前设好 GENIE_DATA_DIR，且目录已存在（跳过交互式询问）
    os.environ["GENIE_DATA_DIR"] = str(DATA_DIR / "GenieData")
    os.chdir(DATA_DIR)  # 兼容库内 CWD 相对路径

    import genie_tts as genie

    CHARACTER = cfg["character"]
    LANGUAGE = cfg["language"]
    log("加载引擎中...")
    genie.load_character(
        character_name=CHARACTER,
        onnx_model_dir=model_dir,
        language=LANGUAGE,
    )
    ref_audio = cfg.get("refAudio") or ""
    ref_text = cfg.get("refText") or ""
    if ref_audio and os.path.exists(ref_audio):
        genie.set_reference_audio(
            character_name=CHARACTER,
            audio_path=ref_audio,
            audio_text=ref_text,
            language=LANGUAGE,
        )
        LAST_REF_AUDIO = ref_audio
        log(f"参考音频已设置: {ref_audio}")
    else:
        log("⚠ 参考音频缺失（" + str(ref_audio) + "），克隆音色将使用角色默认")
    engine = genie
    engine_ready = True
    log(f"引擎就绪: {CHARACTER} / {LANGUAGE} / {model_dir}")


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, b"ok" if engine_ready else b"loading", "text/plain")
        elif self.path.startswith("/status"):
            body = json.dumps({
                "ready": engine_ready,
                "character": CHARACTER if engine_ready else "",
                "fail": FAIL_MSG,
            }, ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        global FAIL_MSG, LAST_REF_AUDIO
        if self.path == "/set_reference":
            # 热切换默认参考音频（音色克隆）：{ref_audio, ref_text} → 立即生效并持久化到 config.json
            if not engine_ready:
                self._send(503, b"engine not ready", "text/plain")
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                ref_audio = (body.get("ref_audio") or "").strip()
                ref_text = (body.get("ref_text") or "").strip()
                if not ref_audio or not os.path.exists(ref_audio):
                    self._send(400, ("ref_audio 文件不存在: " + ref_audio).encode("utf-8", "replace"), "text/plain")
                    return
                ext = os.path.splitext(ref_audio)[1].lower()
                if ext not in (".wav", ".flac", ".ogg", ".aiff", ".aif"):
                    self._send(400, ("不支持的音频格式 " + ext + "（仅 wav/flac/ogg/aiff）").encode("utf-8", "replace"), "text/plain")
                    return
                with lock:
                    engine.set_reference_audio(
                        character_name=CHARACTER,
                        audio_path=ref_audio,
                        audio_text=ref_text,
                        language=LANGUAGE,
                    )
                    LAST_REF_AUDIO = ref_audio
                # 持久化，重启后依然生效
                try:
                    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
                    cfg["refAudio"] = ref_audio
                    cfg["refText"] = ref_text
                    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception as e:
                    log("持久化 config.json 失败: " + str(e))
                log("参考音频已热切换: " + ref_audio)
                self._send(200, b"ok", "text/plain")
            except Exception as e:
                FAIL_MSG = str(e)[:300]
                self._send(500, FAIL_MSG.encode("utf-8", "replace"), "text/plain")
            return

        if self.path != "/tts":
            self._send(404, b"not found", "text/plain")
            return
        if not engine_ready:
            self._send(503, ("engine not ready: " + FAIL_MSG).encode("utf-8", "replace"), "text/plain")
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            text = (body.get("text") or "").strip()
            if not text:
                self._send(400, b"text required", "text/plain")
                return
            text = text[:500]
            genie = engine
            with lock:
                # 仅当请求携带与当前不同的参考音频时才切换（试听用）；重复设置会导致合成劣化
                ref_audio = (body.get("ref_audio") or "").strip()
                ref_text = (body.get("ref_text") or "").strip()
                if ref_audio and os.path.exists(ref_audio) and ref_audio != LAST_REF_AUDIO:
                    genie.set_reference_audio(
                        character_name=CHARACTER,
                        audio_path=ref_audio,
                        audio_text=ref_text,
                        language=LANGUAGE,
                    )
                    LAST_REF_AUDIO = ref_audio
                    log("参考音频已切换: " + ref_audio)
                fd, tmp = tempfile.mkstemp(suffix=".wav")
                os.close(fd)
                try:
                    genie.tts(
                        character_name=CHARACTER,
                        text=text,
                        play=False,
                        split_sentence=True,
                        save_path=tmp,
                    )
                    with open(tmp, "rb") as f:
                        data = f.read()
                finally:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                if not data or len(data) < 100:
                    raise RuntimeError("合成结果为空")
                self._send(200, data, "audio/wav")
        except Exception as e:
            traceback.print_exc()
            FAIL_MSG = str(e)[:300]
            log("合成失败: " + FAIL_MSG)
            self._send(500, FAIL_MSG.encode("utf-8", "replace"), "text/plain")


# ---------------------------------------------------------------- main
def main():
    global engine_ready, FAIL_MSG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9881)
    ap.add_argument("--character", default="")
    ap.add_argument("--language", default="")
    ap.add_argument("--ref-audio", default="")
    ap.add_argument("--ref-text", default="")
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--hf-endpoint", default=None)
    args = ap.parse_args()

    cfg = load_config(args)
    log("=== Genie TTS 服务器启动 (port " + str(args.port) + ") ===")
    try:
        model_dir = provision(cfg)
        init_engine(cfg, model_dir)
    except Exception as e:
        FAIL_MSG = str(e)[:500]
        traceback.print_exc()
        log("引擎加载失败: " + FAIL_MSG)
        engine_ready = False

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log("服务就绪 http://127.0.0.1:" + str(args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
