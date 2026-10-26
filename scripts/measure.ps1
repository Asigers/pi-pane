# Pi Pane resource measurements for Windows; runs on the local machine.
# Example: powershell -ExecutionPolicy Bypass -File scripts/measure.ps1 -Seconds 120
param([int]$Seconds = 120, [int]$Interval = 5)
$ErrorActionPreference = "Stop"
if ($Seconds -lt 10 -or $Interval -lt 1) { throw "Minimum duration 10 seconds, interval >= 1" }
$logicalCores = [Environment]::ProcessorCount
$names = @("pi-pane", "msedgewebview2")
$rows = @()
$last = @{}
for ($elapsed = 0; $elapsed -lt $Seconds; $elapsed += $Interval) {
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @("pi-pane.exe", "msedgewebview2.exe")
    })
    $all = @(Get-Process -ErrorAction SilentlyContinue)
    # WebView2 may also belong to other apps. This script provides a machine-wide
    # upper bound, not an exact Pi Pane process tree. Inspect parent PID separately.
    $samples = $all | Where-Object { $_.ProcessName -in $names }
    $memMiB = (($samples | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB)
    $cpuSeconds = (($samples | Measure-Object -Property CPU -Sum).Sum)
    $rows += [pscustomobject]@{
        AtSeconds=$elapsed
        WorkingSetMiB=[math]::Round($memMiB, 1)
        TotalCpuSeconds=[math]::Round($cpuSeconds, 3)
        Pids=($samples | Select-Object -ExpandProperty Id) -join ","
    }
    Start-Sleep -Seconds $Interval
}
$rows | Format-Table -AutoSize
Write-Host "Note: msedgewebview2 totals can include OTHER applications. For precise idle RAM, collect Pane-owned children with Process Explorer."
