param([int]$Port = 8890)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PORT = [string]$Port
node --env-file-if-exists=.env server.mjs
