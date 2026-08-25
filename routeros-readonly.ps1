$ErrorActionPreference = 'Stop'
$key = 'C:\Users\Vanyo Vanev\.ssh\id_rsa'
if (-not (Test-Path -LiteralPath $key)) { throw "SSH key not found: $key" }
& 'C:\Windows\System32\OpenSSH\ssh.exe' -n -i $key -o 'PubkeyAcceptedAlgorithms=+ssh-rsa' -o 'HostkeyAlgorithms=+ssh-rsa' -o 'MACs=hmac-sha1' -o 'BatchMode=yes' -o 'ConnectTimeout=10' 'papur@192.168.1.1' '/system identity print'
exit $LASTEXITCODE
