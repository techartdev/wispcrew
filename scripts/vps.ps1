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
scp -q $Script "${Target}:${remote}"

# Environment values are passed as assignments before the command rather than
# interpolated into the script, so a key never lands in a file on the remote
# machine or in its shell history.
$prefix = ($Env.GetEnumerator() | ForEach-Object { "$($_.Key)='$($_.Value)'" }) -join ' '
$command = if ($prefix) { "$prefix sh $remote; rm -f $remote" } else { "sh $remote; rm -f $remote" }

ssh $Target $command
