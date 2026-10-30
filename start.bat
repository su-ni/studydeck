@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 研学台 StudyDeck
rem 双击启动时才自动开浏览器；后台/自动化起服务不设这一行，就不会弹窗打断人。
set SD_OPEN_BROWSER=1
echo.
echo   研学台 · 正在启动本机服务（127.0.0.1:8770）
echo   关掉这个黑窗口 = 关掉服务
echo.
"F:\Python\Python 3.13\python.exe" -m server.main
pause
