<#
.SYNOPSIS
    Watches this machine's public IP + Petpooja sandbox access, alerts on any change.

.DESCRIPTION
    - Polls public IP (ipify) on an interval.
    - Logs every IP change with a timestamp.
    - When the IP changes, copies a ready-to-send whitelist request to the clipboard
      and pops a tray notification.
    - Continuously probes https://developerapi.petpooja.com/ and alerts the moment
      the 403 clears (whitelist is live) or returns.

    No API keys, no cost. Press Ctrl+C to stop.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\petpooja-ip-watch.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\petpooja-ip-watch.ps1 -IntervalSeconds 30 -LogPath .\ip-watch.log
#>
[CmdletBinding()]
param(
    # Seconds between checks
    [int]$IntervalSeconds = 60,

    # Public IP lookup endpoint
    [string]$IpUrl = 'https://api.ipify.org',

    # Sandbox portal to probe for whitelist status
    [string]$ProbeUrl = 'https://developerapi.petpooja.com/',

    # Change log location (defaults to alongside this script)
    [string]$LogPath,

    # Show Windows tray balloon notifications (set $false on headless/CI)
    [switch]$NoNotify
)

$ErrorActionPreference = 'Stop'

if (-not $LogPath) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $LogPath = Join-Path $scriptDir 'petpooja-ip-watch.log'
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    switch ($Level) {
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        'ERROR' { Write-Host $line -ForegroundColor Red }
        default { Write-Host $line }
    }
}

function Show-Notification {
    param([string]$Title, [string]$Text)
    if ($NoNotify) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        if (-not $script:TrayIcon) {
            $script:TrayIcon = New-Object System.Windows.Forms.NotifyIcon
            $script:TrayIcon.Icon = [System.Drawing.SystemIcons]::Information
            $script:TrayIcon.Visible = $true
            $script:TrayIcon.Text = 'Petpooja IP Watch'
        }
        $script:TrayIcon.ShowBalloonTip(8000, $Title, $Text, [System.Windows.Forms.ToolTipIcon]::Info)
    }
    catch {
        # Notification is best-effort; the log is the source of truth.
        Write-Log "Notification failed: $($_.Exception.Message)" 'WARN'
    }
}

function Get-PublicIp {
    return (Invoke-WebRequest -Uri $IpUrl -UseBasicParsing -TimeoutSec 15).Content.Trim()
}

function Get-SandboxStatus {
    # Returns HTTP status code, or 0 if unreachable (network/DNS failure).
    try {
        $resp = Invoke-WebRequest -Uri $ProbeUrl -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 5
        return [int]$resp.StatusCode
    }
    catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function New-WhitelistRequest {
    param([string]$Ip, [int]$Status)
    @(
        "Hi Shivam,"
        ""
        "Our latest public IP for whitelisting: $Ip"
        ""
        "Sandbox portal $ProbeUrl currently returns HTTP $Status from this address."
        "Please whitelist the IP above (or confirm CIDR support for 103.250.137.0/24 and 43.242.116.0/24 so we stop sending updates)."
        ""
        "Account: burgonomicsind@gmail.com  |  Mapping Code (restID): 31z58ciw0h"
        "Webhook: https://api-jgxunirgwq-el.a.run.app/petpooja/webhook"
        ""
        "Thanks & Regards,",
        "Jesal Pande"
    ) -join "`r`n"
}

# --- main loop -----------------------------------------------------------------
Write-Log "Watcher started (interval=${IntervalSeconds}s, probe=$ProbeUrl, log=$LogPath)"

$lastIp = $null
$lastStatus = $null

try {
    while ($true) {
        # 1. public IP
        try {
            $ip = Get-PublicIp
        }
        catch {
            Write-Log "IP lookup failed: $($_.Exception.Message)" 'WARN'
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        if ($ip -ne $lastIp) {
            if ($null -eq $lastIp) {
                Write-Log "Baseline public IP: $ip" 'OK'
            }
            else {
                Write-Log "PUBLIC IP CHANGED: $lastIp -> $ip" 'WARN'
                $status = Get-SandboxStatus
                $draft = New-WhitelistRequest -Ip $ip -Status $status
                try {
                    Set-Clipboard -Value $draft
                    $clipNote = 'whitelist request copied to clipboard'
                }
                catch { $clipNote = 'clipboard unavailable (session not interactive)' }
                Write-Log "Sandbox probe returned HTTP $status for $ip" $(if ($status -eq 403) { 'WARN' } else { 'OK' })
                Write-Log $clipNote
                Show-Notification -Title 'Public IP changed' -Text "$lastIp -> $ip. Whitelist request copied to clipboard."
            }
            $lastIp = $ip
        }

        # 2. sandbox access
        $status = Get-SandboxStatus
        if ($status -ne $lastStatus) {
            if ($status -eq 403) {
                Write-Log "Sandbox: 403 Forbidden from $ip (not yet whitelisted)" 'WARN'
            }
            elseif ($status -eq 0) {
                Write-Log "Sandbox: unreachable (network/DNS)" 'WARN'
            }
            else {
                Write-Log "Sandbox: HTTP $status from $ip -- ACCESS RESTORED, whitelist is live!" 'OK'
                Show-Notification -Title 'Sandbox accessible' -Text "HTTP $status from $ip. Run the 5 test scenarios now."
            }
            $lastStatus = $status
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
}
finally {
    if ($script:TrayIcon) {
        $script:TrayIcon.Visible = $false
        $script:TrayIcon.Dispose()
    }
    Write-Log "Watcher stopped."
}
