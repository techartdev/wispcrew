# Run a shell script on the VPS.
#
# PowerShell mangles inline shell one-liners containing quotes, parentheses,
# backticks or JavaScript — this has cost time repeatedly in this project, and
# the failure looks like a remote error rather than a local quoting problem.
#
# So: write the script to a file with the file tool, then run it here.
#
#   ./scripts/vps.ps1 path/to/script.sh
#   ./scripts/vps.ps1 path/to/script.sh -Env @{ WISPCREW_KEY = $key }
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [hashtable]$Env = @{},
  # Not `$Host`: PowerShell reserves that name and assigning to it fails with
  # "Cannot overwrite variable Host because it is read-only or constant."
  [string]$Target = 'root@49.13.19.149'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Script)) { throw "No such script: $Script" }

$remote = "/tmp/_run-$(Get-Random).sh"

# Copied with UNIX line endings, always.
#
# A script written on Windows carries CRLF, and `sh` treats the carriage
# return as part of the last word on every line. That is invisible in an
# editor and produces failures that look like anything but line endings:
# a model name stored as "nvidia/nemotron-3-nano-30b-a3b\r" made every
# request 404 while displaying correctly, and `ask Remote` answered "No
# agent called Remote" for an agent plainly in the list.
$unix = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($unix, ((Get-Content $Script -Raw) -replace "`r`n", "`n"))

scp -q $unix "${Target}:${remote}"
Remove-Item $unix -Force

# Environment values are passed as assignments before the command rather than
# interpolated into the script, so a key never lands in a file on the remote
# machine or in its shell history.
$prefix = ($Env.GetEnumerator() | ForEach-Object { "$($_.Key)='$($_.Value)'" }) -join ' '
$command = if ($prefix) { "$prefix sh $remote; rm -f $remote" } else { "sh $remote; rm -f $remote" }

ssh $Target $command
