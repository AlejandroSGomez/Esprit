param(
  [Parameter(Mandatory=$true)][string]$CandidateInstaller,
  [string]$CandidateVersion = '',
  [string]$CandidateChecksumFile = '',
  [ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$From = 'v0.4.0-beta.1'
)
# Synthetic CI runner only. Validate the candidate before making it latest.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This installer test must run on an isolated Windows Actions runner.'
}
function Assert-InstallerChecksum([string]$Installer, [string]$ChecksumFile) {
  $name = [IO.Path]::GetFileName($Installer)
  $entries = @(Get-Content $ChecksumFile | Where-Object {
    $_ -match '^[0-9a-fA-F]{64}\s+\*?(.+)$' -and $Matches[1] -ceq $name
  })
  if ($entries.Count -ne 1) { throw "Expected exactly one checksum for $name." }
  $expectedHash = ($entries[0] -split '\s+', 2)[0]
  $actualHash = (Get-FileHash $Installer -Algorithm SHA256).Hash
  if ($expectedHash -ine $actualHash) { throw "Installer checksum mismatch for $name." }
}
$candidate = (Resolve-Path $CandidateInstaller).Path
$expected = if ($CandidateVersion) { $CandidateVersion } else { (Get-Content package.json -Raw | ConvertFrom-Json).version }
if ($expected -eq $From.Substring(1)) { throw 'The upgrade candidate must differ from the previous release.' }
if ($CandidateChecksumFile) { Assert-InstallerChecksum $candidate $CandidateChecksumFile }
$previous = Join-Path $env:RUNNER_TEMP ('esprit-previous-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $previous | Out-Null
gh release download $From -R $env:GITHUB_REPOSITORY -p '*-setup.exe' -p 'SHA256SUMS.txt' -D $previous
if ($LASTEXITCODE -ne 0) { throw 'Could not download the previous public installer.' }
$old = @(Get-ChildItem $previous -Filter '*-setup.exe')
if ($old.Count -ne 1) { throw 'Expected one previous installer.' }
Assert-InstallerChecksum $old[0].FullName (Join-Path $previous 'SHA256SUMS.txt')
$installed = Start-Process $old[0].FullName -ArgumentList '/S' -Wait -PassThru
if ($installed.ExitCode -ne 0) { throw "Previous installer failed: $($installed.ExitCode)" }
$exe = Join-Path $env:LOCALAPPDATA 'Esprit\esprit.exe'
if (-not (Test-Path $exe)) { throw "Missing installation: $exe" }
$oldVersion = (Get-Item $exe).VersionInfo.ProductVersion
if ($oldVersion -ne $From.Substring(1)) { throw "Unexpected previous installation: $oldVersion; expected $From" }
@'
import json, os, sys
from pathlib import Path
workspace = Path(os.environ['USERPROFILE']) / 'Doctorado'
config = json.loads(Path('config/esprit.windows.example.json').read_text(encoding='utf-8'))
for project in config['projects']:
    (workspace / project['folder']).mkdir(parents=True, exist_ok=True)
config.update(workspace=workspace.as_posix(), source_repo=Path.cwd().as_posix())
config['modules'] = {}
config['tools'] = {'claude': Path(sys.executable).as_posix(), 'codex': None, 'gh': None, 'python3': Path(sys.executable).as_posix(), 'latexmk': None}
settings = Path(os.environ['USERPROFILE']) / '.config/esprit/config.json'
settings.parent.mkdir(parents=True, exist_ok=True)
settings.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
note = workspace / 'nota-del-usuario.md'
note.write_text('# Mi trabajo\nConservar íntegros: ñ, á, β y $x^2$.\n', encoding='utf-8')
data = Path(os.environ['APPDATA']) / 'es.asgomez.esprit'
data.mkdir(parents=True, exist_ok=True)
(data / 'upgrade-sentinel.txt').write_text('existing application data', encoding='utf-8')
'@ | python -
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare synthetic user data.' }
# Establish a genuinely working old installation, not only an old executable.
& $exe --check-config
if ($LASTEXITCODE -ne 0) { throw 'Synthetic configuration is not compatible with the previous release.' }
$files = @("$env:USERPROFILE\.config\esprit\config.json", "$env:USERPROFILE\Doctorado\nota-del-usuario.md", "$env:APPDATA\es.asgomez.esprit\upgrade-sentinel.txt")
$before = @{}
foreach ($file in $files) { $before[$file] = (Get-FileHash $file -Algorithm SHA256).Hash }
$updated = Start-Process $candidate -ArgumentList '/S' -Wait -PassThru
if ($updated.ExitCode -ne 0) { throw "Candidate installer failed: $($updated.ExitCode)" }
$version = (Get-Item $exe).VersionInfo.ProductVersion
# Tauri embeds the complete semver in ProductVersion, including beta suffixes.
if ($version -ne $expected) { throw "Unexpected version: $version; expected $expected" }
foreach ($file in $files) {
  if ($before[$file] -ne (Get-FileHash $file -Algorithm SHA256).Hash) { throw "User file changed during upgrade: $file" }
}
python scripts/check_config.py "$env:USERPROFILE\.config\esprit\config.json"
if ($LASTEXITCODE -ne 0) { throw 'Updated configuration failed validation.' }
& $exe --check-config
if ($LASTEXITCODE -ne 0) { throw 'Installed candidate failed --check-config.' }
python scripts/smoke_config.py $exe
if ($LASTEXITCODE -ne 0) { throw 'Installed candidate failed configuration smoke tests.' }
"PASS: upgraded $From to $expected; configuration, workspace document and application data unchanged."
