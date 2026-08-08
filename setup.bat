@echo off
title Arcana 初始化
echo ================================
echo   Arcana 初始化设置
echo ================================
echo.
cd /d "%~dp0"
call npm run setup
echo.
pause
