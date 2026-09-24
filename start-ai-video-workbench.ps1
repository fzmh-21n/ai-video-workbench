$Host.UI.RawUI.WindowTitle = "AI Video Workbench - keep this window open"

$workbenchDir = $PSScriptRoot
$bundledRuntimeDir = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$bundledNodeDir = Join-Path $bundledRuntimeDir "node\bin"
$bundledPnpm = Join-Path $bundledRuntimeDir "bin\fallback\pnpm.cmd"

function Test-LocalPort([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $connection = $client.ConnectAsync("127.0.0.1", $Port)
    if (-not $connection.Wait(500)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Stop-WorkbenchPort([int]$Port) {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $workbenchDir "package.json"))) {
  Write-Host "Workbench source folder was not found:" -ForegroundColor Red
  Write-Host $workbenchDir
  Read-Host "Press Enter to close"
  exit 1
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  if (Test-Path -LiteralPath (Join-Path $bundledNodeDir "node.exe")) {
    $env:Path = "$bundledNodeDir;$env:Path"
  } else {
    Write-Host "Node.js was not found. Install Node.js 20 or newer:" -ForegroundColor Red
    Write-Host "https://nodejs.org/"
    Read-Host "Press Enter to close"
    exit 1
  }
}

$pnpmLookup = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$pnpmCommand = if ($pnpmLookup) { $pnpmLookup.Source } else { $null }
if (-not $pnpmCommand -and (Test-Path -LiteralPath $bundledPnpm)) {
  $pnpmCommand = $bundledPnpm
}
if (-not $pnpmCommand) {
  Write-Host "pnpm was not found. Run: npm install -g pnpm" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

Set-Location -LiteralPath $workbenchDir
Stop-WorkbenchPort 8787
Stop-WorkbenchPort 5173
Start-Sleep -Milliseconds 600

if (-not (Test-Path -LiteralPath (Join-Path $workbenchDir "node_modules"))) {
  Write-Host "Installing dependencies for the first run..." -ForegroundColor Yellow
  & $pnpmCommand install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Dependency installation failed. Check the network and retry." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
  }
}

$runtimeLog = Join-Path $workbenchDir ".workbench-data\launcher.log"
New-Item -ItemType Directory -Path (Split-Path -Parent $runtimeLog) -Force | Out-Null
"[$(Get-Date -Format o)] Starting workbench" | Tee-Object -FilePath $runtimeLog -Append
Write-Host "Runtime log: $runtimeLog"

Write-Host "Preparing AI Video Workbench..." -ForegroundColor Cyan
& $pnpmCommand run build *>&1 | Tee-Object -FilePath $runtimeLog -Append
if ($LASTEXITCODE -ne 0) {
  Write-Host "Workbench build failed. Check the runtime log above." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Starting AI Video Workbench..." -ForegroundColor Cyan
Write-Host "The browser will open automatically."
Write-Host "Keep this window open while using the workbench."

$env:PORT = "5173"
$browserCommand = "Start-Sleep -Seconds 2; Start-Process `"http://localhost:5173/`""
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  "-NoProfile",
  "-WindowStyle", "Hidden",
  "-Command", $browserCommand
)

$restartCount = 0
do {
  & $pnpmCommand start *>&1 | Tee-Object -FilePath $runtimeLog -Append
  $exitCode = $LASTEXITCODE
  "[$(Get-Date -Format o)] Workbench exited with code $exitCode" | Tee-Object -FilePath $runtimeLog -Append
  if ($exitCode -eq 0 -or $restartCount -ge 4) { break }
  $restartCount++
  Write-Host "Workbench stopped unexpectedly. Restarting in 3 seconds ($restartCount/5)..." -ForegroundColor Yellow
  "[$(Get-Date -Format o)] Unexpected exit; automatic restart $restartCount/5" | Tee-Object -FilePath $runtimeLog -Append
  Start-Sleep -Seconds 3
} while ($true)

Write-Host "Workbench stopped (exit code $exitCode). Check the runtime log above for the cause." -ForegroundColor Yellow
Read-Host "Press Enter to close"
