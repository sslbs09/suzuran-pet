"""百炼 CosyVoice 复刻音色合成（苏苏洛桌宠专用）。
用法: python cosy_tts.py <req.json>
req.json: {"apiKey":.., "model":.., "voice":.., "text":.., "out":.., "rate":.., "pitch":.., "volume":..}
成功退出码 0；失败非 0，错误摘要写入 stderr。
"""
import json
import sys
import traceback


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cfg = json.load(f)
    import dashscope
    from dashscope.audio.tts_v2 import SpeechSynthesizer, AudioFormat

    dashscope.api_key = cfg["apiKey"]
    params = {"format": AudioFormat.MP3_48000HZ_MONO_256KBPS}
    if cfg.get("rate") and cfg["rate"] != 1.0:
        params["rate"] = cfg["rate"]
    if cfg.get("pitch") and cfg["pitch"] != 1.0:
        params["pitch"] = cfg["pitch"]
    if cfg.get("volume") and cfg["volume"] != 100:
        params["volume"] = cfg["volume"]
    synth = SpeechSynthesizer(model=cfg["model"], voice=cfg["voice"], **params)
    audio = synth.call(cfg["text"])
    if not audio or len(audio) < 100:
        raise RuntimeError("合成结果为空或过短")
    with open(cfg["out"], "wb") as f:
        f.write(audio)
    print("OK", len(audio))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        print(traceback.format_exc()[-800:], file=sys.stderr)
        sys.exit(1)
