# Agent Notes

## Restart OpenSessionViewer

Use these commands from the repo root to rebuild, stop the current
local server on port 3456, and restart.

### Step 1: Build

```bash
npm run build
```

### Step 2: Find and stop the running server

```bash
netstat -ano | grep :3456
# Note the PID from the output, then on Windows:
pwsh -C 'taskkill /F /PID <PID>'
```

### Step 3: Start the server in background

```bash
node dist/bin/cli.js > app.log 2>&1 &
```

### Verify

```bash
netstat -ano | grep :3456
```

The server should now be running on port 3456.

## Repeatable E2E QA

Use these commands after the restart above. The QA command runs `agent-browser`
against the live server and checks dashboard/search/stats/detail/context/flow/
CodeAgent-unavailable flows.

```powershell
$env:OPENSESSIONVIEWER_QA_BASE_URL = 'http://127.0.0.1:3456'
$env:OPENSESSIONVIEWER_QA_SESSION_ID = 'ses_1ddf03616ffeTE5c6cbpUPMY3n'
npm run qa:e2e
```

The script uses a workspace-local npm cache at `tmp\npm-cache` so it avoids the
known global npm cache permission issue when invoking `npx agent-browser`.
On Windows, `npm run qa:e2e` goes through `scripts\qa-agent-browser.cmd`, which
chooses Git Bash or Cygwin Bash explicitly. If Bash is installed somewhere else,
set `OPENSESSIONVIEWER_QA_BASH_PATH` to the full `bash.exe` path.
