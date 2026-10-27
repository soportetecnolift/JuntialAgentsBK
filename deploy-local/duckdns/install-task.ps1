# Ejecuta como Administrador. Crea una tarea programada que actualiza DuckDNS cada 5 min, también al arrancar Windows.
#Requires -RunAsAdministrator
$ScriptPath = Join-Path $PSScriptRoot "update.ps1"
$Action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger1 = New-ScheduledTaskTrigger -AtStartup
$Trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName "DuckDNS Update" -Action $Action -Trigger @($Trigger1, $Trigger2) -Settings $Settings -RunLevel Highest -Force
Write-Host "Tarea 'DuckDNS Update' creada. Ejecutando una vez ahora para comprobar…"
Start-ScheduledTask -TaskName "DuckDNS Update"
Start-Sleep -Seconds 3
Get-Content (Join-Path $PSScriptRoot "duck.log") -Tail 3
