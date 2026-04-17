# Troubleshooting

## Common Issues

### Tools Not Discovered

**Symptom:** FlowGuard commands not available in OpenCode.

**Solution:**

```bash
# Reinstall tools
flowguard install --force

# Verify installation
flowguard doctor
```

### Session Not Found

**Symptom:** `NO_SESSION` error when running commands.

**Solution:**

```bash
# Create new session
/hydrate

# Or check if session exists
ls ~/.config/opencode/workspaces/*/sessions/
```

### Phase Not Advancing

**Symptom:** Session stuck at a phase.

**Common causes:**

1. Missing required evidence
2. Validation checks failing
3. Required human approval not given

**Solution:**

```bash
# Check current state
/review

# Try to advance
/continue
```

### Archive Verification Failed

**Symptom:** `verifyArchive()` returns findings.

**Common causes:**

1. File was modified after archiving
2. Archive is corrupted
3. Missing files in archive

**Solution:**

```bash
# Re-archive the session
# (Original session must still exist)
/archive
```

### Policy Mode Not Applied

**Symptom:** Four-eyes not enforced in regulated mode.

**Solution:**

1. Verify config has correct mode:
   ```bash
   cat ~/.config/opencode/workspaces/{fingerprint}/config.json
   ```
2. Recreate session with correct mode:
   ```bash
   /hydrate policyMode=regulated
   ```

## Error Codes

### Session Errors

| Code                       | Description       | Solution                 |
| -------------------------- | ----------------- | ------------------------ |
| `NO_SESSION`               | No session exists | Run `/hydrate` first     |
| `INVALID_STATE`            | State corrupted   | Check session-state.json |
| `SCHEMA_VALIDATION_FAILED` | State invalid     | Restore from backup      |

### Command Errors

| Code                  | Description                          | Solution                   |
| --------------------- | ------------------------------------ | -------------------------- |
| `COMMAND_NOT_ALLOWED` | Command not allowed in current phase | Check command requirements |
| `INVALID_INPUT`       | Input validation failed              | Check arguments            |
| `POLICY_VIOLATION`    | Action violates policy               | Review policy settings     |

### Archive Errors

| Code                  | Description                    | Solution                      |
| --------------------- | ------------------------------ | ----------------------------- |
| `ARCHIVE_FAILED`      | Archive creation failed        | Check disk space, permissions |
| `MANIFEST_INVALID`    | Manifest malformed             | Archive may be corrupted      |
| `VERIFICATION_FAILED` | Archive integrity check failed | Archive was modified          |

## Debug Mode

Enable verbose logging:

```json
{
  "logging": {
    "level": "debug"
  }
}
```

Or via environment:

```bash
export FLOWGUARD_LOG_LEVEL=debug
```

## Getting Help

1. Check `/flowguard_review` for session status
2. Run `flowguard doctor` for diagnostics
3. Review audit trail in `audit.jsonl`
4. Check logs in `~/.config/opencode/workspaces/*/logs/`

## Reset Session

To start fresh:

```bash
# Abort current session
/abort

# Delete session files
rm -rf ~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}
```
