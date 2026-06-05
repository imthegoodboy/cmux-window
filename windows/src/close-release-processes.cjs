const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "win32") {
  process.exit(0);
}

const releaseExe = path.resolve(__dirname, "..", "release", "win-unpacked", "cmux.exe");
const script = `
$ErrorActionPreference = "Stop"
$releaseExe = [System.IO.Path]::GetFullPath($env:CMUX_RELEASE_EXE)
$matches = @()
Get-Process -Name cmux -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ($_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $releaseExe)) {
      $matches += $_
    }
  } catch {
  }
}
foreach ($process in $matches) {
  Stop-Process -Id $process.Id -Force
}
if ($matches.Count -gt 0) {
  Write-Output ("Stopped {0} running unpacked cmux process(es)." -f $matches.Count)
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
    CMUX_RELEASE_EXE: releaseExe
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
