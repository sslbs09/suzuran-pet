# 轻量版发布包：不含引擎（engines/），给 GitHub Release 用（2GB 上限）
$ErrorActionPreference = "Stop"
$src = "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版"
$tmp = "E:\vmwork\publish-lite-" + (Get-Date -Format yyyyMMdd-HHmmss)
$stage = Join-Path $tmp (Split-Path $src -Leaf)
New-Item -ItemType Directory -Path $stage -Force | Out-Null
robocopy $src $stage /E /XD engines app_legacy /XF app.asar.old tests-walk-geo.test.js vm-setup.ps1 /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { Write-Output ("robocopy fail " + $LASTEXITCODE); exit 1 }
$zip = "E:\vmwork\SuzuranPet-2.5.0-win32-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
& "C:\Program Files\7-Zip\7z.exe" a -tzip -mmt=on $zip $stage -bso0 -bsp0
Write-Output ("LITE_ZIP " + [math]::Round((Get-Item $zip).Length/1MB) + " MB")
