$ErrorActionPreference = "Continue"
$src = "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版"
$dst = "E:\SuzuranPetGit\release\v2.5\苏苏洛桌宠 2.5 正式版"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
robocopy $src $dst /E /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
Write-Output ("migrate exit=" + $LASTEXITCODE)
if ($LASTEXITCODE -le 7) {
  # 迁移成功后删除 C 盘原目录（exe 已停）
  Remove-Item $src -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "C 盘原目录已删"
}
