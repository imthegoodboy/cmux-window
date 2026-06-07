const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "win32") {
  process.exit(0);
}

const releaseParent = path.resolve(__dirname, "..", "release");
const releaseRoot = path.join(releaseParent, "win-unpacked");
const script = `
$ErrorActionPreference = "Stop"
$releaseParent = [System.IO.Path]::GetFullPath($env:CMUX_RELEASE_PARENT).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$releaseRoot = [System.IO.Path]::GetFullPath($env:CMUX_RELEASE_ROOT).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$releaseParentPrefix = $releaseParent + [System.IO.Path]::DirectorySeparatorChar
if (-not $releaseRoot.StartsWith($releaseParentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean release directory outside $releaseParent"
}
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
  Get-ChildItem -Path $releaseRoot -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $filePath = $_.FullName
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        $stream = [System.IO.File]::Open($filePath, "Open", "ReadWrite", "None")
        $stream.Close()
        break
      } catch {
        Start-Sleep -Milliseconds 200
      }
    }
  }
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Remove-Item -LiteralPath $releaseRoot -Recurse -Force -ErrorAction Stop
      Write-Output "Removed stale unpacked release directory."
      break
    } catch {
      if ($attempt -eq 5) {
        throw
      }
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
}
$artifactPatterns = @(
  "cmux-*-setup.exe",
  "cmux-*-setup.exe.blockmap"
)
$artifactTargets = @()
if ([System.IO.Directory]::Exists($releaseParent)) {
  foreach ($pattern in $artifactPatterns) {
    Get-ChildItem -Path $releaseParent -File -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
      $artifactPath = [System.IO.Path]::GetFullPath($_.FullName)
      if (-not $artifactPath.StartsWith($releaseParentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove release artifact outside $releaseParent"
      }
      $artifactTargets += $_
    }
  }
}
if ($artifactTargets.Count -gt 0) {
  foreach ($artifact in $artifactTargets) {
    Remove-Item -LiteralPath $artifact.FullName -Force -ErrorAction Stop
  }
  Write-Output ("Removed {0} stale installer artifact(s)." -f $artifactTargets.Count)
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
    CMUX_RELEASE_PARENT: releaseParent,
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
