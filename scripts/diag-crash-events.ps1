$events = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=(Get-Date '2026-09-05 18:30')} -MaxEvents 20 -ErrorAction SilentlyContinue
foreach ($e in $events) {
  $x = $e.Message
  $app = ""
  if ($x -match "应用程序名|Faulting application name:[^,]*,([^,]*)") { $app = $Matches[1].Trim() }
  $mod = ""
  if ($x -match "故障模块名称[^\r\n]*，([^，]*)，|Faulting module name:[^,]*,([^,]*)") { $mod = $Matches[1].Trim() }
  $code = ""
  if ($x -match "异常代码[:：]\s*(0x[0-9a-fA-F]+)|Exception code[:：]\s*(0x[0-9a-fA-F]+)") { $code = ($Matches[1] + $Matches[2]).Trim() }
  Write-Output ("=== " + $e.TimeCreated + " app=[" + $app + "] 模块=[" + $mod + "] 异常=" + $code)
  $head = ($x -split "`n" | Select-Object -First 6) -join " | "
  Write-Output ("    " + $head.Substring(0, [Math]::Min(260, $head.Length)))
}
