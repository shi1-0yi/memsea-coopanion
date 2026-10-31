@echo off
setlocal
rem 一键：重算记忆海并打开。把下面四行改成你自己的路径，另存为 refresh.cmd。
rem 想改回溯天数就改 DAYS。

set COO_HOME=D:\Coopanion\data\home\companion
set OWNER_QQ=
set SELF_QQ=
set DAYS=30

rem Coopanion 自带 Electron，可以当 node 用；也可以把下面这行换成 node
set ELECTRON_RUN_AS_NODE=1
set ELECTRON="D:\Coopanion\Coopanion.exe"

set HERE=%~dp0
set OUT=%HERE%..\memory-sea.html
set OPEN=1

%ELECTRON% "%HERE%build-static.mjs"
if errorlevel 1 (
  echo.
  echo build failed - see the errors above.
  pause
  exit /b 1
)
