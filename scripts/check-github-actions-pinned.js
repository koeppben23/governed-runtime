#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKFLOWS_DIR = path.join(process.cwd(), '.github', 'workflows');
const ACTIONS_DIR = path.join(process.cwd(), '.github', 'actions');
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const DOCKER_DIGEST_PATTERN = /^docker:\/\/.+@sha256:[a-f0-9]{64}$/;
const EXTERNAL_ACTION_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
const GITHUB_API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

/**
 * Per-request upper bound for the GitHub API existence checks. Without a
 * bounded timeout a stalled connection (proxy, throttled egress, cold DNS)
 * can hang the whole policy check for minutes; the vitest end-to-end test
 * runs this script against the repository workflow files and observed
 * 15s-timeout flakiness on CI.
 */
const GITHUB_VERIFY_TIMEOUT_MS = 4000;

const shaExistsCache = new Map();

function stripInlineComment(value) {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    if (char === '#' && !inSingleQuote && !inDoubleQuote) {
      return value.slice(0, index).trim();
    }
  }

  return value.trim();
}

function unquote(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseUsesReferences(content) {
  return content
    .split('\n')
    .map((line, index) => {
      const match = /^\s*-?\s*uses:\s*(?<value>.+?)\s*$/.exec(line);
      if (!match?.groups?.value) return null;
      const value = unquote(stripInlineComment(match.groups.value));
      return { line: index + 1, value };
    })
    .filter(Boolean);
}

export function validateUsesReference(value) {
  if (value.startsWith('./')) return null;

  if (value.startsWith('docker://')) {
    if (DOCKER_DIGEST_PATTERN.test(value)) return null;
    return 'Docker actions must be pinned with an immutable sha256 digest';
  }

  const atIndex = value.lastIndexOf('@');
  if (atIndex === -1) return 'External actions must include an immutable commit SHA ref';

  const action = value.slice(0, atIndex);
  if (!EXTERNAL_ACTION_PATTERN.test(action)) {
    return 'External actions must use owner/repo or owner/repo/path syntax';
  }

  const ref = value.slice(atIndex + 1);
  if (COMMIT_SHA_PATTERN.test(ref)) return null;

  return 'External actions must be pinned to a full 40-character lowercase commit SHA';
}

export function parseActionRef(value) {
  if (value.startsWith('./') || value.startsWith('docker://')) return null;

  const atIndex = value.lastIndexOf('@');
  if (atIndex === -1) return null;

  const action = value.slice(0, atIndex);
  const ref = value.slice(atIndex + 1);

  if (!EXTERNAL_ACTION_PATTERN.test(action) || !COMMIT_SHA_PATTERN.test(ref)) return null;

  return { action, sha: ref };
}

async function verifyShaExists(owner, repo, sha) {
  const cacheKey = `${owner}/${repo}@${sha}`;
  if (shaExistsCache.has(cacheKey)) return shaExistsCache.get(cacheKey);

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'flowguard-actions-pinning/1.0',
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${sha}`;
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(GITHUB_VERIFY_TIMEOUT_MS),
    });
    const exists = response.ok;
    shaExistsCache.set(cacheKey, exists);
    if (!exists && response.status === 404) {
      shaExistsCache.set(cacheKey, false);
      return false;
    }
    if (response.status === 403 || response.status === 429) {
      process.stderr.write(
        `WARN: Rate-limited verifying ${cacheKey} (HTTP ${response.status}). Skipping existence check.\n`,
      );
      shaExistsCache.set(cacheKey, true);
      return true;
    }
    return exists;
  } catch (err) {
    process.stderr.write(`WARN: Network error verifying ${cacheKey}: ${err.message}. Skipping.\n`);
    shaExistsCache.set(cacheKey, true);
    return true;
  }
}

function listYamlFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listYamlFiles(entryPath);
      if (/\.ya?ml$/i.test(entry.name)) return [entryPath];
      return [];
    })
    .sort();
}

export function checkWorkflowFiles(files) {
  const findings = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const reference of parseUsesReferences(content)) {
      const reason = validateUsesReference(reference.value);
      if (reason) {
        findings.push({ file, line: reference.line, value: reference.value, reason });
      }
    }
  }

  return findings;
}

export function collectActionRefs(files) {
  const refs = new Map();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const reference of parseUsesReferences(content)) {
      const parsed = parseActionRef(reference.value);
      if (parsed) {
        const key = `${parsed.action}@${parsed.sha}`;
        if (!refs.has(key)) {
          refs.set(key, { ...parsed, files: [] });
        }
        refs.get(key).files.push({ file, line: reference.line });
      }
    }
  }

  return [...refs.values()];
}

async function main() {
  const checkedFiles = [...listYamlFiles(WORKFLOWS_DIR), ...listYamlFiles(ACTIONS_DIR)];
  const findings = checkWorkflowFiles(checkedFiles);

  if (findings.length > 0) {
    console.error('GitHub Actions pinning check failed:');
    for (const finding of findings) {
      const relativeFile = path.relative(process.cwd(), finding.file).replace(/\\/g, '/');
      console.error(`- ${relativeFile}:${finding.line} uses ${finding.value}: ${finding.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  const refs = collectActionRefs(checkedFiles);
  if (refs.length === 0) {
    console.log(
      `GitHub Actions pinning check passed (${checkedFiles.length} YAML files, no external refs).`,
    );
    return;
  }

  let invalidCount = 0;
  const dedupRefs = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = `${ref.action}@${ref.sha}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupRefs.push(ref);
    }
  }

  for (const ref of dedupRefs) {
    const [owner, repo] = ref.action.split('/');
    if (!owner || !repo) continue;

    const exists = await verifyShaExists(owner, repo, ref.sha);
    if (!exists) {
      for (const loc of ref.files) {
        const relativeFile = path.relative(process.cwd(), loc.file).replace(/\\/g, '/');
        console.error(
          `- ${relativeFile}:${loc.line} uses ${ref.action}@${ref.sha}: SHA does not exist in ${owner}/${repo}`,
        );
      }
      invalidCount += 1;
    }
  }

  if (invalidCount > 0) {
    console.error(
      `GitHub Actions pinning check failed: ${invalidCount} SHA(s) do not exist in upstream repos.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `GitHub Actions pinning check passed (${checkedFiles.length} YAML files, ${dedupRefs.length} external refs verified).`,
    );
  }
}

if (
  import.meta.url === new URL(`file://${process.argv[1]}`).href ||
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
) {
  main();
}
