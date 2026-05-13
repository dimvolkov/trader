# --- Trade Executor - Windows VPS one-shot setup ---
#
# 1) Connect via RDP as Administrator
# 2) Open PowerShell as Administrator
# 3) Download this script:
#      irm https://raw.githubusercontent.com/dimvolkov/trader/main/trade-executor/setup-windows.ps1 -OutFile setup.ps1
# 4) Open setup.ps1 in notepad, fill in the variables below
# 5) Run:
#      powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# What it does: installs Python, Git, MetaTrader 5, clones the repo, installs pip packages,
# opens port 8500, sets AutoLogon + MT5 autostart + scheduled task for executor.
# Idempotent - safe to re-run, already-installed components are skipped.

# ============================================
# FILL IN THESE VARIABLES BEFORE RUNNING:
# ============================================
$WINDOWS_PASSWORD = "PUT_ADMINISTRATOR_PASSWORD_HERE"
$API_SECRET       = "PUT_EXECUTOR_API_SECRET_HERE"  # must match EXECUTOR_API_SECRET in scanner

# Paths (usually no need to change)
$INSTALL_ROOT   = "C:\trade-executor"
$REPO_URL       = "https://github.com/dimvolkov/trader.git"
$PYTHON_VERSION = "3.11.9"
$MT5_PATH       = "C:\Program Files\MetaTrader 5\terminal64.exe"
# ============================================

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

# -- Pre-flight --
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "Run PowerShell as Administrator and retry."
    exit 1
}
if ($WINDOWS_PASSWORD -like "*PUT_*" -or $API_SECRET -like "*PUT_*") {
    Write-Err "Fill in `$WINDOWS_PASSWORD and `$API_SECRET at the top of this script."
    exit 1
}

New-Item -ItemType Directory -Force -Path $INSTALL_ROOT | Out-Null
$TempDir = Join-Path $INSTALL_ROOT "tmp"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

# --- 1. Python ---
Write-Step "1/7. Python $PYTHON_VERSION"
$pyOk = $false
try {
    $ver = & python --version 2>&1
    if ($ver -match "Python 3\.(1[01]|12)") { $pyOk = $true; Write-Info "Already installed: $ver" }
} catch {}

if (-not $pyOk) {
    $pyInstaller = "$TempDir\python-installer.exe"
    Write-Info "Downloading Python $PYTHON_VERSION..."
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PYTHON_VERSION/python-$PYTHON_VERSION-amd64.exe" `
                      -OutFile $pyInstaller -UseBasicParsing
    Write-Info "Installing (silent, all users, in PATH)..."
    Start-Process -FilePath $pyInstaller `
        -ArgumentList "/quiet","InstallAllUsers=1","PrependPath=1","Include_pip=1","Include_test=0" `
        -Wait
    Refresh-Path
    Write-Info "Installed: $(& python --version)"
}

# --- 2. Git ---
Write-Step "2/7. Git for Windows"
$gitOk = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
if ($gitOk) {
    Write-Info "Already installed: $(& git --version)"
} else {
    $gitInstaller = "$TempDir\git-installer.exe"
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
    Write-Info "Downloading Git..."
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
    Write-Info "Installing (silent)..."
    Start-Process -FilePath $gitInstaller `
        -ArgumentList "/VERYSILENT","/NORESTART","/SUPPRESSMSGBOXES","/NOCANCEL" `
        -Wait
    Refresh-Path
    Write-Info "Installed: $(& git --version)"
}

# --- 3. Clone repo ---
Write-Step "3/7. Repo: trader"
$RepoDir = Join-Path $INSTALL_ROOT "trader"
if (Test-Path (Join-Path $RepoDir ".git")) {
    Write-Info "Already cloned, pulling latest..."
    Push-Location $RepoDir
    & git pull --rebase --autostash
    Pop-Location
} else {
    if (Test-Path $RepoDir) { Remove-Item -Recurse -Force $RepoDir }
    & git clone $REPO_URL $RepoDir
    Write-Info "Cloned to $RepoDir"
}
$ExecDir = Join-Path $RepoDir "trade-executor"

# --- 4. Python deps ---
Write-Step "4/7. pip install MetaTrader5 + FastAPI + uvicorn"
& python -m pip install --upgrade pip --quiet
& python -m pip install --quiet MetaTrader5 fastapi==0.115.6 "uvicorn[standard]"==0.34.0
Write-Info "Dependencies installed"

# --- 5. MetaTrader 5 ---
Write-Step "5/7. MetaTrader 5"
if (Test-Path $MT5_PATH) {
    Write-Info "Already installed: $MT5_PATH"
} else {
    $mt5Installer = "$TempDir\mt5setup.exe"
    Write-Info "Downloading mt5setup.exe..."
    Invoke-WebRequest -Uri "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" `
                      -OutFile $mt5Installer -UseBasicParsing
    Write-Info "Running installer in silent mode (/auto)..."
    Start-Process -FilePath $mt5Installer -ArgumentList "/auto" -Wait
    if (Test-Path $MT5_PATH) {
        Write-Info "Installed: $MT5_PATH"
    } else {
        Write-Warn "MT5 not found at $MT5_PATH"
        Write-Warn "It may have installed in a different folder. Edit `$MT5_PATH and re-run."
    }
}

# --- 6. Firewall + autostart ---
Write-Step "6/7. Firewall, AutoLogon, MT5 autostart, scheduled task"

# Firewall
if (-not (Get-NetFirewallRule -DisplayName "Trade Executor 8500" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "Trade Executor 8500" -Direction Inbound `
        -LocalPort 8500 -Protocol TCP -Action Allow | Out-Null
    Write-Info "Firewall: port 8500/tcp opened"
} else {
    Write-Info "Firewall: rule already exists"
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
        Write-Info "MT5 shortcut added to Startup"
    } else {
        Write-Info "MT5 shortcut already in Startup"
    }
} else {
    Write-Warn "MT5 not installed - shortcut skipped"
}

# Substitute API secret in start-executor.bat
$batPath = Join-Path $ExecDir "start-executor.bat"
if (Test-Path $batPath) {
    (Get-Content $batPath) -replace "your-random-secret-here", $API_SECRET | Set-Content $batPath
    Write-Info "API secret substituted in start-executor.bat"
}

# Scheduled task: executor at system startup
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

# Machine-level env vars for the scheduled task
[System.Environment]::SetEnvironmentVariable("EXECUTOR_API_SECRET", $API_SECRET, "Machine")
[System.Environment]::SetEnvironmentVariable("MAX_OPEN_POSITIONS", "5", "Machine")
[System.Environment]::SetEnvironmentVariable("LOG_FILE", "C:\trade-executor\trades.log", "Machine")
[System.Environment]::SetEnvironmentVariable("TRADE_LOG_JSON", "C:\trade-executor\trades.jsonl", "Machine")
Write-Info "Scheduled task '$taskName' registered, env vars saved"

# --- 7. Finish ---
Write-Step "7/7. Done"
Write-Host ""
Write-Host "DO THIS MANUALLY ONCE:" -ForegroundColor Yellow
Write-Host "  1. Launch MT5 (Start menu -> MetaTrader 5)" -ForegroundColor Yellow
Write-Host "  2. File -> Login to Trade Account -> enter login/password/server" -ForegroundColor Yellow
Write-Host "  3. Tools -> Options -> Expert Advisors -> check 'Allow algorithmic trading'" -ForegroundColor Yellow
Write-Host "  4. MT5 will remember the session and reconnect on next start" -ForegroundColor Yellow
Write-Host ""
Write-Host "Then reboot:" -ForegroundColor Yellow
Write-Host "  Restart-Computer -Force" -ForegroundColor Yellow
Write-Host ""
Write-Host "Verify after reboot (on the VPS itself):" -ForegroundColor Yellow
Write-Host "  curl http://localhost:8500/health" -ForegroundColor Yellow
Write-Host "  curl -H ""X-API-Secret: $API_SECRET"" http://localhost:8500/account" -ForegroundColor Yellow
Write-Host ""
Write-Host "From scanner side:" -ForegroundColor Yellow
Write-Host "  EXECUTOR_URL=http://<VPS_PUBLIC_IP>:8500" -ForegroundColor Yellow
Write-Host "  EXECUTOR_API_SECRET=$API_SECRET" -ForegroundColor Yellow
