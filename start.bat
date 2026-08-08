@echo off
title Arcana
echo ================================
echo   Arcana 启动中...
echo ================================
echo.
echo 启动后打开浏览器访问: http://127.0.0.1:8787
echo 按 Ctrl+C 停止所有服务
echo.
cd /d "%~dp0"
call npm start
pause
