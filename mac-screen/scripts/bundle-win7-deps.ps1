# 在 GitHub Actions windows-latest runner 上跑。
# 作用: 从微软官方固定直链下载 VC++ 2015-2022 x64 + 3 个 KB MSU,
#       配 install.bat 一键安装脚本, 打成 win7-deps.zip,
#       用户一次下载即可在 Win7 SP1 上部署 班级喊话演示屏。
#
# 所有 URL 均为微软官方长期稳定直链 (catalog.s.download.windowsupdate.com),
# 已逐一验证可用 (2026-09-17)。

$ErrorActionPreference = 'Stop'

# 切到 mac-screen/ (脚本在 mac-screen/scripts/ 下)
Set-Location (Join-Path $PSScriptRoot '..')

$outDir = Join-Path (Get-Location) 'win7-deps'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# ------------------------------------------------------------------
# 固定直链清单 (微软官方)
# ------------------------------------------------------------------
$files = @(
    @{
        Url  = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
        File = 'vc_redist.x64.exe'
        Desc = 'VC++ 2015-2022 x64'
    },
    @{
        Url  = 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/secu/2019/03/windows6.1-kb4490628-x64_d3de52d6987f7c8bdc2c015dca69eac96047c76e.msu'
        File = 'windows6.1-kb4490628-x64.msu'
        Desc = 'KB4490628 (Servicing Stack Update)'
    },
    @{
        Url  = 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/secu/2019/09/windows6.1-kb4474419-v3-x64_b5614c6cea5cb4e198717789633dca16308ef79c.msu'
        File = 'windows6.1-kb4474419-v3-x64.msu'
        Desc = 'KB4474419 v3 (SHA-2 code signing)'
    },
    @{
        Url  = 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/updt/2016/04/windows6.1-kb3140245-x64_5b067ffb69a94a6e5f9da89ce88c658e52a0dec0.msu'
        File = 'windows6.1-kb3140245-x64.msu'
        Desc = 'KB3140245 (SHA-2 update)'
    }
)

# ------------------------------------------------------------------
# 下载全部 4 个文件
# ------------------------------------------------------------------
$idx = 1
foreach ($f in $files) {
    Write-Host "== [$idx/4] $($f.Desc) =="
    $target = Join-Path $outDir $f.File
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $f.Url -OutFile $target -UseBasicParsing -TimeoutSec 300
    $size = (Get-Item $target).Length
    Write-Host ("    -> {0} ({1:N0} bytes)" -f $f.File, $size)
    if ($size -lt 100KB) { throw "下载异常: $($f.File) 只有 $size bytes" }
    $idx++
}

# ------------------------------------------------------------------
# install.bat - 用户右键"以管理员身份运行"即可
# ------------------------------------------------------------------
$installBat = @'
@echo off
chcp 65001 > nul
title Win7 Dependency Installer

echo ============================================================
echo    Win7 离线依赖安装 - 班级喊话演示屏
echo    请右键本文件, 以管理员身份运行
echo ============================================================
echo.

echo [1/4] VC++ 2015-2022 x64 (约 1 分钟)...
vc_redist.x64.exe /quiet /norestart
echo    done

echo [2/4] KB4490628 Servicing Stack Update (约 30 秒)...
wusa.exe windows6.1-kb4490628-x64.msu /quiet /norestart
echo    done

echo [3/4] KB4474419 SHA-2 code signing (约 1 分钟)...
wusa.exe windows6.1-kb4474419-v3-x64.msu /quiet /norestart
echo    done

echo [4/4] KB3140245 SHA-2 update (约 20 秒)...
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
$installBat | Out-File -FilePath (Join-Path $outDir 'install.bat') -Encoding ASCII

# ------------------------------------------------------------------
# README.txt
# ------------------------------------------------------------------
$buildTime = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$readme = @"
Win7 离线依赖安装包 - 班级喊话演示屏
构建时间: $buildTime UTC
commit:   $env:GITHUB_SHA

本包包含 Windows 7 SP1 (x64) / Server 2008 R2 上运行
班级喊话演示屏 所需的所有补丁和运行库。

文件清单
========
  vc_redist.x64.exe                (约 25 MB, VC++ 2015-2022 x64 运行库)
  windows6.1-kb4490628-x64.msu     (约 10 MB, Servicing Stack Update)
  windows6.1-kb4474419-v3-x64.msu  (约 50 MB, SHA-2 代码签名支持)
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
$readme | Out-File -FilePath (Join-Path $outDir 'README.txt') -Encoding UTF8

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