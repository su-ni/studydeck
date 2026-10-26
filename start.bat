@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 研学台 StudyDeck
echo.
echo   研学台 · 正在启动本机服务（127.0.0.1:8770）
echo   关掉这个黑窗口 = 关掉服务
echo.
"F:\Python\Python 3.13\python.exe" -m server.main
pause
