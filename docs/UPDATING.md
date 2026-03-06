# DRT Server — Auto-Update System

## Overview

The DRT Server executable includes a built-in auto-update system that checks
GitHub Releases for newer versions and can update itself in-place on Windows.

---

## How Releases Are Created

1. **Bump the version** in `backend/package.json` (e.g. `"version": "1.2.3"`).
2. **Commit and tag:**
   ```bash
   git add backend/package.json
   git commit -m "release: v1.2.3"
   git tag v1.2.3
   git push origin main --tags
   ```
3. **GitHub Actions** automatically:
   - builds the Windows server executable (`DRT Server.exe`)
   - computes its SHA-256 checksum (`DRT Server.exe.sha256`)
   - creates a GitHub Release with both files attached

The release workflow is defined in `.github/workflows/release.yml`.

---

## What the Server Does on Update

### Startup check
On every launch (if running as a compiled `.exe`), the server:

1. Reads the **last update-check timestamp** from `update-state.json`
   (stored next to the executable).
2. If fewer than **24 hours** have passed, the check is skipped.
3. Otherwise it queries the GitHub API:
   ```
   GET https://api.github.com/repos/<OWNER>/<REPO>/releases/latest
   ```
4. Compares the release tag (semver) against the current embedded version.
5. If a newer version exists, prints a prompt:
   ```
   Update available (current v1.0.0 → latest v1.2.3)
   Install update and restart now? [Y/n]
   ```
6. If the user accepts:
   - Downloads the new `.exe` and `.sha256` checksum to `%TEMP%\drt-update\<version>\`
   - **Verifies SHA-256** — aborts loudly on mismatch
   - Copies its own executable to `%TEMP%\drt-update-helper.exe`
   - Spawns the helper copy with `--apply-update` flags
   - Exits (releasing the file lock on the running exe)
7. The **helper process**:
   - Waits for the original exe to be unlocked (up to 30 s)
   - Renames the original to `DRT Server.exe.old` (backup)
   - Copies the verified new exe into the original path
   - Re-launches the updated server with the original arguments
   - Exits

### If something goes wrong
- If the copy/rename fails, the helper **restores the backup** automatically.
- If the server crashes after update, manually rename `DRT Server.exe.old`
  back to `DRT Server.exe`.

---

## Where State Is Stored

| File | Location | Purpose |
|---|---|---|
| `update-state.json` | Next to the exe (`BASE_DIR`) | Last update-check timestamp |
| `DRT Server.exe.old` | Next to the exe | Backup of previous version (after update) |
| `%TEMP%\drt-update\` | Windows temp | Downloaded update files (auto-cleaned) |
| `%TEMP%\drt-update-helper.exe` | Windows temp | Temporary copy used during swap |

---

## CLI Flags

| Flag | Effect |
|---|---|
| `--no-update` | Skip update check entirely |
| `--check-updates` | Force an update check (ignore 24-hour cooldown) |
| `--version` / `-v` | Print version and exit |

**Examples:**
```bash
# Normal startup with auto-update
"DRT Server.exe"

# Disable auto-update
"DRT Server.exe" --no-update

# Force check right now
"DRT Server.exe" --check-updates
```

---

## How to Disable Auto-Updates

- **Per-launch:** add `--no-update` to your startup command or shortcut.
- **Permanently via shortcut:** edit the Windows shortcut Target to include
  `--no-update` after the exe path.

---

## Security Notes

1. **GitHub-only downloads** — The updater only accepts URLs from
   `github.com`, `api.github.com`, and `*.githubusercontent.com`.
   Non-GitHub URLs are rejected immediately.

2. **SHA-256 verification** — Every downloaded exe is verified against the
   `.sha256` checksum file attached to the release. On mismatch the update
   is aborted and the user is warned.

3. **No silent privilege escalation** — If the exe is in a protected folder
   (e.g. `C:\Program Files`), the updater prints a message asking to re-run
   as Administrator. It never attempts UAC elevation silently.

4. **No arbitrary code execution** — The updater only downloads assets from
   a specific GitHub release and only replaces the server executable.

5. **Backup always kept** — The previous exe is renamed to `.old` before
   the new one is placed, so you can always roll back manually.

---

## Configuration

The GitHub repository owner and name are constants at the top of
`backend/updater.js`:

```js
const GITHUB_OWNER = 'izman1234';
const GITHUB_REPO  = 'drt_backend';
```

**You must update these** before the auto-update feature will work.

---

## Manual Testing Checklist

### Release pipeline
- [ ] Bump version in `backend/package.json`
- [ ] Commit, tag (`git tag v0.0.1-test`), and push to GitHub
- [ ] Verify GitHub Actions workflow runs successfully
- [ ] Verify the Release page has `DRT Server.exe` and `DRT Server.exe.sha256`
- [ ] Download the `.sha256` file and verify the hash matches:
      `Get-FileHash "DRT Server.exe" -Algorithm SHA256`

### Update check
- [ ] Build the exe locally with a lower version (`"version": "0.0.1"`)
- [ ] Create a GitHub release with a higher version tag
- [ ] Run the exe — should show "Update available" prompt after ~3 seconds
- [ ] Declining with `n` should continue server normally
- [ ] Deleting `update-state.json` and restarting triggers a fresh check
- [ ] `--no-update` flag suppresses the check entirely
- [ ] `--check-updates` flag bypasses the 24-hour cooldown
- [ ] `--version` prints version and exits

### Update apply
- [ ] Accept the update prompt with `Y`
- [ ] Verify download progress is shown
- [ ] Verify SHA-256 verification passes
- [ ] Verify the server restarts with the new version
- [ ] Verify `DRT Server.exe.old` exists as backup
- [ ] Verify the server works normally after update

### Error handling
- [ ] Disconnect network → update check fails gracefully, server runs
- [ ] Tamper with the `.sha256` asset → update aborts with mismatch warning
- [ ] Place exe in read-only folder → "elevated permissions" message shown
- [ ] Non-interactive (piped stdin) → update prompt is auto-skipped

---

## Troubleshooting

**"Update check failed"** — Network issue or GitHub API rate limit.
The server continues running. Try again later or use `--check-updates`.

**"SHA-256 MISMATCH"** — The downloaded file doesn't match the checksum.
Could be a corrupt download or a tampered release. Re-try or download manually
from the GitHub Releases page.

**"Update requires elevated permissions"** — The exe is in a protected
directory. Either move it to a writable location or run the exe as Administrator.

**Server won't start after update** — Rename `DRT Server.exe.old` to
`DRT Server.exe` to restore the previous version.
