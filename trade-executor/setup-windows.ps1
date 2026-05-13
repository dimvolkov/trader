# ─── Trade Executor — Windows VPS one-shot setup ───
#
# 1) Подключись по RDP под Administrator
# 2) Открой PowerShell от имени Администратора
# 3) Скачай скрипт:
#      irm https://raw.githubusercontent.com/dimvolkov/trader/main/trade-executor/setup-windows.ps1 -OutFile setup.ps1
# 4) Открой setup.ps1 в блокноте, заполни блок переменных ниже
# 5) Запусти:
#      powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Скрипт ставит Python, Git, MetaTrader 5, клонит репо, ставит pip-пакеты,
# открывает порт 8500, настраивает AutoLogon + MT5 autostart + scheduled task.
# Идемпотентен — можно перезапустить, ранее установленное не сломается.

# ════════════════════════════════════════════
# НАСТРОЙ ЭТИ ПЕРЕМЕННЫЕ ПЕРЕД ЗАПУСКОМ:
# ════════════════════════════════════════════
$WINDOWS_PASSWORD = "ВСТАВЬ_ПАРОЛЬ_ADMINISTRATOR"
$API_SECRET       = "ВСТАВЬ_СЕКРЕТ_DLA_EXECUTOR"  # должен совпадать с EXECUTOR_API_SECRET в scanner

# Пути (обычно менять не нужно)
$INSTALL_ROOT   = "C:\trade-executor"
$REPO_URL       = "https://github.com/dimvolkov/trader.git"
$PYTHON_VERSION = "3.11.9"
$MT5_PATH       = "C:\Program Files\MetaTrader 5\terminal64.exe"
# ════════════════════════════════════════════

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Warn { param($msg) Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "  $msg" -ForegroundColor Red }

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
}

# ── Pre-flight ──
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "Запусти PowerShell от имени Администратора и повтори."
    exit 1
}
if ($WINDOWS_PASSWORD -like "*ВСТАВЬ*" -or $API_SECRET -like "*ВСТАВЬ*") {
    Write-Err "Заполни `$WINDOWS_PASSWORD и `$API_SECRET в начале скрипта."
    exit 1
}

New-Item -ItemType Directory -Force -Path $INSTALL_ROOT | Out-Null
$TempDir = Join-Path $INSTALL_ROOT "tmp"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

# ─── 1. Python ───
Write-Step "1/7. Python $PYTHON_VERSION"
$pyOk = $false
try {
    $ver = & python --version 2>&1
    if ($ver -match "Python 3\.(1[01]|12)") { $pyOk = $true; Write-Info "Уже установлен: $ver" }
} catch {}

if (-not $pyOk) {
    $pyInstaller = "$TempDir\python-installer.exe"
    Write-Info "Скачиваю Python $PYTHON_VERSION..."
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PYTHON_VERSION/python-$PYTHON_VERSION-amd64.exe" `
                      -OutFile $pyInstaller -UseBasicParsing
    Write-Info "Устанавливаю (silent, для всех пользователей, в PATH)..."
    Start-Process -FilePath $pyInstaller `
        -ArgumentList "/quiet","InstallAllUsers=1","PrependPath=1","Include_pip=1","Include_test=0" `
        -Wait
    Refresh-Path
    Write-Info "Установлено: $(& python --version)"
}

# ─── 2. Git ───
Write-Step "2/7. Git for Windows"
$gitOk = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
if ($gitOk) {
    Write-Info "Уже установлен: $(& git --version)"
} else {
    $gitInstaller = "$TempDir\git-installer.exe"
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
    Write-Info "Скачиваю Git..."
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
    Write-Info "Устанавливаю (silent)..."
    Start-Process -FilePath $gitInstaller `
        -ArgumentList "/VERYSILENT","/NORESTART","/SUPPRESSMSGBOXES","/NOCANCEL" `
        -Wait
    Refresh-Path
    Write-Info "Установлено: $(& git --version)"
}

# ─── 3. Clone repo ───
Write-Step "3/7. Репо trader"
$RepoDir = Join-Path $INSTALL_ROOT "trader"
if (Test-Path (Join-Path $RepoDir ".git")) {
    Write-Info "Уже склонировано, делаю git pull..."
    Push-Location $RepoDir
    & git pull --rebase --autostash
    Pop-Location
} else {
    if (Test-Path $RepoDir) { Remove-Item -Recurse -Force $RepoDir }
    & git clone $REPO_URL $RepoDir
    Write-Info "Склонировано в $RepoDir"
}
$ExecDir = Join-Path $RepoDir "trade-executor"

# ─── 4. Python deps ───
Write-Step "4/7. pip install MetaTrader5 + FastAPI + uvicorn"
& python -m pip install --upgrade pip --quiet
& python -m pip install --quiet MetaTrader5 fastapi==0.115.6 "uvicorn[standard]"==0.34.0
Write-Info "Зависимости установлены"

# ─── 5. MetaTrader 5 ───
Write-Step "5/7. MetaTrader 5"
if (Test-Path $MT5_PATH) {
    Write-Info "Уже установлен: $MT5_PATH"
} else {
    $mt5Installer = "$TempDir\mt5setup.exe"
    Write-Info "Скачиваю mt5setup.exe..."
    Invoke-WebRequest -Uri "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" `
                      -OutFile $mt5Installer -UseBasicParsing
    Write-Info "Запускаю установщик в silent режиме (/auto)..."
    Start-Process -FilePath $mt5Installer -ArgumentList "/auto" -Wait
    if (Test-Path $MT5_PATH) {
        Write-Info "Установлено: $MT5_PATH"
    } else {
        Write-Warn "MT5 не нашёлся в $MT5_PATH"
        Write-Warn "Возможно установился в другую папку. Поправь `$MT5_PATH в скрипте и перезапусти."
    }
}

# ─── 6. Firewall + autostart ───
Write-Step "6/7. Firewall, AutoLogon, MT5 autostart, scheduled task"

# Firewall
if (-not (Get-NetFirewallRule -DisplayName "Trade Executor 8500" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "Trade Executor 8500" -Direction Inbound `
        -LocalPort 8500 -Protocol TCP -Action Allow | Out-Null
    Write-Info "Firewall: открыт порт 8500/tcp"
} else {
    Write-Info "Firewall: правило уже есть"
}

# AutoLogon
$winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $winlogon -Name AutoAdminLogon  -Value "1"
Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value "Administrator"
Set-ItemProperty -Path $winlogon -Name DefaultPassword -Value $WINDOWS_PASSWORD
Write-Info "AutoLogon: Administrator"

# MT5 autostart (Startup folder shortcut)
if (Test-Path $MT5_PATH) {
    $startupDir   = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
    $shortcutPath = "$startupDir\MT5.lnk"
    if (-not (Test-Path $shortcutPath)) {
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($shortcutPath)
        $Shortcut.TargetPath = $MT5_PATH
        $Shortcut.Save()
        Write-Info "MT5 shortcut добавлен в Startup"
    } else {
        Write-Info "MT5 shortcut уже в Startup"
    }
} else {
    Write-Warn "MT5 не установлен — shortcut не создан"
}

# Подставить API secret в start-executor.bat
$batPath = Join-Path $ExecDir "start-executor.bat"
if (Test-Path $batPath) {
    (Get-Content $batPath) -replace "your-random-secret-here", $API_SECRET | Set-Content $batPath
    Write-Info "API secret подставлен в start-executor.bat"
}

# Scheduled task: executor при старте системы
$taskName = "TradeExecutor"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$pythonExe = (Get-Command python).Source
$action    = New-ScheduledTaskAction -Execute $pythonExe -Argument "executor.py" -WorkingDirectory $ExecDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
             -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -User "Administrator" -Password $WINDOWS_PASSWORD -RunLevel Highest | Out-Null

# Переменные окружения для scheduled task (через env user-level)
[System.Environment]::SetEnvironmentVariable("EXECUTOR_API_SECRET", $API_SECRET, "Machine")
[System.Environment]::SetEnvironmentVariable("MAX_OPEN_POSITIONS", "5", "Machine")
[System.Environment]::SetEnvironmentVariable("LOG_FILE", "C:\trade-executor\trades.log", "Machine")
[System.Environment]::SetEnvironmentVariable("TRADE_LOG_JSON", "C:\trade-executor\trades.jsonl", "Machine")
Write-Info "Scheduled task '$taskName' создан, env-переменные сохранены"

# ─── 7. Финал ───
Write-Step "7/7. Готово"
Write-Host ""
Write-Host "ОСТАЛОСЬ СДЕЛАТЬ ВРУЧНУЮ (один раз):" -ForegroundColor Yellow
Write-Host "  1. Запусти MT5 (Start menu → MetaTrader 5)" -ForegroundColor Yellow
Write-Host "  2. File → Login to Trade Account → введи login/password/server" -ForegroundColor Yellow
Write-Host "  3. Tools → Options → Expert Advisors → ✓ Allow algorithmic trading" -ForegroundColor Yellow
Write-Host "  4. Терминал запомнит сессию, далее подключится сам" -ForegroundColor Yellow
Write-Host ""
Write-Host "После этого — перезагрузка:" -ForegroundColor Yellow
Write-Host "  Restart-Computer -Force" -ForegroundColor Yellow
Write-Host ""
Write-Host "Проверка после перезагрузки (с самого VPS):" -ForegroundColor Yellow
Write-Host "  curl http://localhost:8500/health" -ForegroundColor Yellow
Write-Host "  curl -H ""X-API-Secret: $API_SECRET"" http://localhost:8500/account" -ForegroundColor Yellow
Write-Host ""
Write-Host "Снаружи (со scanner-сервера):" -ForegroundColor Yellow
Write-Host "  EXECUTOR_URL=http://<ВНЕШНИЙ_IP_VPS>:8500" -ForegroundColor Yellow
Write-Host "  EXECUTOR_API_SECRET=$API_SECRET" -ForegroundColor Yellow
