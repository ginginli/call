@echo off
chcp 65001 > nul
title 班级喊话 · 一键诊断

echo.
echo ==============================================================
echo   班级喊话 · 一键诊断
echo   完成后生成 report.txt
echo   把 report.txt 内容复制发给运维即可
echo ==============================================================
echo.

set HERE=%~dp0
set REPORT_TXT=%HERE%report.txt

REM 清空旧报告
if exist "%REPORT_TXT%" del "%REPORT_TXT%"

echo.

echo [1/6] 收集本机信息...
echo ===== 班级喊话 · 一键诊断报告 ===== >  "%REPORT_TXT%"
echo 生成时间: %DATE% %TIME%                >> "%REPORT_TXT%"
echo 电脑名:   %COMPUTERNAME%                 >> "%REPORT_TXT%"
echo 当前用户: %USERNAME%                     >> "%REPORT_TXT%"
echo.                                           >> "%REPORT_TXT%"
echo.                                           >> "%REPORT_TXT%"
echo ===== [1/6] 本机信息 =====               >> "%REPORT_TXT%"
systeminfo 2>nul | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type" /C:"Total Physical Memory" >> "%REPORT_TXT%"
echo.                                           >> "%REPORT_TXT%"

echo [2/6] 网络连通性 ping...
echo ===== [2/6] 网络连通性 (ping) =====      >> "%REPORT_TXT%"
ping -n 4 callclass.site >> "%REPORT_TXT%" 2>&1
echo.                                           >> "%REPORT_TXT%"

echo [3/6] DNS 解析...
echo ===== [3/6] DNS 解析 (nslookup) =====    >> "%REPORT_TXT%"
nslookup callclass.site >> "%REPORT_TXT%" 2>&1
echo.                                           >> "%REPORT_TXT%"

echo [4/6] HTTPS 健康检查 (最关键)...
echo ===== [4/6] HTTPS 健康检查 =====         >> "%REPORT_TXT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri 'https://callclass.site/api/health' -UseBasicParsing -TimeoutSec 8; Write-Output ('HTTPS /api/health: OK (' + $r.StatusCode + ') ' + $r.Content) } catch { Write-Output ('HTTPS /api/health: FAIL - ' + $_.Exception.Message) }" >> "%REPORT_TXT%" 2>&1
echo.                                           >> "%REPORT_TXT%"

echo [5/6] SSL 证书信息...
echo ===== [5/6] SSL 证书 =====               >> "%REPORT_TXT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $req = [System.Net.HttpWebRequest]::Create('https://callclass.site/'); $req.Timeout = 8000; $req.GetResponse() | Out-Null; $cert = $req.ServicePoint.Certificate; Write-Output ('证书主体: ' + $cert.Subject); Write-Output ('颁发者:   ' + $cert.Issuer); Write-Output ('到期日:   ' + $cert.GetExpirationDateString()); if ($cert.GetExpirationDate() -lt (Get-Date)) { Write-Output ('已过期:   是!!请续签') } else { Write-Output ('已过期:   否') } } catch { Write-Output ('证书读取失败: ' + $_.Exception.Message) }" >> "%REPORT_TXT%" 2>&1
echo.                                           >> "%REPORT_TXT%"

echo [6/6] WebSocket (Socket.IO) 连通性...
echo ===== [6/6] WebSocket 连通性 =====       >> "%REPORT_TXT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $ws = New-Object System.Net.WebSockets.ClientWebSocket; $ct = [System.Threading.CancellationToken]::new(); $task = $ws.ConnectAsync([Uri]'wss://callclass.site/socket.io/?EIO=4&transport=websocket', $ct); $completed = $task.Wait(8000); if ($completed -and $ws.State -eq 'Open') { Write-Output ('WSS /socket.io: OK (State=' + $ws.State + ')') } else { Write-Output ('WSS /socket.io: FAIL (State=' + $ws.State + ')') }; if ($ws) { $ws.Dispose() } } catch { Write-Output ('WSS /socket.io: FAIL - ' + $_.Exception.Message) }" >> "%REPORT_TXT%" 2>&1
echo.                                           >> "%REPORT_TXT%"

REM 末尾总结: 让老师一眼看明白
echo ===== 结论 =====                          >> "%REPORT_TXT%"
findstr /C:"OK" "%REPORT_TXT%" | findstr "HTTPS WSS" >nul
if %errorlevel%==0 (
    echo   [成功] HTTPS 和 WebSocket 都通过, 教室端应该可连 >> "%REPORT_TXT%"
) else (
    echo   [失败] HTTPS 或 WebSocket 失败, 教室端无法连上服务 >> "%REPORT_TXT%"
    echo   建议: 联系网管放行 443 端口 / 检查 DNS / 续签证书 >> "%REPORT_TXT%"
)
echo.                                           >> "%REPORT_TXT%"
echo ----- 联系运维 -----                       >> "%REPORT_TXT%"
echo 把这份 report.txt 的内容截图或复制发给我。 >> "%REPORT_TXT%"

echo.
echo ==============================================================
echo   诊断完成
echo   报告: %REPORT_TXT%
echo.
echo   用记事本打开 report.txt, 截图或复制内容发给运维
echo ==============================================================
echo.

REM 自动用记事本打开报告
start notepad "%REPORT_TXT%"

pause