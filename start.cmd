@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo Aucun fichier .env detecte.
  echo Copie .env.example en .env puis ajoute AGNES_API_KEY.
  echo.
)
node server.mjs
pause
