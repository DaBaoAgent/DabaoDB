@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 爱优护对标视频全自动生产工厂
cd /d "%~dp0"
set "PORT=8899"

where node >nul 2>nul
if errorlevel 1 goto :missing_node

rem 已有服务则直接打开，避免重复启动。
curl.exe --silent --fail --max-time 2 "http://127.0.0.1:%PORT%/api/bootstrap" >nul 2>nul
if not errorlevel 1 goto :open

echo   正在启动本地工厂...
start "DabaoDB WebUI" /b node server.js %*
call :wait_ready
if errorlevel 1 goto :failed

:open
start "" "http://127.0.0.1:%PORT%/"
exit /b 0

:wait_ready
set /a tries=0
:wait_loop
curl.exe --silent --fail --max-time 1 "http://127.0.0.1:%PORT%/api/bootstrap" >nul 2>nul
if not errorlevel 1 exit /b 0
set /a tries+=1
if %tries% GEQ 20 exit /b 1
ping 127.0.0.1 -n 2 >nul
goto :wait_loop

:missing_node
echo.
echo   [错误] 未找到 Node.js，请先安装 Node.js（建议 22 或更高版本）。
pause
exit /b 1

:failed
echo.
echo   [服务未能启动] 请检查 Node.js 或端口 8899 是否可用。
pause
exit /b 1
