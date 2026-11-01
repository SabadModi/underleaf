@echo off
rem underleaf [project-folder | file.tex | file.md] [--keep] [--no-open] [--port N]
rem Opens a local Overleaf-style editor for the project (defaults to the current folder).
setlocal
set "NODE=%UNDERLEAF_NODE%"
if "%NODE%"=="" set "NODE=node"
if not exist "%~dp0..\public\assets\main.js" (
  pushd "%~dp0.."
  "%NODE%" build.mjs >nul
  popd
)
"%NODE%" "%~dp0..\server.js" %*
