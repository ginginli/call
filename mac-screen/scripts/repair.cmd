@echo off
chcp 65001 > nul
title 班级喊话 · 一键修复

echo.
echo ==============================================================
echo   班级喊话 · 一键修复 (v1.0)
echo.
echo   本工具会做 4 件可逆的修复:
echo     [1] DNS 改 8.8.8.8 / 114.114.114.114 (修 DNS 污染/封禁)
echo     [2] 重置 Winsock (修奇怪网络问题)
echo     [3] 同步系统时间 (避免证书过期误判)
echo     [4] 清理教室端脏 settings.json (回到默认地址)
echo.
echo   都是可逆操作: 控制面板 → 网络 → 改回"自动获取"即可撤销
echo ==============================================================
echo.

REM 确认步骤: 防止误操作
set /p CONFIRM=确认要继续吗? 输入 yes 回车继续, 其他键取消:
if /i not "%CONFIRM%"=="yes" (
    echo 已取消。
    pause
    exit /b
)

set HERE=%~dp0
set LOG=%HERE%fix.log

REM 清空旧日志
if exist "%LOG%" del "%LOG%"

echo. > "%LOG%"
echo ===== 班级喊话 · 一键修复日志 =====              >> "%LOG%"
echo 开始时间: %DATE% %TIME%                          >> "%LOG%"
echo 操作电脑: %COMPUTERNAME% / %USERNAME%            >> "%LOG%"
echo.                                                >> "%LOG%"

echo.
echo [1/4] 设置 DNS 为 8.8.8.8 / 114.114.114.114 ...
echo ----- [1/4] DNS -----                            >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-WmiObject -Class Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' | ForEach-Object { $r = $_.SetDNSServerSearchOrder(@('8.8.8.8','114.114.114.114')); $_.Caption + ' -> ' + (if ($r.ReturnValue -eq 0) { 'OK' } else { 'FAIL code=' + $r.ReturnValue }) }" >> "%LOG%" 2>&1
echo 完成.
echo.

echo [2/4] 重置 Winsock (需要管理员权限) ...
echo ----- [2/4] Winsock reset -----                  >> "%LOG%"
netsh winsock reset >> "%LOG%" 2>&1
echo 完成. 重启后生效.
echo.

echo [3/4] 同步系统时间 ...
echo ----- [3/4] 时间同步 -----                       >> "%LOG%"
net stop w32time >> "%LOG%" 2>&1
net start w32time >> "%LOG%" 2>&1
w32tm /resync /force >> "%LOG%" 2>&1
echo 完成.
echo.

echo [4/4] 清理教室端脏 settings.json ...
echo ----- [4/4] 清理 settings.json -----             >> "%LOG%"
set CONFIG_PATH=%APPDATA%\班级喊话演示屏\settings.json
if exist "%CONFIG_PATH%" (
    echo 删除: %CONFIG_PATH%                          >> "%LOG%"
    del "%CONFIG_PATH%" >> "%LOG%" 2>&1
    echo 已删除. 教室端下次启动会回到默认 https://callclass.site >> "%LOG%"
) else (
    echo 无脏配置, 跳过.                              >> "%LOG%"
)
echo.

echo ==============================================================
echo   修复完成
echo   日志: %LOG%
echo.
echo   重要: 重启电脑 让 DNS / Winsock 改动彻底生效
echo         (重启前虽然能用, 但部分应用还在用旧 DNS 缓存)
echo ==============================================================
echo.
echo ----- 建议下一步 -----                            >> "%LOG%"
echo 1. 重启电脑                                       >> "%LOG%"
echo 2. 重启后再跑一次 diagnose.cmd 验证               >> "%LOG%"
echo 3. 然后打开教室端测试                              >> "%LOG%"

echo 自动打开日志...
start notepad "%LOG%"

pause