@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   老殷工控PLC - 专业PLC编程AI助手
echo   正在启动服务器...
echo ============================================
echo.
echo   启动后请用浏览器打开：http://localhost:3000
echo   管理后台：http://localhost:3000/admin.html
echo.
echo   关闭本窗口即停止服务。
echo ============================================
echo.
node server.js
pause
