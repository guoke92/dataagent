# Native Windows entry for DataFoundry deploy.
# Linux, macOS, and Git Bash use ./deploy.sh. cmd users can run deploy.cmd.
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-DeployArch {
  $arch = if ($env:DATAFOUNDRY_UNAME_M) { $env:DATAFOUNDRY_UNAME_M } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    { $_ -in "AMD64", "x86_64", "amd64" } { return "x64" }
    { $_ -in "ARM64", "aarch64", "arm64" } { return "arm64" }
    default {
      [Console]::Error.WriteLine("Unsupported architecture: $arch. DataFoundry native deploy supports x86_64/amd64 and aarch64/arm64 only.")
      exit 1
    }
  }
}

function Get-NodePrefix {
  if ($env:DATAFOUNDRY_NODE_PREFIX) { return $env:DATAFOUNDRY_NODE_PREFIX }
  return Join-Path $env:USERPROFILE ".local\share\datafoundry\node"
}

function Get-NodeMajor([string]$VersionText) {
  if ($VersionText -match 'v?(\d+)') { return [int]$Matches[1] }
  return $null
}

function Test-Node22 {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  $version = & node --version 2>$null
  $major = Get-NodeMajor "$version"
  return ($null -ne $major -and $major -ge 22)
}

function Add-NodePrefixToPath {
  $prefix = Get-NodePrefix
  $bin = $null
  if (Test-Path (Join-Path $prefix "bin\node.exe")) {
    $bin = Join-Path $prefix "bin"
  } elseif (Test-Path (Join-Path $prefix "node.exe")) {
    $bin = $prefix
  } else {
    return
  }
  $parts = $env:PATH -split ';'
  if ($parts -notcontains $bin) {
    $env:PATH = "$bin;$env:PATH"
  }
}

function Test-ReadonlyCommand([string[]]$CommandArgs) {
  foreach ($token in $CommandArgs) {
    if ($token -in @("status", "logs", "stop", "doctor", "help")) { return $true }
  }
  return $false
}

function Test-NonInteractive([string[]]$CommandArgs) {
  return ($CommandArgs -contains "--non-interactive")
}

function Install-Node22Official {
  param([switch]$AssumeYes)

  $arch = Get-DeployArch
  $suffix = "win-$arch.zip"
  $prefix = Get-NodePrefix
  $source = "https://nodejs.org/dist/latest-v22.x/"
  Write-Host "Node.js 22 is required."
  Write-Host "Installer source: $source (*-$suffix)"
  Write-Host "Install location: $prefix"
  Write-Host "Commands:"
  Write-Host "  download ${source}SHASUMS256.txt"
  Write-Host "  download ${source}<node-archive>"
  Write-Host "  verify SHA-256, then extract into $prefix"

  if (-not $AssumeYes) {
    $answer = Read-Host "Install Node.js 22 from nodejs.org now? [y/N]"
    if ($answer -notmatch '^(y|yes)$') {
      [Console]::Error.WriteLine("Node.js 22 is required. Install it and re-run deploy.cmd.")
      exit 1
    }
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("datafoundry-node-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $sumsPath = Join-Path $tmp "SHASUMS256.txt"
    Invoke-WebRequest -Uri "${source}SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing
    $pattern = '^(?<hash>[0-9a-fA-F]+)\s+(?<name>node-v22[0-9.]*-' + [regex]::Escape($suffix) + ')$'
    $match = Get-Content $sumsPath | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $match -or $match -notmatch $pattern) {
      throw "Could not resolve a Node.js 22 $suffix download."
    }
    $checksum = $Matches["hash"].ToLower()
    $name = $Matches["name"]
    $archive = Join-Path $tmp $name
    Invoke-WebRequest -Uri "$source$name" -OutFile $archive -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
    if ($actual -ne $checksum) {
      throw "Node.js download checksum mismatch."
    }
    $extract = Join-Path $tmp "extract"
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $extracted = Get-ChildItem $extract -Directory | Where-Object { $_.Name -like "node-v22*" } | Select-Object -First 1
    if (-not $extracted) {
      throw "Node.js archive did not contain a node-v22 directory."
    }
    if (Test-Path $prefix) { Remove-Item -LiteralPath $prefix -Recurse -Force }
    $parent = Split-Path -Parent $prefix
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Move-Item -LiteralPath $extracted.FullName -Destination $prefix
  } finally {
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  }

  Add-NodePrefixToPath
  if (-not (Test-Node22)) {
    [Console]::Error.WriteLine("Node.js 22 installation did not produce a working node command.")
    exit 1
  }
  Write-Host "Node.js 22 is installed at $prefix."
  Write-Host "This directory was added to PATH for the current process."
  Write-Host "Add it to your user PATH to use node in new terminals:"
  Write-Host "  $prefix"
}

function Ensure-Node22([string[]]$CommandArgs) {
  Add-NodePrefixToPath
  if (Test-Node22) { return }
  if (Test-ReadonlyCommand $CommandArgs) {
    [Console]::Error.WriteLine("Node.js 22+ is required for this command. Install Node.js 22 and re-run deploy.cmd $($CommandArgs -join ' ').")
    exit 1
  }
  $assumeYes = Test-NonInteractive $CommandArgs
  if ($assumeYes) {
    Install-Node22Official -AssumeYes
  } else {
    Install-Node22Official
  }
}

if ($env:OS -ne "Windows_NT" -and -not $env:DATAFOUNDRY_FORCE_WINDOWS_DEPLOY) {
  [Console]::Error.WriteLine("deploy.ps1 is the native Windows entry. On Linux and macOS run ./deploy.sh.")
  exit 1
}

Get-DeployArch | Out-Null

if ($env:DATAFOUNDRY_INSTALL_NODE_ONLY -eq "1") {
  Add-NodePrefixToPath
  if (-not (Test-Node22)) {
    Install-Node22Official -AssumeYes
  }
  exit 0
}

Ensure-Node22 @args
$cli = Join-Path $RootDir "scripts\deploy\cli.mjs"
& node $cli @args
exit $LASTEXITCODE
