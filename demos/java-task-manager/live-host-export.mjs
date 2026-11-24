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

/**
 * Select the next immutable attempt path. A prior export can be byte-valid,
 * correctly bound and still stale because the host session may have continued
 * after it was written, so it is never reused as the current export.
 */
function reserveCaptureTarget(evidenceDir, label, sessionId) {
  for (let attempt = 1; ; attempt += 1) {
    const prefix = attempt === 1 ? label : `${label}-attempt-${attempt}`;
    const file = path.join(evidenceDir, `${prefix}-host-${sessionId}.json`);
    const receiptFile = `${file}.receipt.json`;
    let receiptFd;
    try {
      receiptFd = fs.openSync(receiptFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      const stdoutFd = fs.openSync(file, 'wx', 0o600);
      return { file, receiptFile, attempt, stdoutFd, receiptFd };
    } catch (error) {
      fs.closeSync(receiptFd);
      fs.unlinkSync(receiptFile);
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Validate structural completeness and identity of an exported transcript.
 *
 * This proves ordered messages, unique identities, the expected
 * session/worktree/parent, and a completed final assistant answer with text.
 * It does not by itself prove which review obligation an exchange served;
 * the runner records that binding from persisted reviewer provenance, and
 * validated ReviewFindings remain the review-completion authority.
 */
export function validateHostTranscript(content, { sessionId, workspace, parentSessionId }) {
  let exported;
  try {
    exported = JSON.parse(content);
  } catch {
    throw new TranscriptCaptureError(`invalid host transcript JSON for ${sessionId}`);
  }
  if (!isObject(exported) || !isObject(exported.info) || exported.info.id !== sessionId) {
    throw new TranscriptCaptureError(`host transcript session identity mismatch for ${sessionId}`);
  }
  if (exported.info.parentID !== parentSessionId) {
    throw new TranscriptCaptureError(`host transcript parent identity mismatch for ${sessionId}`);
  }
  const directory = exported.info.location?.directory;
  if (
    typeof directory !== 'string' ||
    fs.realpathSync.native(directory) !== fs.realpathSync.native(workspace)
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
  let firstNonIdleType = null;
  let lastNonIdleType = null;
  let lastAssistantComplete = false;
  let previousCreated = -1;
  for (const message of exported.messages) {
    if (
      !isObject(message) ||
      typeof message.id !== 'string' ||
      message.id.length === 0 ||
      messageIds.has(message.id) ||
      !Number.isSafeInteger(message.time?.created) ||
      message.time.created < 0 ||
      message.time.created < previousCreated ||
      !['user', 'assistant', 'idle'].includes(message.type)
    ) {
      throw new TranscriptCaptureError(`invalid host transcript message for ${sessionId}`);
    }
    messageIds.add(message.id);
    previousCreated = message.time.created;
    if (message.type === 'idle') continue;
    firstNonIdleType ??= message.type;
    lastNonIdleType = message.type;
    if (message.type === 'user') {
      if (typeof message.text !== 'string' || message.text.trim().length === 0) {
        throw new TranscriptCaptureError(`invalid host transcript message for ${sessionId}`);
      }
      lastAssistantComplete = false;
      continue;
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      throw new TranscriptCaptureError(`invalid host transcript message for ${sessionId}`);
    }
    let assistantText = false;
    for (const part of message.content) {
      if (!isObject(part) || typeof part.type !== 'string' || part.type.length === 0) {
        throw new TranscriptCaptureError(`invalid host transcript part for ${sessionId}`);
      }
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
        assistantText = true;
      }
      if (part.id !== undefined) {
        if (typeof part.id !== 'string' || part.id.length === 0 || partIds.has(part.id)) {
          throw new TranscriptCaptureError(`invalid host transcript part for ${sessionId}`);
        }
        partIds.add(part.id);
      }
    }
    lastAssistantComplete =
      assistantText &&
      message.finish === 'stop' &&
      message.error === undefined &&
      Number.isSafeInteger(message.time.completed) &&
      message.time.completed >= message.time.created;
  }
  if (firstNonIdleType !== 'user' || lastNonIdleType !== 'assistant' || !lastAssistantComplete) {
    throw new TranscriptCaptureError(
      `host transcript lacks a complete ordered user/assistant review exchange for ${sessionId}`,
    );
  }
}

function executeExport(command, args, { workspace, env, stdoutFd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env,
      stdio: ['ignore', stdoutFd, 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

/**
 * Capture stdout directly to a file descriptor, avoiding an undrained pipe when
 * the host exits after a large write. Every call performs a fresh export to the
 * next numbered path; earlier exports stay untouched as attempt evidence. This
 * is required because a valid receipt protects byte integrity, not freshness:
 * the host session may have recorded more messages since that export. Return a
 * file only after process, JSON, structure and binding validation.
 */
export async function exportHostTranscript({
  label,
  sessionId,
  workspace,
  evidenceDir,
  configDir,
  parentSessionId,
  serverUrl = undefined,
  env = undefined,
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
  const { file, receiptFile, attempt, stdoutFd, receiptFd } = reserveCaptureTarget(
    evidenceDir,
    label,
    sessionId,
  );
  let captured = false;
  try {
    const args = [
      ...argsPrefix,
      'session',
      'export',
      ...(serverUrl ? ['--server', serverUrl] : []),
      sessionId,
    ];
    const result = await executeExport(command, args, {
      workspace,
      stdoutFd,
      timeoutMs,
      env: env ?? {
        ...process.env,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        PWD: workspace,
      },
    });
    if (result.timedOut || result.code !== 0) {
      throw new TranscriptCaptureError(
        `${label}: host transcript export failed for ${sessionId} (exit=${result.code}, timedOut=${result.timedOut})`,
      );
    }
    const content = fs.readFileSync(file);
    validateHostTranscript(content.toString('utf8'), { sessionId, workspace, parentSessionId });
    fs.writeFileSync(
      receiptFd,
      JSON.stringify(
        {
          version: 'host-transcript.v1',
          attempt,
          sha256: transcriptDigest(content),
        },
        null,
        2,
      ),
    );
    captured = true;
    return file;
  } finally {
    try {
      fs.closeSync(stdoutFd);
    } finally {
      fs.closeSync(receiptFd);
      if (!captured) fs.unlinkSync(receiptFile);
    }
  }
}
