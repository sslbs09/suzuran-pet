# -*- coding: utf-8 -*-
"""语音转文字：接收音频文件路径，输出文字（用于语音输入功能）"""
import sys, os

audio_path = sys.argv[1]
lang = sys.argv[2] if len(sys.argv) > 2 else "ja"

# 探测 whisper 模型
KIT = os.environ.get("GSV_KIT", "")
candidates = [
    os.path.join(KIT, "tools", "asr", "models", "faster-whisper-medium") if KIT else "",
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

# 语种：zh=中文（默认，用户说中文）；ja=日语；auto=None 自动检测
lang_param = None if lang.lower() in ("auto", "") else lang

# faster-whisper 1.1+ 支持 hotwords（热词加权，提升专有名词识别）
import inspect
try:
    _has_hotwords = "hotwords" in inspect.signature(model.transcribe).parameters
except Exception:
    _has_hotwords = False
_kw = {}
if _has_hotwords:
    _kw["hotwords"] = "苏苏洛 博士 罗德岛 干员 明日方舟 医疗"  # faster-whisper 的热词是空格分隔字符串

# 识别参数：vad 过滤静音；initial_prompt 给语言/领域提示；关闭"参考上文"防短句循环
segments, info = model.transcribe(
    audio_path,
    language=lang_param,
    beam_size=5,
    vad_filter=True,
    initial_prompt="以下是普通话的语音内容。",
    condition_on_previous_text=False,
    **_kw,
)
text = "".join(s.text for s in segments).strip()
print(text)
