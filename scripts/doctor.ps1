param([switch]$Json)
$ErrorActionPreference = 'Stop'
$tools = [ordered]@{}
foreach ($name in @('claude','python','node','git','gh','cargo')) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  $tools[$name] = if ($cmd) { $cmd.Source } else { $null }
}
$report = [ordered]@{ platform='Windows'; architecture=$env:PROCESSOR_ARCHITECTURE; config=(Join-Path $env:USERPROFILE '.config\esprit\config.json'); tools=$tools; git_bash=(Test-Path 'C:\Program Files\Git\bin\bash.exe') }
if ($Json) { $report | ConvertTo-Json -Depth 4 } else {
  Write-Output 'Esprit beta Windows — diagnóstico de solo lectura'
  $tools.GetEnumerator() | Format-Table Name,Value -AutoSize
  Write-Output 'Para el instalador precompilado: Claude Code nativo, Git Bash y Python 3.9+ con tzdata.'
  Write-Output 'Solo para compilar: Node 22+, Rust y Visual Studio C++ Build Tools.'
  Write-Output 'Conecta Gmail/Calendar en Claude y verifica /mcp antes de activar esas fuentes.'
}
