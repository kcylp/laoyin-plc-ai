'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const runtimeExe = path.join(root, 'engine', 'tia-mcp', 'runtime', 'v21', 'TiaMcpServer.exe');
const siemensBase = path.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'Siemens', 'Automation', 'Portal V21', 'PublicAPI', 'V21', 'net48',
    'Siemens.Engineering.Base.dll');

function psQuote(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${script}`], {
        encoding: 'utf8',
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

test('V21 resolver reports every attempted Siemens assembly directory', () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-v21-resolver-'));
    try {
        const output = runPowerShell(`
$asm = [Reflection.Assembly]::LoadFrom(${psQuote(runtimeExe)})
$type = $asm.GetType('TiaMcpServer.Siemens.Engineering', $true)
$type.GetProperty('TiaMajorVersion').SetValue($null, 21)
$type.GetProperty('TiaPortalLocationOverride').SetValue($null, ${psQuote(fakeRoot)})
$args = [ResolveEventArgs]::new('Siemens.Engineering.WinCCUnified, Version=21.0.0.0, Culture=neutral, PublicKeyToken=null')
try {
  $type.GetMethod('Resolver').Invoke($null, @($null, $args)) | Out-Null
  throw 'resolver unexpectedly succeeded'
} catch {
  $caught = $_.Exception
  while ($null -ne $caught.InnerException) { $caught = $caught.InnerException }
  $caught.Message
}
`);
        const expected = [
            path.join(fakeRoot, 'PublicAPI', 'V21'),
            path.join(fakeRoot, 'PublicAPI', 'V21', 'WinCCUnified'),
            path.join(fakeRoot, 'Bin', 'PublicAPI'),
            path.join(fakeRoot, 'Bin'),
        ];
        for (const directory of expected) assert.match(output, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('engineering exception formatter preserves line number and UID detail messages', { skip: !fs.existsSync(siemensBase) }, () => {
    const output = runPowerShell(`
$base = [Reflection.Assembly]::LoadFrom(${psQuote(siemensBase)})
$asm = [Reflection.Assembly]::LoadFrom(${psQuote(runtimeExe)})
$messageType = $base.GetType('Siemens.Engineering.ExceptionMessageData', $true)
$exceptionType = $base.GetType('Siemens.Engineering.EngineeringTargetInvocationException', $true)
$messageCtor = $messageType.GetConstructors([Reflection.BindingFlags]'Public,NonPublic,Instance') |
  Where-Object {
    $parameters = $_.GetParameters()
    $parameters.Count -eq 3 -and
      $parameters[0].ParameterType -eq [string] -and
      $parameters[1].ParameterType -eq [int] -and
      $parameters[2].ParameterType -eq [int]
  } | Select-Object -First 1
$main = $messageCtor.Invoke([object[]]@('Invalid XML document', [int]0, [int]0))
$details = [Array]::CreateInstance($messageType, 2)
$details.SetValue($messageCtor.Invoke([object[]]@('at line number 12 position 8', [int]0, [int]0)), 0)
$details.SetValue($messageCtor.Invoke([object[]]@('at the object with UID 26', [int]0, [int]0)), 1)
$exceptionCtor = $exceptionType.GetConstructors([Reflection.BindingFlags]'Public,NonPublic,Instance') |
  Where-Object {
    $parameters = $_.GetParameters()
    $parameters.Count -eq 3 -and
      $parameters[0].ParameterType -eq $messageType -and
      $parameters[1].ParameterType -eq $details.GetType() -and
      $parameters[2].ParameterType -eq [byte[]]
  } | Select-Object -First 1
$constructorArgs = [object[]]::new(3)
$constructorArgs[0] = $main
$constructorArgs[1] = $details
$constructorArgs[2] = [byte[]]@()
$ex = $exceptionCtor.Invoke($constructorArgs)
$type = $asm.GetType('TiaMcpServer.ModelContextProtocol.McpErrorDetail', $true)
$type.GetMethod('Format').Invoke($null, @($ex))
`);
    assert.match(output, /Invalid XML document/);
    assert.match(output, /line number 12 position 8/);
    assert.match(output, /object with UID 26/);
});

test('compiled startup and status paths use only read-only Openness group checks', () => {
    const output = runPowerShell(`
$apiDir = Split-Path -Parent ${psQuote(siemensBase)}
Get-ChildItem -LiteralPath $apiDir -Filter '*.dll' | ForEach-Object {
  try { [Reflection.Assembly]::LoadFrom($_.FullName) | Out-Null } catch { }
}
$asm = [Reflection.Assembly]::LoadFrom(${psQuote(runtimeExe)})
$calls = [Collections.Generic.List[string]]::new()
$typePatterns = @(
  'TiaMcpServer.Program+<Main>d__*',
  'TiaMcpServer.ModelContextProtocol.McpServer+<Bootstrap>d__*',
  'TiaMcpServer.ModelContextProtocol.McpServer+<Doctor>d__*',
  'TiaMcpServer.ModelContextProtocol.McpServer+<EnsureOpennessUserGroup>d__*',
  'TiaMcpServer.ModelContextProtocol.McpServer+<RunCapabilitySelfTest>d__*'
)
$types = $asm.GetTypes() | Where-Object {
  $fullName = $_.FullName
  ($typePatterns | Where-Object { $fullName -like $_ }).Count -gt 0
}
foreach ($type in $types) {
  $methods = $type.GetMethods([Reflection.BindingFlags]'Public,NonPublic,Static,Instance,DeclaredOnly')
  foreach ($method in $methods) {
    $body = $method.GetMethodBody()
    if ($null -eq $body) { continue }
    $bytes = $body.GetILAsByteArray()
    for ($i = 0; $i -le $bytes.Length - 5; $i++) {
      if ($bytes[$i] -ne 0x28 -and $bytes[$i] -ne 0x6f) { continue }
      $token = [BitConverter]::ToInt32($bytes, $i + 1)
      try {
        $target = $method.Module.ResolveMethod($token)
        if ($target.DeclaringType.FullName -eq 'TiaMcpServer.Siemens.Openness') {
          $calls.Add($type.FullName + '::' + $method.Name + '->' + $target.Name)
        }
      } catch { }
    }
  }
}
$calls -join "\n"
`);
    const calls = output.split(/\r?\n/).filter(Boolean);
    assert.ok(calls.filter((line) => line.endsWith('->IsUserInGroupNoFix')).length >= 5, output);
    assert.equal(calls.some((line) => line.endsWith('->IsUserInGroup')), false, output);
});

test('existing recovery hint semantics remain unchanged', () => {
    const output = runPowerShell(`
$apiDir = Split-Path -Parent ${psQuote(siemensBase)}
Get-ChildItem -LiteralPath $apiDir -Filter '*.dll' | ForEach-Object {
  try { [Reflection.Assembly]::LoadFrom($_.FullName) | Out-Null } catch { }
}
$asm = [Reflection.Assembly]::LoadFrom(${psQuote(runtimeExe)})
$type = $asm.GetType('TiaMcpServer.ModelContextProtocol.McpHints', $true)
$type.GetMethod('Recovery').Invoke($null, @([Exception]::new('TIA Portal is not connected')))
`);
    assert.match(output, /RECOVERY: call Connect first \(the server also auto-connects when a TIA Portal is already running\)\./);
});
