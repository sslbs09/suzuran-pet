# -*- coding: utf-8 -*-
"""语音转文字：接收音频文件路径，输出文字（用于语音输入功能）"""
import sys, os

audio_path = sys.argv[1]
lang = sys.argv[2] if len(sys.argv) > 2 else "ja"

# 探测 whisper 模型
KIT = os.environ.get("GSV_KIT", "")
candidates = [
    os.path.join(KIT, "tools", "asr", "models", "faster-whisper-medium") if KIT else "",
    "E:\\GSV-training\\GPT-SoVITS-v2pro-20250604\\tools\\asr\\models\\faster-whisper-medium",
]
model_dir = next((p for p in candidates if p and os.path.isdir(p)), "")
if not model_dir:
    # 尝试自动下载（首次使用）
    model_dir = "small"

from faster_whisper import WhisperModel

device = "cuda"
try:
    import torch
    if not torch.cuda.is_available():
        device = "cpu"
except:
    device = "cpu"

model = WhisperModel(model_dir, device=device, compute_type="float16" if device == "cuda" else "int8")
segments, info = model.transcribe(audio_path, language=lang, beam_size=5, vad_filter=True)
text = "".join(s.text for s in segments).strip()
print(text)
