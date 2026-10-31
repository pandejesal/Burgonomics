#Requires -Version 5.1
<#
.SYNOPSIS
  Register or remove the Burgonomics delivery-queue task for the CURRENT user.

.DESCRIPTION
  Installs one task named BurgonomicsDeliveryQueue:
    - runs as the current logged-in user (LIMITED, Interactive)
    - every 5 minutes and AtLogOn
    - MultipleInstances = IgnoreNew
    - finite ExecutionTimeLimit
    - action: "<NodePath>" "<controller dir>\controller.cjs" --once --apply
    - working directory: the controller directory

  Safety:
    - refuses to overwrite any existing task of that name that this installer
      did not create (exact node path, controller path, arguments, working
      directory, current user, Interactive logon, Limited run level)
    - -Remove only removes the exact task this installer created
    - never starts the task and never touches the opencode service
    - refuses to run inside a delivery child process

  Main installs this after review. Nothing here is auto-started.

.PARAMETER Install
  Create the task. Fails if the name is taken by a foreign task.

.PARAMETER Remove
  Remove the task, but only if it is this controller's task.

.PARAMETER Status
  Print the current registration (default action).

.PARAMETER NodePath
  Explicit node.exe path. Defaults to C:\Program Files\nodejs\node.exe.

.PARAMETER TaskName
  Task name. Defaults to BurgonomicsDeliveryQueue.
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Install')]
    [switch]$Install,

    [Parameter(ParameterSetName = 'Remove')]
    [switch]$Remove,

    [Parameter(ParameterSetName = 'Status')]
    [switch]$Status,

    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',

    [string]$TaskName = 'BurgonomicsDeliveryQueue'
)

$ErrorActionPreference = 'Stop'

if ($env:BURGONOMICS_QUEUE_CHILD -eq '1') {
    throw 'Refusing to run the task installer from a delivery child process.'
}

$ControllerDir = $PSScriptRoot
$ControllerPath = Join-Path -Path $ControllerDir -ChildPath 'controller.cjs'
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$UserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ExpectedArguments = '"{0}" --once --apply' -f $ControllerPath

function Get-AccountSid {
    param([object]$Account)
    if (-not $Account) { return $null }
    $text = [string]$Account
    if ($text -match '^S-1-5-') { return $text }   # already a SID
    try { return (New-Object System.Security.Principal.NTAccount($text)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { return $null }
}

function Get-QueueTask {
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Test-QueueTaskIsOurs {
    param([object]$Task)

    if (-not $Task) { return $false }

    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return $false }

    $action = $actions[0]
    if (([string]$action.Execute).Trim().Trim('"') -ne $NodePath) { return $false }
    if (([string]$action.Arguments).Trim() -ne $ExpectedArguments) { return $false }

    try {
        $registeredDir = (Resolve-Path -LiteralPath $action.WorkingDirectory -ErrorAction Stop).Path
        $expectedDir = (Resolve-Path -LiteralPath $ControllerDir -ErrorAction Stop).Path
    }
    catch {
        return $false
    }
    if ($registeredDir -ne $expectedDir) { return $false }

    $principal = $Task.Principal
    if (-not $principal) { return $false }
    # Windows reports the same account as "DELL" or "NILESH\DELL" depending on the API:
    # compare the SID, not the display name.
    if ((Get-AccountSid $principal.UserId) -ne $UserSid) { return $false }
    if (([string]$principal.LogonType) -ne 'Interactive') { return $false }
    if (([string]$principal.RunLevel) -ne 'Limited') { return $false }

    # Triggers and settings are part of ownership: a same-action task with a
    # different schedule or elevation setting is still somebody else's task.
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 2) { return $false }
    $logon = @($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
    $repeat = @($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })
    if ($logon.Count -ne 1 -or $repeat.Count -ne 1) { return $false }
    if ($logon[0].UserId -and ((Get-AccountSid $logon[0].UserId) -ne $UserSid)) { return $false }
    $interval = ConvertTo-TaskSpan $repeat[0].Repetition.Interval
    if (-not $interval -or $interval.TotalMinutes -ne 5) { return $false }

    $settings = $Task.Settings
    if (-not $settings) { return $false }
    if (([string]$settings.MultipleInstances) -ne 'IgnoreNew') { return $false }
    $limit = ConvertTo-TaskSpan $settings.ExecutionTimeLimit
    if (-not $limit -or $limit.TotalMinutes -ne 10) { return $false }

    return $true
}

function ConvertTo-TaskSpan {
    param([object]$Value)
    if (-not $Value) { return $null }
    try { return [System.Xml.XmlConvert]::ToTimeSpan([string]$Value) } catch { return $null }
}

function Assert-TaskSchedulerRunning {
    $service = Get-Service -Name 'Schedule' -ErrorAction SilentlyContinue
    if (-not $service) {
        throw 'Task Scheduler service (Schedule) was not found on this machine.'
    }
    if ($service.Status -ne 'Running') {
        throw "Task Scheduler service (Schedule) is $($service.Status); start it before installing the queue."
    }
}

function Show-QueueTask {
    $task = Get-QueueTask
    if (-not $task) {
        Write-Host "Task '$TaskName' is not registered."
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task       : $TaskName"
    Write-Host "State      : $($task.State)"
    Write-Host "Owner      : $($task.Principal.UserId) ($($task.Principal.LogonType), $($task.Principal.RunLevel))"
    Write-Host "Is ours    : $(Test-QueueTaskIsOurs -Task $task)"
    foreach ($action in @($task.Actions)) {
        Write-Host "Action     : $($action.Execute) $($action.Arguments)"
        Write-Host "WorkingDir : $($action.WorkingDirectory)"
    }
    foreach ($trigger in @($task.Triggers)) {
        Write-Host "Trigger    : $($trigger.CimClass.CimClassName)"
    }
    Write-Host "LastRun    : $($info.LastRunTime)  Result: $($info.LastTaskResult)"
    Write-Host "NextRun    : $($info.NextRunTime)"
}

switch ($PSCmdlet.ParameterSetName) {
    'Status' {
        Assert-TaskSchedulerRunning
        Show-QueueTask
    }

    'Install' {
        Assert-TaskSchedulerRunning

        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            throw "node.exe was not found at '$NodePath' (a file is required, not a directory). Pass -NodePath with the explicit path."
        }
        if (-not (Test-Path -LiteralPath $ControllerPath)) {
            throw "controller.cjs was not found at '$ControllerPath'."
        }

        $existing = Get-QueueTask
        if ($existing) {
            if (-not (Test-QueueTaskIsOurs -Task $existing)) {
                throw "A task named '$TaskName' already exists and was not created by this installer. Refusing to overwrite it; inspect or remove it manually."
            }
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Replaced the existing '$TaskName' registration."
        }

        $action = New-ScheduledTaskAction -Execute $NodePath -Argument $ExpectedArguments -WorkingDirectory $ControllerDir
        $repeatTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)
        $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
        $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
            -StartWhenAvailable `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries

        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $action `
            -Trigger @($repeatTrigger, $logonTrigger) `
            -Principal $principal `
            -Settings $settings `
            -Description 'Burgonomics delivery queue (run-20261020b): one-shot tick, one active item, --once --apply.' `
            | Out-Null

        Write-Host "Registered '$TaskName' for $UserId (LIMITED, Interactive)."
        Write-Host "Action: $NodePath $ExpectedArguments"
        Write-Host "The task was not started. It runs at logon and every 5 minutes while the user is logged in."
    }

    'Remove' {
        $existing = Get-QueueTask
        if (-not $existing) {
            Write-Host "Task '$TaskName' is not registered; nothing to remove."
            return
        }
        if (-not (Test-QueueTaskIsOurs -Task $existing)) {
            throw "Refusing to remove '$TaskName': it is not this controller's task."
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed '$TaskName'."
    }
}
