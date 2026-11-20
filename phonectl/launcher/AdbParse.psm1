Set-StrictMode -Version 2.0

function ConvertFrom-AdbDevices {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Text)

    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^\s*(?<id>\S+)\s+(?<state>device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)') {
            [pscustomobject]@{ Id = $Matches.id; State = $Matches.state }
        }
    }
}

function ConvertFrom-AdbMdnsServices {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Text)

    $seen = @{}
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -notmatch '^\s*(?<name>\S+)\s+_adb-tls-connect\._tcp(?:\.local)?\.?\s+(?<address>\S+)\s*$') { continue }
        $name = $Matches.name.TrimEnd('.')
        $address = $Matches.address.TrimEnd('.')
        if ($address -notmatch '^(?:\[[0-9a-fA-F:%._-]+\]|[0-9.]+):(?<port>\d+)$') { continue }
        $port = 0
        if (-not [int]::TryParse($Matches.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { continue }
        if ($seen.ContainsKey($address)) { continue }
        $serial = $null
        # The random suffix belongs to the service instance, not ro.serialno.
        if ($name -match '^adb-(?<serial>.+)-[^-]+$') { $serial = $Matches.serial }
        $seen[$address] = $true
        [pscustomobject]@{ Name = $name; Serial = $serial; Address = $address }
    }
}

function Select-AdbMdnsCandidates {
    [CmdletBinding()]
    param([object[]]$Services = @(), [AllowEmptyString()][string]$Serial)

    if (-not [string]::IsNullOrWhiteSpace($Serial)) {
        $matching = @($Services | Where-Object { $_.Serial -ceq $Serial })
        if ($matching.Count -gt 0) { return $matching }
    }
    # A sole unknown service is safe to probe: getprop still verifies identity.
    if ($Services.Count -eq 1) { return $Services[0] }
}

function Get-UniqueAdbPhones {
    [CmdletBinding()]
    param([object[]]$Phones = @())

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($phone in $Phones) {
        if (-not [string]::IsNullOrWhiteSpace($phone.Serial) -and $seen.Add($phone.Serial)) { $phone }
    }
}

function Test-AdbServerPushRequired {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LocalHash, [AllowEmptyString()][string]$RemoteOutput)

    if ($RemoteOutput -match '^\s*(?<hash>[a-fA-F0-9]{64})(?:\s|$)') {
        return -not [string]::Equals($LocalHash, $Matches.hash, [System.StringComparison]::OrdinalIgnoreCase)
    }
    return $true
}

function ConvertTo-WindowsCommandLineArgument {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Value)

    # CommandLineToArgvW / C runtime quoting, including trailing backslashes.
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

Export-ModuleMember -Function ConvertFrom-AdbDevices, ConvertFrom-AdbMdnsServices, Select-AdbMdnsCandidates, Get-UniqueAdbPhones, Test-AdbServerPushRequired, ConvertTo-WindowsCommandLineArgument
