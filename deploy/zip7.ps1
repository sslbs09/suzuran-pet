$ErrorActionPreference = "Stop"
& "C:\Program Files\7-Zip\7z.exe" a -tzip -mmt=on "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版-发布.zip" "E:\vmwork\publish-20260828-193803\苏苏洛桌宠-1.1.0正式版" -bso0 -bsp0
if ($LASTEXITCODE -ne 0) { Write-Output ("7z exit=" + $LASTEXITCODE) } else { Write-Output ("ZIP_DONE " + [math]::Round((Get-Item 'E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版-发布.zip').Length/1MB) + " MB") }
