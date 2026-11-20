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
    param(
        [AllowEmptyString()][string]$Text,
        [ValidateSet('connect', 'pairing')][string]$Service = 'connect'
    )

    $seen = @{}
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -notmatch ('^\s*(?<name>\S+)\s+_adb-tls-' + $Service + '\._tcp(?:\.local)?\.?\s+(?<address>\S+)\s*$')) { continue }
        $name = $Matches.name.TrimEnd('.')
        $address = $Matches.address.TrimEnd('.')
        if (-not (Test-AdbEndpoint $address)) { continue }
        if ($seen.ContainsKey($address)) { continue }
        $serial = $null
        # The random suffix belongs to the service instance, not ro.serialno.
        if ($name -match '^adb-(?<serial>.+)-[^-]+$') { $serial = $Matches.serial }
        $seen[$address] = $true
        [pscustomobject]@{ Name = $name; Serial = $serial; Address = $address }
    }
}

function Test-AdbEndpoint {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Address)
    if ($Address -notmatch '^(?<host>\[[0-9a-fA-F:%._-]+\]|[0-9.]+):(?<port>\d+)$') { return $false }
    $port = 0
    $parsedAddress = $null
    return ([int]::TryParse($Matches.port, [ref]$port) -and $port -ge 1 -and $port -le 65535 -and
        [System.Net.IPAddress]::TryParse($Matches.host.Trim('[', ']'), [ref]$parsedAddress))
}

function Merge-PhoneCtlConfig {
    [CmdletBinding()]
    param($Config, [string]$Serial)

    # Return a copy; saving a serial must preserve scrcpyArgs and future settings.
    $merged = [ordered]@{}
    if ($null -ne $Config) {
        # In PS 5.1, ConvertFrom-Json wraps even scalars/arrays in PSObject, making
        # '-is [pscustomobject]' too permissive. Check the underlying CLR type.
        if ($Config.GetType() -ne [System.Management.Automation.PSCustomObject]) { throw 'Expected a JSON object.' }
        foreach ($property in $Config.PSObject.Properties) { $merged[$property.Name] = $property.Value }
    }
    if ($PSBoundParameters.ContainsKey('Serial')) { $merged['serial'] = $Serial }
    if ($merged.Contains('serial')) {
        if ($merged['serial'] -isnot [string] -or [string]::IsNullOrWhiteSpace($merged['serial'])) {
            throw 'Expected a non-empty string property: serial'
        }
        $merged['serial'] = $merged['serial'].Trim()
    }
    if ($merged.Contains('scrcpyArgs')) {
        if ($merged['scrcpyArgs'] -isnot [array]) { throw 'Expected an array property: scrcpyArgs' }
        foreach ($argument in $merged['scrcpyArgs']) {
            if ($argument -isnot [string]) { throw 'scrcpyArgs must contain only strings.' }
        }
    }
    return [pscustomobject]$merged
}

function Merge-PhoneCtlScrcpyArgs {
    [CmdletBinding()]
    param($Config, [string[]]$ScrcpyArgs = @())
    $validated = Merge-PhoneCtlConfig -Config $Config
    if (@($validated.PSObject.Properties | Where-Object Name -eq 'scrcpyArgs').Count -gt 0) { $validated.scrcpyArgs }
    $ScrcpyArgs
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

Export-ModuleMember -Function ConvertFrom-AdbDevices, ConvertFrom-AdbMdnsServices, Select-AdbMdnsCandidates, Get-UniqueAdbPhones, Test-AdbServerPushRequired, ConvertTo-WindowsCommandLineArgument, Test-AdbEndpoint, Merge-PhoneCtlConfig, Merge-PhoneCtlScrcpyArgs
