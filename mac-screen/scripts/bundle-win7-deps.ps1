# 在 GitHub Actions windows-latest runner 上跑。
# 作用: 从微软官方下载 VC++ 2015-2022 x64 + 3 个 KB MSU,
#       配 install.bat 一键安装脚本, 打成 win7-deps.zip,
#       用户一次下载即可在 Win7 SP1 上部署 班级喊话演示屏。
#
# 输出:
#   mac-screen/win7-deps/   (中间目录)
#   mac-screen/win7-deps.zip (最终产物, 由 workflow 上传为 artifact)

$ErrorActionPreference = 'Stop'

# 切到仓库根 (脚本在 mac-screen/scripts/ 下)
Set-Location (Join-Path $PSScriptRoot '..')

$outDir = Join-Path (Get-Location) 'win7-deps'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# ------------------------------------------------------------------
# 1. VC++ 2015-2022 x64 (微软官方分发, aka.ms 直链)
# ------------------------------------------------------------------
Write-Host "== [1/4] VC++ 2015-2022 x64 =="
$vcUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
$vcPath = Join-Path $outDir 'vc_redist.x64.exe'
Invoke-WebRequest -Uri $vcUrl -OutFile $vcPath -UseBasicParsing -TimeoutSec 60
Write-Host ("    -> {0} ({1:N0} bytes)" -f $vcPath, (Get-Item $vcPath).Length)

# ------------------------------------------------------------------
# 2-4. 3 个 KB MSU (通过 Microsoft Update Catalog v2 API 拉直链)
# ------------------------------------------------------------------
function Get-MsuInfo {
    param([string]$Query)

    # 优先: v2 API (POST JSON)
    try {
        $apiUrl = 'https://www.catalog.update.microsoft.com/api/v2/contents/search'
        $body = @{ q = $Query } | ConvertTo-Json -Compress
        $resp = Invoke-WebRequest -Uri $apiUrl -Method Post -Body $body `
                                  -ContentType 'application/json' `
                                  -UseBasicParsing -TimeoutSec 30
        $items = ($resp.Content | ConvertFrom-Json).results
        $update = $items | Where-Object { $_.Type -eq 'update' } |
                  Where-Object { $_.Filename -match 'windows6\.1-.*x64.*\.msu$' } |
                  Select-Object -First 1
        if ($update -and $update.Download) {
            return @{ Filename = $update.Filename; Url = $update.Download }
        }
    } catch {
        Write-Warning "    v2 API 失败 ($Query): $_"
    }

    # 兜底: catalog 页面解析 (正则抓 .msu 直链)
    try {
        $searchUrl = "https://www.catalog.update.microsoft.com/Search.aspx?q=$Query"
        $page = Invoke-WebRequest -Uri $searchUrl -UseBasicParsing -TimeoutSec 30
        $pattern = 'https://catalog\.s\.download\.windowsupdate\.com/[^"<>]+\.msu'
        $matches = [regex]::Matches($page.Content, $pattern)
        foreach ($m in $matches) {
            $u = $m.Value
            if ($u -match 'windows6\.1-.*x64.*\.msu$') {
                $fn = [System.IO.Path]::GetFileName($u)
                return @{ Filename = $fn; Url = $u }
            }
        }
    } catch {
        Write-Warning "    页面解析失败 ($Query): $_"
    }

    throw "无法解析 $Query 的 MSU 直链"
}

$kbs = @(
    @{ Query = 'KB4490628'; File = 'windows6.1-kb4490628-x64.msu' },
    @{ Query = 'KB4474419'; File = 'windows6.1-kb4474419-v2-x64.msu' },
    @{ Query = 'KB3140245'; File = 'windows6.1-kb3140245-x64.msu' }
)

$stepIdx = 2
foreach ($kb in $kbs) {
    Write-Host "== [$stepIdx/4] $($kb.Query) =="
    $info = Get-MsuInfo -Query $kb.Query
    $target = Join-Path $outDir $kb.File
    Invoke-WebRequest -Uri $info.Url -OutFile $target -UseBasicParsing -TimeoutSec 120
    Write-Host ("    -> {0} ({1:N0} bytes)" -f $target, (Get-Item $target).Length)
    $stepIdx++
}

# ------------------------------------------------------------------
# install.bat - 用户双击就能装好所有依赖并重启
# ------------------------------------------------------------------
$installBat = @'
@echo off
setlocal EnableDelayedExpansion
chcp 65001 > nul
title Win7 Dependency Installer - 班级喊话演示屏

echo ============================================================
echo    Win7 离线依赖安装 - 班级喊话演示屏
echo    请右键本文件, 以管理员身份运行
echo ============================================================
echo.

echo [1/4] 正在安装 VC++ 2015-2022 x64 (约 1 分钟)...
vc_redist.x64.exe /quiet /norestart
echo    done

echo [2/4] 正在安装 KB4490628 (Servicing Stack Update, 约 30 秒)...
wusa.exe windows6.1-kb4490628-x64.msu /quiet /norestart
echo    done

echo [3/4] 正在安装 KB4474419 (SHA-2 code signing, 约 1 分钟)...
wusa.exe windows6.1-kb4474419-v2-x64.msu /quiet /norestart
echo    done

echo [4/4] 正在安装 KB3140245 (SHA-2 update, 约 20 秒)...
wusa.exe windows6.1-kb3140245-x64.msu /quiet /norestart
echo    done

echo.
echo ============================================================
echo    所有依赖安装完成, 10 秒后自动重启
echo    重启后请双击 班级喊话演示屏 X.Y.Z.exe
echo ============================================================
shutdown /r /t 10
pause
'@
$installBat | Out-File -FilePath (Join-Path $outDir 'install.bat') -Encoding ASCII -NoNewline

# ------------------------------------------------------------------
# README.txt
# ------------------------------------------------------------------
$readme = @"
Win7 离线依赖安装包 - 班级喊话演示屏
构建时间: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) UTC
commit:   $env:GITHUB_SHA

本包包含 Windows 7 SP1 (x64) / Server 2008 R2 上运行
班级喊话演示屏 所需的所有补丁和运行库。

文件清单
========
  vc_redist.x64.exe                (约 30 MB, VC++ 2015-2022 x64 运行库)
  windows6.1-kb4490628-x64.msu     (约 10 MB, Servicing Stack Update)
  windows6.1-kb4474419-v2-x64.msu  (约 50 MB, SHA-2 代码签名支持)
  windows6.1-kb3140245-x64.msu     (约  1 MB, SHA-2 update)
  install.bat                      (一键安装脚本, 含自动重启)
  README.txt                       (本说明)

使用步骤
========
  1. 把本文件夹 (整体) 拷贝到 Win7 机器, 可以拷到桌面
  2. 进入文件夹
  3. 右键 install.bat -> "以管理员身份运行"
  4. 等待 4 个步骤完成 (约 5 分钟, 大部分在装 KB4474419)
  5. 提示 10 秒后自动重启, 此时确认即可
  6. 重启后双击 班级喊话演示屏 X.Y.Z.exe 启动

适用
====
  Windows 7 SP1 x64
  Windows Server 2008 R2 SP1

  Win10/11 用户不用下这个包, 系统自带运行库。

故障排查
========
  - "此更新不适用于您的计算机": 说明 KB4490628 没装好, 重装 SSU 再来
  - 安装 KB 时报错但继续: 通常可忽略, 重启后会再被自动配置
  - 重启后启动 exe 仍报缺 DLL: 系统是 Win7 但没打 SP1, 先打 SP1
  - 启动后白屏: 显卡驱动过旧, 升级显卡驱动后再试

卸载
====
  控制面板 -> 程序 -> 已安装更新, 卸载对应 KB 即可。
  VC++ 运行库走 控制面板 -> 程序 卸载 "Microsoft Visual C++ 2015-2022 Redistributable (x64)"。
"@
$readme | Out-File -FilePath (Join-Path $outDir 'README.txt') -Encoding UTF8 -NoNewline

# ------------------------------------------------------------------
# 打 zip
# ------------------------------------------------------------------
Write-Host ""
Write-Host "== 打包 zip =="
$zipPath = Join-Path (Get-Location) 'win7-deps.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "== 完成 =="
Get-Item $zipPath | Format-List Name, Length, LastWriteTime