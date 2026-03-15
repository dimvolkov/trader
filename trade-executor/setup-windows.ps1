# ─── Trade Executor — Windows VPS Setup ───
# Run as Administrator in PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\trade-executor\trader\trade-executor\setup-windows.ps1

# ════════════════════════════════════════════
# НАСТРОЙ ЭТИ ПЕРЕМЕННЫЕ ПЕРЕД ЗАПУСКОМ:
# ════════════════════════════════════════════
$WINDOWS_PASSWORD = "ВСТАВЬ_СВОЙ_ПАРОЛЬ"
$API_SECRET = "ВСТАВЬ_СВОЙ_СЕКРЕТ"
$MT5_PATH = "C:\Program Files\MetaTrader 5\terminal64.exe"
# ════════════════════════════════════════════

Write-Host "=== 1. Firewall: opening port 8500 ===" -ForegroundColor Green
New-NetFirewallRule -DisplayName "Trade Executor 8500" -Direction Inbound -LocalPort 8500 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue

Write-Host "=== 2. AutoLogon for Administrator ===" -ForegroundColor Green
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name AutoAdminLogon -Value "1"
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name DefaultUserName -Value "Administrator"
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name DefaultPassword -Value $WINDOWS_PASSWORD

Write-Host "=== 3. MT5 autostart ===" -ForegroundColor Green
if (Test-Path $MT5_PATH) {
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\MT5.lnk")
    $Shortcut.TargetPath = $MT5_PATH
    $Shortcut.Save()
    Write-Host "  MT5 shortcut created in Startup folder" -ForegroundColor Cyan
} else {
    Write-Host "  WARNING: MT5 not found at $MT5_PATH — fix the path!" -ForegroundColor Red
}

Write-Host "=== 4. Executor scheduled task ===" -ForegroundColor Green
# Update API secret in start-executor.bat
$batPath = "C:\trade-executor\trader\trade-executor\start-executor.bat"
if (Test-Path $batPath) {
    (Get-Content $batPath) -replace "your-random-secret-here", $API_SECRET | Set-Content $batPath
    Write-Host "  API secret updated in start-executor.bat" -ForegroundColor Cyan
}

# Register scheduled task
$existingTask = Get-ScheduledTask -TaskName "TradeExecutor" -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName "TradeExecutor" -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute "python" -Argument "executor.py" -WorkingDirectory "C:\trade-executor\trader\trade-executor"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TradeExecutor" -Action $action -Trigger $trigger -Settings $settings -User "Administrator" -RunLevel Highest
Write-Host "  Scheduled task 'TradeExecutor' registered" -ForegroundColor Cyan

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Reboot to verify: restart-computer" -ForegroundColor Yellow
Write-Host "After reboot: MT5 starts, then Executor starts on port 8500" -ForegroundColor Yellow
