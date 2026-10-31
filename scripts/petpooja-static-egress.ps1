<#
.SYNOPSIS
    Starts, verifies, or stops the dedicated Petpooja SSH SOCKS tunnel.

.EXAMPLE
    .\scripts\petpooja-static-egress.ps1 -Action Start -VmIp 203.0.113.10
    .\scripts\petpooja-static-egress.ps1 -Action Status
    .\scripts\petpooja-static-egress.ps1 -Action Stop
#>
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Status', 'Stop')]
    [string]$Action = 'Start',

    [string]$VmIp,

    [ValidateRange(1024, 65535)]
    [int]$LocalPort = 1080,

    [string]$SshUser = 'ubuntu',

    [string]$KeyPath = (Join-Path $HOME '.ssh\burgonomics-petpooja-oracle')
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'Burgonomics\PetpoojaTunnel'
$statePath = Join-Path $stateDir 'state.json'
$configPath = Join-Path $stateDir 'config.json'
$braveProfile = Join-Path $stateDir 'brave-profile'

function Read-State {
    if (Test-Path -LiteralPath $statePath) {
        return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    return $null
}

function Test-TunnelProcess {
    param($State)
    if (-not $State -or -not $State.pid) { return $false }
    return $null -ne (Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue)
}

function Get-ProxiedIp {
    param([int]$Port)
    $result = & curl.exe -sS --fail --max-time 15 --proxy "socks5h://127.0.0.1:$Port" 'https://api.ipify.org'
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the SOCKS tunnel.' }
    return $result.Trim()
}

function Get-ProxiedSandboxStatus {
    param([int]$Port)
    $status = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 20 --proxy "socks5h://127.0.0.1:$Port" 'https://developerapi.petpooja.com/'
    if ($LASTEXITCODE -ne 0) { return 'unreachable' }
    return $status.Trim()
}

function Find-Brave {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe')
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

switch ($Action) {
    'Stop' {
        $state = Read-State
        if (Test-TunnelProcess $state) {
            Stop-Process -Id ([int]$state.pid) -Force
            Write-Host "Stopped Petpooja tunnel (PID $($state.pid))." -ForegroundColor Green
        }
        else {
            Write-Host 'Petpooja tunnel is not running.' -ForegroundColor Yellow
        }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        exit 0
    }

    'Status' {
        $state = Read-State
        if (-not (Test-TunnelProcess $state)) {
            Write-Host 'Petpooja tunnel is not running.' -ForegroundColor Yellow
            exit 1
        }
        $exitIp = Get-ProxiedIp -Port ([int]$state.localPort)
        $sandboxStatus = Get-ProxiedSandboxStatus -Port ([int]$state.localPort)
        Write-Host "Tunnel running: PID $($state.pid)" -ForegroundColor Green
        Write-Host "Fixed exit IP: $exitIp"
        Write-Host "Petpooja sandbox HTTP status: $sandboxStatus"
        exit 0
    }

    'Start' {
        $state = Read-State
        if (Test-TunnelProcess $state) {
            Write-Host 'An existing Petpooja tunnel is already running.' -ForegroundColor Yellow
            $runningPort = [int]$state.localPort
            $exitIp = Get-ProxiedIp -Port $runningPort
            $sandboxStatus = Get-ProxiedSandboxStatus -Port $runningPort
            Write-Host "Fixed exit IP: $exitIp"
            Write-Host "Petpooja sandbox HTTP status: $sandboxStatus"
            $brave = Find-Brave
            if ($brave) {
                Start-Process -FilePath $brave -ArgumentList @(
                    "--user-data-dir=$braveProfile",
                    "--proxy-server=socks5://127.0.0.1:$runningPort",
                    '--no-first-run',
                    'https://developerapi.petpooja.com/'
                )
                Write-Host 'Opened an isolated Brave window through the existing tunnel.' -ForegroundColor Green
            }
            exit $LASTEXITCODE
        }

        if (-not $VmIp -and (Test-Path -LiteralPath $configPath)) {
            $VmIp = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).vmIp
        }
        if (-not $VmIp) { throw 'VmIp is required the first time the tunnel is started.' }
        if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH private key not found: $KeyPath" }

        $sshArgs = @(
            '-N', '-D', "127.0.0.1:$LocalPort",
            '-i', $KeyPath,
            '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ServerAliveInterval=30',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'StrictHostKeyChecking=accept-new',
            "$SshUser@$VmIp"
        )
        $process = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArgs -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 4
        if ($process.HasExited) { throw "SSH tunnel exited with code $($process.ExitCode)." }

        @{
            pid = $process.Id
            vmIp = $VmIp
            localPort = $LocalPort
            startedAt = (Get-Date).ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
        @{ vmIp = $VmIp } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

        try {
            $exitIp = Get-ProxiedIp -Port $LocalPort
            $sandboxStatus = Get-ProxiedSandboxStatus -Port $LocalPort
        }
        catch {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
            throw
        }

        Write-Host "Tunnel ready. Fixed exit IP: $exitIp" -ForegroundColor Green
        Write-Host "Petpooja sandbox HTTP status: $sandboxStatus"

        $brave = Find-Brave
        if ($brave) {
            $braveArgs = @(
                "--user-data-dir=$braveProfile",
                "--proxy-server=socks5://127.0.0.1:$LocalPort",
                '--no-first-run',
                'https://developerapi.petpooja.com/'
            )
            Start-Process -FilePath $brave -ArgumentList $braveArgs
            Write-Host 'Opened an isolated Brave window through the fixed-IP tunnel.' -ForegroundColor Green
        }
        else {
            Write-Host 'Brave Browser was not found. Configure SOCKS5 127.0.0.1 manually.' -ForegroundColor Yellow
        }
    }
}
