# Agent Notes

## Restart OpenSessionViewer

Use these PowerShell commands from the repo root to rebuild, stop the current
local server on port 3456, and restart against the real OpenCode database.

```powershell
cd D:\WorkSpace\OpenSession
npm run build
netstat -ano | findstr :3456
Stop-Process -Id <LISTENING_PID> -Force
$env:OPENSESSIONVIEWER_META_PATH = 'D:\WorkSpace\OpenSession\tmp\verify-meta.db'
$p = Start-Process `
  -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList @(
    'D:\WorkSpace\OpenSession\dist\bin\cli.js',
    '--db',
    'C:\Users\QQ110\.local\share\opencode\opencode.db',
    '--port',
    '3456'
  ) `
  -WorkingDirectory 'D:\WorkSpace\OpenSession' `
  -WindowStyle Hidden `
  -RedirectStandardOutput 'D:\WorkSpace\OpenSession\logs\restart-3456.out' `
  -RedirectStandardError 'D:\WorkSpace\OpenSession\logs\restart-3456.err' `
  -PassThru
$p.Id
```

Verify the restart:

```powershell
netstat -ano | findstr :3456
Get-Content D:\WorkSpace\OpenSession\logs\restart-3456.out
Get-Content D:\WorkSpace\OpenSession\logs\restart-3456.err
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3456/opencode' | Select-Object StatusCode
```

The expected startup log includes:

```text
OpenSessionViewer running at http://localhost:3456
DB: C:\Users\QQ110\.local\share\opencode\opencode.db
24 sessions, 1903 messages.
```

Nested-session smoke check:

```powershell
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3456/opencode/session/ses_1ddf03616ffeTE5c6cbpUPMY3n').Content |
  Set-Content -Path D:\WorkSpace\OpenSession\tmp\restart-page.html
Select-String -Path D:\WorkSpace\OpenSession\tmp\restart-page.html -Pattern 'subsession-container' |
  Measure-Object |
  Select-Object Count
```

The known-good count for that sample session is `35`.

## Repeatable E2E QA

Use these commands after the restart above. The QA command runs `agent-browser`
against the live server and checks dashboard/search/stats/detail/context/flow/
CodeAgent-unavailable flows.

```powershell
cd D:\WorkSpace\OpenSession
$env:OPENSESSIONVIEWER_QA_BASE_URL = 'http://127.0.0.1:3456'
$env:OPENSESSIONVIEWER_QA_SESSION_ID = 'ses_1ddf03616ffeTE5c6cbpUPMY3n'
npm run qa:e2e
```

The script uses a workspace-local npm cache at `tmp\npm-cache` so it avoids the
known global npm cache permission issue when invoking `npx agent-browser`.
On Windows, `npm run qa:e2e` goes through `scripts\qa-agent-browser.cmd`, which
chooses Git Bash or Cygwin Bash explicitly. If Bash is installed somewhere else,
set `OPENSESSIONVIEWER_QA_BASH_PATH` to the full `bash.exe` path.
