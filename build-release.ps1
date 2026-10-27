Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Building Pew Download Manager Release" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

$rootDir = $PSScriptRoot
$distDir = Join-Path $rootDir "dist"
$extDir = Join-Path $rootDir "extensions\pew-browser-extension"
$guiDir = Join-Path $rootDir "crates\pew-gui"

# 1. Ensure dist directory exists
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# 2. Stop running instance if any
Stop-Process -Name "pew-gui" -Force -ErrorAction SilentlyContinue

# 3. Build Tauri installers (.exe and .msi)
Write-Host "`n[1/3] Building Windows Desktop Installers (Tauri)..." -ForegroundColor Yellow
Push-Location $guiDir
npx @tauri-apps/cli build
Pop-Location

# 4. Copy installers and create portable zip
Write-Host "`n[2/3] Packaging Desktop Executables..." -ForegroundColor Yellow
$nsisSource = Join-Path $rootDir "target\release\bundle\nsis\Pew Download Manager_0.1.0_x64-setup.exe"
$msiSource = Join-Path $rootDir "target\release\bundle\msi\Pew Download Manager_0.1.0_x64_en-US.msi"
$portableExe = Join-Path $rootDir "target\release\pew-gui.exe"

if (Test-Path $nsisSource) {
    Copy-Item $nsisSource -Destination $distDir -Force
}
if (Test-Path $msiSource) {
    Copy-Item $msiSource -Destination $distDir -Force
}
if (Test-Path $portableExe) {
    Compress-Archive -Path $portableExe -DestinationPath (Join-Path $distDir "Pew-Download-Manager-Windows-x64.zip") -Force
}

# 5. Package Browser Extension into ZIP
Write-Host "`n[3/3] Packaging Browser Extension..." -ForegroundColor Yellow
$extZip = Join-Path $distDir "pew-browser-extension.zip"
if (Test-Path $extZip) { Remove-Item $extZip -Force }
Compress-Archive -Path (Join-Path $extDir "*") -DestinationPath $extZip -Force

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Release Bundles Ready in ./dist/:" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Get-ChildItem $distDir | Select-Object Name, @{Name="Size (MB)";Expression={[math]::Round($_.Length / 1MB, 2)}}, LastWriteTime | Format-Table -AutoSize
