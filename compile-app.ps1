# 编译 App/apps 下的叠加应用（overlay app）—— 本地版，不需要 Docker。
# 与仓库里的 compile-app.sh（Docker 版）等价：仍然调用每个 app 自己的 build.sh，
# 只是用本机 arm-none-eabi 工具链，产物同样汇总到 build\Apps\。
#
# 用法:
#   .\compile-app.ps1                  # 编译全部 app
#   .\compile-app.ps1 All              # 同上
#   .\compile-app.ps1 spectrum3d       # 编译一个
#   .\compile-app.ps1 fm foxhunt       # 编译几个
#
# 预算: 每个 .app 上限 4096 B（超出会标 OVERFLOW 并以退出码 1 结束）
# VMA : 默认 0x20000280，必须与固件 Core/py32f071xb.ld 的 overlay VMA 一致
$env:PATH = "D:\ArmGNUToolChain\bin;$env:PATH"

$root       = $PSScriptRoot
$appsDir    = Join-Path $root 'App\apps'
$outDir     = Join-Path $root 'build\Apps'
$overlayMax = 4096
if (-not $env:APP_VMA) { $env:APP_VMA = '0x20000280' }

# 必须是真正的 bash：PATH 上的 bash 可能是 WSL 的 C:\Windows\system32\bash.exe
$bash = @(
    $env:APP_BASH
    'C:\Program Files\Git\bin\bash.exe'
    'C:\Program Files\Git\usr\bin\bash.exe'
    'C:\msys64\usr\bin\bash.exe'
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bash) { Write-Error 'bash not found (Git Bash / MSYS2). Set $env:APP_BASH to override.'; exit 1 }

$all = Get-ChildItem $appsDir -Directory |
       Where-Object { Test-Path (Join-Path $_.FullName 'build.sh') } |
       Select-Object -ExpandProperty Name | Sort-Object
if (-not $all) { Write-Error "no apps found under $appsDir"; exit 1 }

$targets = if ($args.Count -eq 0 -or $args[0] -match '^(?i)all$') { $all } else { $args }
foreach ($t in $targets) {
    if ($all -notcontains $t) { Write-Error "unknown app '$t'. Available: $($all -join ', ') (or All)"; exit 1 }
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Write-Host ""
Write-Host "Building overlay apps"
Write-Host "   VMA $env:APP_VMA - budget $overlayMax B / 4.00 KiB - out build/Apps/"
Write-Host ""

$rows = @()
$fail = 0
foreach ($app in $targets) {
    $dir = Join-Path $appsDir $app
    Push-Location $dir
    & $bash -c "set -o pipefail; sed 's/\r$//' ./build.sh | bash"
    $code = $LASTEXITCODE
    Pop-Location

    $blob = Get-ChildItem (Join-Path $dir '*.app') -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($code -ne 0 -or -not $blob) {
        $fail = 1
        $rows += [pscustomobject]@{ File = $app; Code = '-'; Free = '-'; Usage = '-'; VMA = '-'; Status = 'BUILD FAIL' }
        continue
    }

    Copy-Item $blob.FullName $outDir -Force
    $b      = [System.IO.File]::ReadAllBytes($blob.FullName)
    $size   = [int][BitConverter]::ToUInt32($b, 8)      # app_header_t.code_size
    $assets = [int][BitConverter]::ToUInt16($b, 60)     # app_header_t.asset_size
    $vma    = '0x{0:x8}' -f [BitConverter]::ToUInt32($b, 52)

    if ($size -gt $overlayMax) { $status = 'OVERFLOW'; $fail = 1 }
    elseif ($assets -gt 0)     { $status = "OK (+$assets B assets)" }
    else                       { $status = 'OK' }

    $rows += [pscustomobject]@{
        File  = $blob.Name
        Code  = $size
        Free  = $overlayMax - $size
        Usage = '{0:N1}%' -f (100.0 * $size / $overlayMax)
        VMA   = $vma
        Status = $status
    }
}

$built = @($rows | Where-Object { $_.Code -ne '-' }).Count
Write-Host ""
Write-Host "Overlay apps (budget: $overlayMax B / 4.00 KiB)"
$rows | Format-Table -AutoSize

if ($built -gt 1) {
    $totCode   = ($rows | Where-Object { $_.Code -ne '-' } | Measure-Object Code -Sum).Sum
    $totAssets = 0
    foreach ($r in $rows) { if ($r.Status -match '\+(\d+) B assets') { $totAssets += [int]$Matches[1] } }
    Write-Host ("TOTAL: {0} B code ({1:N1}% avg of 4 KiB) + {2} B assets" -f $totCode, (100.0 * $totCode / ($built * $overlayMax)), $totAssets)
}

if ($fail -eq 0) { Write-Host "Done: $built app(s) -> build\Apps\" }
else             { Write-Host "Some apps failed or overflowed - see the table above." }
exit $fail
