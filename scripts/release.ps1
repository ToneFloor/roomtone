# Build a ROOMTONE release without the build machine's name inside it.
#
# rustc bakes the path of every source file it compiles into the binary, so it
# can tell you where a panic happened. For dependencies, those paths live in the
# Cargo registry under the builder's home directory — which means a plain
# `npm run tauri build` ships a binary containing the builder's Windows account
# name several hundred times over. Anyone who downloads it can read it with
# `strings`.
#
# Cargo has a profile option for this (`trim-paths`) but it is not stable yet.
# `--remap-path-prefix` is, and does the same job: rustc rewrites any path
# starting with the prefix before recording it. Crash reports still name the
# file and line; they just no longer name whose disk it came from.
#
# The prefixes are worked out here, at build time, rather than written into a
# committed config — otherwise removing one machine's name would only have put
# another one in the repository.

$ErrorActionPreference = 'Stop'

$cargoHome  = if ($env:CARGO_HOME)  { $env:CARGO_HOME }  else { Join-Path $env:USERPROFILE '.cargo'  }
$rustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $env:USERPROFILE '.rustup' }

# RUSTFLAGS is split on spaces, so a home directory containing one would break
# the flags apart. Rare on Windows, but worth saying out loud rather than
# producing a confusing compiler error.
foreach ($path in @($cargoHome, $rustupHome)) {
  if ($path -match '\s') {
    throw "Cannot remap '$path': the path contains a space, which RUSTFLAGS cannot express. Move CARGO_HOME/RUSTUP_HOME somewhere without spaces, or build with trim-paths on nightly."
  }
}

$env:RUSTFLAGS = "--remap-path-prefix=$cargoHome=/cargo --remap-path-prefix=$rustupHome=/rustup"

Write-Host "Building with remapped paths:" -ForegroundColor Cyan
Write-Host "  $cargoHome  -> /cargo"
Write-Host "  $rustupHome -> /rustup"
Write-Host ""

Push-Location (Join-Path $PSScriptRoot '..')
try {
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

# Prove it worked rather than assuming. The check is the point of the script.
$exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\ROOMTONE.exe'
if (Test-Path $exe) {
  $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($exe))
  $leaks = ([regex]::Matches($text, [regex]::Escape($env:USERNAME))).Count
  if ($leaks -gt 0) {
    Write-Host ""
    Write-Warning "$leaks occurrence(s) of '$env:USERNAME' are still in ROOMTONE.exe. Do not publish this build."
    exit 1
  }
  Write-Host ""
  Write-Host "Clean: no occurrences of '$env:USERNAME' in ROOMTONE.exe." -ForegroundColor Green
}
