const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "win32") {
  process.exit(0);
}

const releaseRoot = path.resolve(__dirname, "..", "release", "win-unpacked");
const script = `
$ErrorActionPreference = "Stop"
$releaseRoot = [System.IO.Path]::GetFullPath($env:CMUX_RELEASE_ROOT).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$releaseRootPrefix = $releaseRoot + [System.IO.Path]::DirectorySeparatorChar
$targets = @()
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ($_.Path) {
      $processPath = [System.IO.Path]::GetFullPath($_.Path)
      if ($processPath.StartsWith($releaseRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $targets += $_
      }
    }
  } catch {
  }
}
foreach ($process in $targets) {
  Stop-Process -Id $process.Id -Force
}
foreach ($process in $targets) {
  try {
    Wait-Process -Id $process.Id -Timeout 8 -ErrorAction SilentlyContinue
  } catch {
  }
}
if ($targets.Count -gt 0) {
  Write-Output ("Stopped {0} running unpacked release process(es)." -f $targets.Count)
}
if ([System.IO.Directory]::Exists($releaseRoot)) {
  Get-ChildItem -Path $releaseRoot -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $exePath = $_.FullName
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        $stream = [System.IO.File]::Open($exePath, "Open", "ReadWrite", "None")
        $stream.Close()
        break
      } catch {
        Start-Sleep -Milliseconds 200
      }
    }
  }
}
exit 0
`;

const result = spawnSync("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  script
], {
  encoding: "utf8",
  env: {
    ...process.env,
    CMUX_RELEASE_ROOT: releaseRoot
  }
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(`Failed to inspect unpacked cmux processes: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status || 1);
}
