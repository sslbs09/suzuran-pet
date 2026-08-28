# 复制语音引擎到生产目录 engines/（§14 追加 110：引擎随包，开箱即用）
# 用法：宿主机执行（源为宿主训练/引擎目录）；生产目录须已存在
$ErrorActionPreference = "Stop"
$dst = "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版\engines"
$GSV = "E:\GSV-training\GPT-SoVITS-v2pro-20250604"
$GENIE = "E:\GenieTTS"
function Sync($src, $tgt) {
  robocopy $src $tgt /E /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
  $code = $LASTEXITCODE
  if ($code -gt 7) { Write-Output ("FAIL " + $src + " exit=" + $code) } else { Write-Output ("OK " + $src) }
}
# GSV（日语）：运行时 + 推理代码 + 依赖小模块 + 最终模型 + 参考音频
Sync "$GSV\runtime" "$dst\gsv\runtime"
Sync "$GSV\GPT_SoVITS" "$dst\gsv\GPT_SoVITS"
Sync "$GSV\tools\i18n" "$dst\gsv\tools\i18n"
Sync "$GSV\tools\AP_BWE_main" "$dst\gsv\tools\AP_BWE_main"
Copy-Item "$GSV\api.py","$GSV\config.py","$GSV\LICENSE" "$dst\gsv\" -Force
Copy-Item "$GSV\tools\__init__.py","$GSV\tools\audio_sr.py","$GSV\tools\my_utils.py","$GSV\tools\assets.py" "$dst\gsv\tools\" -Force
Copy-Item "$GSV\SoVITS_weights_v2ProPlus\sussurro_e50_s1050.pth" "$dst\gsv\" -Force
Copy-Item "$GSV\GPT_weights_v2ProPlus\sussurro_v2proplus-e20.ckpt" "$dst\gsv\" -Force
Copy-Item "E:\SussurroTrain\segments\seg_000.wav" "$dst\gsv\ref_ja.wav" -Force
Set-Content -Path "$dst\gsv\ref_ja.txt" -Value "ドクター、そろそろ休憩の時間だよ" -Encoding UTF8
# Genie（中文）：venv + 依赖数据 + 模型 + base-python
Sync "$GENIE\venv" "$dst\genie\venv"
Sync "$GENIE\GenieData" "$dst\genie\GenieData"
Sync "$GENIE\my_model" "$dst\genie\my_model"
Sync "$GENIE\CharacterModels" "$dst\genie\CharacterModels"
Copy-Item "$GENIE\genie_tts_server.py","$GENIE\config.json" "$dst\genie\" -Force
Copy-Item "$GENIE\ref\ref_sussurro.wav","$GENIE\ref\ref_sussurro.txt" "$dst\genie\ref\" -Force
Sync "C:\Users\xsbil\AppData\Local\Programs\Python\Python313" "$dst\genie\base-python"
# VC++ 运行库 DLL（新机器没有；python 加载 onnxruntime 需要）→ venv\Scripts
Get-ChildItem "C:\Windows\System32" -Filter "*.dll" | Where-Object { $_.Name -match "^(vcomp|msvcp140|vcruntime|vccorlib|concrt).*\.dll$" } | Copy-Item -Destination "$dst\genie\venv\Scripts\" -Force
# sitecustomize.py：venv python 启动时把 Scripts 加入 DLL 搜索路径（§110）
Set-Content -Path "$dst\genie\venv\Lib\site-packages\sitecustomize.py" -Value @'
import os
try:
    _scripts = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Scripts")
    if os.path.isdir(_scripts):
        os.add_dll_directory(_scripts)
except Exception:
    pass
'@ -Encoding UTF8
# 干净化：只留 python/pythonw 启动器（其余 exe 内嵌宿主 venv 路径，新机器无效且残留）；
# 清 __pycache__（.pyc 内含源码绝对路径）；pyvenv.cfg 占位化（运行时 fixBundledGenieVenv 改写为包内 base-python）
Get-ChildItem "$dst\genie\venv\Scripts\*.exe" | Where-Object { $_.Name -notin @("python.exe","pythonw.exe") } | Remove-Item -Force
Get-ChildItem "$dst\genie" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem "$dst\gsv" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$cfg = "$dst\genie\venv\pyvenv.cfg"
$txt = Get-Content $cfg -Raw
$txt = [regex]::Replace($txt, '^home = .*$', 'home = C:\__BUNDLED_PYTHON__\Python313', 'Multiline')
$txt = [regex]::Replace($txt, '^executable = .*$', 'executable = C:\__BUNDLED_PYTHON__\Python313\python.exe', 'Multiline')
$txt = [regex]::Replace($txt, '^command = .*$', 'command = C:\__BUNDLED_PYTHON__\Python313\python.exe -m venv', 'Multiline')
Set-Content -Path $cfg -Value $txt -Encoding ASCII
Write-Output "ENGINE_COPY_DONE"
