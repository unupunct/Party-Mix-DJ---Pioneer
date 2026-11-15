# Builds the engine + installers and runs the in-app self-test against every packaged form:
# unpacked (native engine), unpacked (Web Audio fallback), portable exe, and a silent install/uninstall of the installer.
# Needs two test inputs: a 120 BPM wav (node scripts/make-test-wav.js <out.wav>) and a folder with two small wavs
# ("tagged.wav" with RIFF tags and "Guess Artist - Guess Song.wav"). Usage:  pwsh scripts/verify-all.ps1 -Wav <wav> -MetaDir <dir>
param([Parameter(Mandatory)][string]$Wav, [Parameter(Mandatory)][string]$MetaDir, [string]$Wav2 = '', [string]$Work = "$env:TEMP\partymixdj-verify")
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force $Work | Out-Null
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist 2>&1 | Select-String 'building|rror|Finished' | Select-Object -Last 5
$failed = 0
function Run-SelfTest($exe, $label, $engine) {
  $out = "$Work\result-$label.json"; Remove-Item $out -ErrorAction SilentlyContinue
  $env:DJ_SELFTEST = '1'; $env:DJ_SELFTEST_WAV = $Wav; $env:DJ_SELFTEST_DIR = $MetaDir; $env:DJ_SELFTEST_OUT = $out; if ($Wav2) { $env:DJ_SELFTEST_WAV2 = $Wav2 }
  if ($engine) { $env:DJ_ENGINE = $engine } else { Remove-Item Env:DJ_ENGINE -ErrorAction SilentlyContinue }
  $p = Start-Process -FilePath $exe -PassThru -Wait
  Remove-Item Env:DJ_SELFTEST_WAV2 -ErrorAction SilentlyContinue; Remove-Item Env:DJ_SELFTEST, Env:DJ_SELFTEST_WAV, Env:DJ_SELFTEST_DIR, Env:DJ_SELFTEST_OUT -ErrorAction SilentlyContinue; Remove-Item Env:DJ_ENGINE -ErrorAction SilentlyContinue
  if (-not (Test-Path $out)) { "{0,-20}: NO RESULT (exit {1})" -f $label, $p.ExitCode; $script:failed++; return }
  $r = Get-Content $out -Raw | ConvertFrom-Json; $bad = @($r.checks | Where-Object { -not $_.pass })
  "{0,-20}: exit={1} ok={2} checks={3} failed={4} backend={5}" -f $label, $p.ExitCode, $r.ok, $r.checks.Count, $bad.Count, $r.info.backend
  $bad | Format-Table name, detail -AutoSize -Wrap | Out-String -Width 230
  if (-not $r.ok) { $script:failed++ }
}
Run-SelfTest "dist\win-unpacked\Party Mix DJ.exe" 'unpacked-native' $null
Run-SelfTest "dist\win-unpacked\Party Mix DJ.exe" 'unpacked-fallback' 'off'
Run-SelfTest "dist\DDJSBDJ-0.2.1-portable.exe" 'portable-native' $null
$inst = "$Work\installed-app"; Remove-Item $inst -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath 'dist\DDJSBDJ-Setup-0.2.1.exe' -ArgumentList "/S /D=$inst" -Wait
Run-SelfTest "$inst\Party Mix DJ.exe" 'installed-native' $null
$un = Get-ChildItem $inst -Filter 'Uninstall*.exe' | Select-Object -First 1; Start-Process -FilePath $un.FullName -ArgumentList '/S' -Wait
for ($i = 0; $i -lt 30 -and (Test-Path "$inst\Party Mix DJ.exe"); $i++) { Start-Sleep 1 }
$clean = -not (Test-Path "$inst\Party Mix DJ.exe"); $stray = (Get-Process djengine -ErrorAction SilentlyContinue | Measure-Object).Count
"uninstalled cleanly: $clean; engine processes left: $stray"
Get-ChildItem dist -Filter *.exe | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime | Format-Table -AutoSize
if (-not $clean -or $stray -gt 0) { $failed++ }
if ($failed) { "VERIFY FAILED ($failed problem(s))"; exit 1 } else { "VERIFY OK" }
