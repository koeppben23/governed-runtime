/** OpenCode transcript capture and validation for the live demo runner. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class TranscriptCaptureError extends Error {
  code = 'HOST_TRANSCRIPT_CAPTURE_FAILED';
}

function transcriptDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function captureTarget(evidenceDir, label, binding) {
  const rejectedAttempts = [];
  for (let attempt = 1; ; attempt += 1) {
    const prefix = attempt === 1 ? label : `${label}-attempt-${attempt}`;
    const file = path.join(evidenceDir, `${prefix}-host-${binding.sessionId}.json`);
    const receiptFile = `${file}.receipt.json`;
    if (!fs.existsSync(file) && !fs.existsSync(receiptFile)) {
      return { file, receiptFile, rejectedAttempts, reused: false };
    }
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      const content = fs.readFileSync(file);
      if (
        receipt.version !== 'host-transcript.v1' ||
        receipt.sha256 !== transcriptDigest(content)
      ) {
        throw new TranscriptCaptureError('transcript receipt digest or version mismatch');
      }
      validateHostTranscript(content.toString('utf8'), binding);
      return { file, receiptFile, rejectedAttempts, reused: true };
    } catch (error) {
      rejectedAttempts.push({ file: path.basename(file), reason: error.message });
    }
  }
}

/** Validate the current export envelope and every message/part identity. */
export function validateHostTranscript(content, { sessionId, workspace, parentSessionId }) {
  let exported;
  try {
    exported = JSON.parse(content);
  } catch (error) {
    throw new TranscriptCaptureError(
      `invalid host transcript JSON for ${sessionId}: ${error.message}`,
    );
  }
  if (!isObject(exported) || !isObject(exported.info) || exported.info.id !== sessionId) {
    throw new TranscriptCaptureError(`host transcript session identity mismatch for ${sessionId}`);
  }
  if (exported.info.parentID !== parentSessionId) {
    throw new TranscriptCaptureError(`host transcript parent identity mismatch for ${sessionId}`);
  }
  if (
    typeof exported.info.directory !== 'string' ||
    fs.realpathSync.native(exported.info.directory) !== fs.realpathSync.native(workspace)
  ) {
    throw new TranscriptCaptureError(`host transcript worktree mismatch for ${sessionId}`);
  }
  if (!Array.isArray(exported.messages) || exported.messages.length === 0) {
    throw new TranscriptCaptureError(
      `host transcript messages must be a non-empty array for ${sessionId}`,
    );
  }
  const messageIds = new Set();
  const partIds = new Set();
  for (const message of exported.messages) {
    const info = message?.info;
    if (
      !isObject(message) ||
      !isObject(info) ||
      typeof info.id !== 'string' ||
      info.id.length === 0 ||
      messageIds.has(info.id) ||
      info.sessionID !== sessionId ||
      !['user', 'assistant'].includes(info.role) ||
      !Array.isArray(message.parts)
    ) {
      throw new TranscriptCaptureError(`invalid host transcript message for ${sessionId}`);
    }
    messageIds.add(info.id);
    for (const part of message.parts) {
      if (
        !isObject(part) ||
        typeof part.id !== 'string' ||
        part.id.length === 0 ||
        partIds.has(part.id) ||
        typeof part.type !== 'string' ||
        part.type.length === 0 ||
        part.sessionID !== sessionId ||
        part.messageID !== info.id
      ) {
        throw new TranscriptCaptureError(`invalid host transcript part for ${sessionId}`);
      }
      partIds.add(part.id);
    }
  }
}

function executeExport(command, args, { workspace, env, stdoutFd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env,
      stdio: ['ignore', stdoutFd, 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stderr });
    });
  });
}

/**
 * Capture stdout directly to a file descriptor, avoiding an undrained pipe when
 * the host exits after a large write. Preserve failed bytes for diagnosis and
 * return a file only after process, JSON, structure and binding validation.
 */
export async function exportHostTranscript({
  label,
  sessionId,
  workspace,
  evidenceDir,
  configDir,
  parentSessionId,
  command = 'opencode',
  argsPrefix = /** @type {string[]} */ ([]),
  timeoutMs = 5 * 60_000,
}) {
  if (
    ![label, sessionId].every(
      (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value),
    )
  ) {
    throw new TranscriptCaptureError(
      'host transcript label and session ID must be safe filename components',
    );
  }
  const binding = { sessionId, workspace, parentSessionId };
  const { file, receiptFile, rejectedAttempts, reused } = captureTarget(
    evidenceDir,
    label,
    binding,
  );
  if (reused) return file;
  const stdoutFd = fs.openSync(file, 'wx');
  let result;
  try {
    result = await executeExport(command, [...argsPrefix, 'export', sessionId], {
      workspace,
      stdoutFd,
      timeoutMs,
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        PWD: workspace,
      },
    });
  } finally {
    fs.closeSync(stdoutFd);
  }
  if (result.timedOut || result.code !== 0) {
    throw new TranscriptCaptureError(
      `${label}: host transcript export failed for ${sessionId} (exit=${result.code}, timedOut=${result.timedOut}): ${result.stderr}`,
    );
  }
  validateHostTranscript(fs.readFileSync(file, 'utf8'), { sessionId, workspace, parentSessionId });
  fs.writeFileSync(
    receiptFile,
    JSON.stringify(
      {
        version: 'host-transcript.v1',
        sha256: transcriptDigest(fs.readFileSync(file)),
        rejectedAttempts,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  return file;
}
