# 出厂发布打包（deploy/README §1.6）：正式版目录 → 干净 zip
# 暂存放 E:\vmwork；压缩用 7-Zip（引擎目录几十万小文件，Compress-Archive 会卡死）
$ErrorActionPreference = "Stop"
$src = "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版"
$tmp = "E:\vmwork\publish-" + (Get-Date -Format yyyyMMdd-HHmmss)
$stage = Join-Path $tmp (Split-Path $src -Leaf)

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

robocopy $src $stage /E /XD app_legacy /XF tests-walk-geo.test.js app.asar.old vm-setup.ps1 /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { Write-Output ("robocopy 失败, exit=" + $LASTEXITCODE); exit 1 }

$size = (Get-ChildItem $stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Output ("暂存完成: " + [math]::Round($size/1MB) + " MB，位于 E:\vmwork")

$zip = "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版-发布.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
& "C:\Program Files\7-Zip\7z.exe" a -tzip -mmt=on $zip $stage -bso0 -bsp0
if ($LASTEXITCODE -ne 0) { Write-Output ("7z 失败 exit=" + $LASTEXITCODE); exit 1 }
Write-Output ("zip 完成: " + [math]::Round((Get-Item $zip).Length/1MB) + " MB")
