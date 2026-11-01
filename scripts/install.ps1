# Installs the `underleaf` command on Windows by adding bin\ to your user PATH.
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'underleaf: node is not on PATH. Install Node 20 or newer.'
}
$major = [int](& node -p 'parseInt(process.versions.node)')
if ($major -lt 20) {
  throw "underleaf: Node 20 or newer is required (found $(& node -v))."
}

Set-Location $AppDir
if (-not (Test-Path node_modules)) {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'underleaf: npm install failed.' }
}
& node build.mjs
if ($LASTEXITCODE -ne 0) { throw 'underleaf: the front-end build failed.' }

$bin = Join-Path $AppDir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })
if ($entries -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User')
  Write-Host "Added $bin to your PATH. Open a new terminal to use the 'underleaf' command."
}

if (-not (Get-Command tectonic -ErrorAction SilentlyContinue)) {
  Write-Warning 'Tectonic (the LaTeX engine) was not found on PATH. Underleaf runs without it, but nothing will compile. Install it from https://tectonic-typesetting.github.io/en-US/install.html'
}

Write-Host 'Installed. Run: underleaf C:\path\to\project'
