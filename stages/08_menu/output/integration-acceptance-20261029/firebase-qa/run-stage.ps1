param([Parameter(Mandatory=$true)][string]$CmdFile, [Parameter(Mandatory=$true)][string]$StageLabel)
$ErrorActionPreference = 'Stop'
$qa   = 'C:\Users\DELL\Desktop\Burgonomics\stages\08_menu\output\integration-acceptance-20261029\firebase-qa'
$java = 'C:\Program Files\Android\Android Studio\jbr\bin\java.exe'
$jar  = "$env:USERPROFILE\.cache\firebase\emulators\cloud-firestore-emulator-v1.22.0.jar"
$emuData = "$env:LOCALAPPDATA\Temp\opencode\firebase-qa-emu-$StageLabel"
New-Item -ItemType Directory -Force -Path "$qa\logs", $emuData | Out-Null
if (Test-NetConnection -ComputerName 127.0.0.1 -Port 8166 -InformationLevel Quiet -WarningAction SilentlyContinue) { Write-Output "PORT 8166 ALREADY OCCUPIED"; exit 3 }
$p = Start-Process -FilePath $java -ArgumentList '-jar', "`"$jar`"", '--host=127.0.0.1', '--port=8166', '--project_id=demo-firebase-qa-20261029' -RedirectStandardOutput "$qa\logs\emu-$StageLabel-stdout.log" -RedirectStandardError "$qa\logs\emu-$StageLabel-stderr.log" -PassThru -NoNewWindow -WorkingDirectory $emuData
$p.Id | Set-Content "$qa\emulator.pid"
Write-Output "EMULATOR_PID=$($p.Id)"
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Milliseconds 1000
  try { $t = New-Object Net.Sockets.TcpClient; $ok = $t.ConnectAsync('127.0.0.1', 8166).Wait(500); if ($ok -and $t.Connected) { $ready = $true }; $t.Close() } catch {}
  if ($ready) { break }
}
if (-not $ready) { Get-Content "$qa\logs\emu-$StageLabel-stderr.log" -Tail 30 -ErrorAction SilentlyContinue; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; exit 4 }
try {
  cmd /c "`"$CmdFile`" > `"$qa\logs\stage-$StageLabel-console.log`" 2>&1"
  $code = $LASTEXITCODE
  Get-Content "$qa\logs\stage-$StageLabel-console.log" | ForEach-Object { $line = "$_"; if ($line -match '^\[harness|^GATE|^PROBE COMPLETE|^ Tests|^Test Files|VIOLATION|Error:') { Write-Output $line } }
} finally {
  if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item "$qa\emulator.pid" -Force -ErrorAction SilentlyContinue
}
Write-Output "STAGE[$StageLabel] exit=$code"
exit $code
