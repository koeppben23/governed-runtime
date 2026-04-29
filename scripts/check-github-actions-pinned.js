#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKFLOWS_DIR = path.join(process.cwd(), '.github', 'workflows');
const ACTIONS_DIR = path.join(process.cwd(), '.github', 'actions');
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const DOCKER_DIGEST_PATTERN = /^docker:\/\/.+@sha256:[a-f0-9]{64}$/;
const EXTERNAL_ACTION_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

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

function main() {
  const checkedFiles = [...listYamlFiles(WORKFLOWS_DIR), ...listYamlFiles(ACTIONS_DIR)];
  const findings = checkWorkflowFiles(checkedFiles);

  if (findings.length === 0) {
    console.log(`GitHub Actions pinning check passed (${checkedFiles.length} YAML files).`);
    return;
  }

  console.error('GitHub Actions pinning check failed:');
  for (const finding of findings) {
    const relativeFile = path.relative(process.cwd(), finding.file);
    console.error(`- ${relativeFile}:${finding.line} uses ${finding.value}: ${finding.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
