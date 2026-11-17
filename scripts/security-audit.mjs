#!/usr/bin/env node
/**
 * npm audit gate with narrow, time-boxed exceptions.
 *
 * Any high/critical advisory outside the explicit exception list fails. An
 * exception expires automatically; it never becomes a blanket ignore.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIT_EXCEPTIONS = Object.freeze([
  Object.freeze({
    id: 'GHSA-fc5q-39xc-vjpf',
    url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
    expiresOn: '2026-12-17',
    reason: 'No patched picomatch release exists; npm audit suggests a breaking vitest downgrade.',
  }),
]);

const SEVERITIES = new Set(['high', 'critical']);

function exceptionExpiry(exception) {
  const expiry = new Date(`${exception.expiresOn}T23:59:59.999Z`);
  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

function highCriticalAdvisories(report) {
  const advisories = [];
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if (!SEVERITIES.has(via.severity)) continue;
      advisories.push({
        url: via.url,
        title: via.title,
        severity: via.severity,
        range: via.range,
      });
    }
  }
  return advisories;
}

function hasHighOrCriticalVulnerability(report) {
  return Object.values(report?.vulnerabilities ?? {}).some((vulnerability) =>
    SEVERITIES.has(vulnerability.severity),
  );
}

/**
 * Evaluate an `npm audit --json` report against the exception list.
 * Returns a result instead of exiting so the policy is unit-testable.
 */
export function evaluateAudit(report, { now = new Date(), exceptions = AUDIT_EXCEPTIONS } = {}) {
  if (!hasHighOrCriticalVulnerability(report)) {
    return { ok: true, code: 'AUDIT_CLEAN', advisories: [] };
  }

  const advisories = highCriticalAdvisories(report);
  if (advisories.length === 0) {
    return {
      ok: false,
      code: 'AUDIT_HIGH_WITHOUT_ADVISORY',
      message: 'High/critical vulnerabilities were reported without an identifiable advisory.',
      advisories,
    };
  }

  const critical = advisories.filter((advisory) => advisory.severity === 'critical');
  if (critical.length > 0) {
    return {
      ok: false,
      code: 'AUDIT_CRITICAL',
      message: 'Critical advisories are never covered by an exception.',
      advisories: critical,
    };
  }

  const active = exceptions
    .map((exception) => ({ exception, expiry: exceptionExpiry(exception) }))
    .filter(({ expiry }) => expiry !== null && now <= expiry);
  const used = active.find(({ exception }) =>
    advisories.some((advisory) => advisory.url === exception.url),
  );

  if (!used) {
    return {
      ok: false,
      code: 'AUDIT_UNEXCEPTED_HIGH',
      message: 'High advisories are present without an active matching exception.',
      advisories,
    };
  }

  const disallowed = advisories.filter((advisory) => advisory.url !== used.exception.url);
  if (disallowed.length > 0) {
    return {
      ok: false,
      code: 'AUDIT_UNEXCEPTED_ADVISORY',
      message: 'A high advisory outside the active exception was reported.',
      advisories: disallowed,
    };
  }

  return {
    ok: true,
    code: 'AUDIT_EXCEPTION_APPLIED',
    exception: used.exception,
    advisories,
  };
}

function main() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    console.error(`[security-audit] npm audit failed to start: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.status !== 0 && result.status !== 1) {
    console.error(
      `[security-audit] npm audit failed with exit code ${String(result.status)}; refusing to accept the result`,
    );
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('[security-audit] npm audit did not return valid JSON');
    process.exitCode = 1;
    return;
  }
  if (report?.error) {
    console.error(`[security-audit] npm audit reported an error: ${String(report.error)}`);
    process.exitCode = 1;
    return;
  }

  const evaluation = evaluateAudit(report);
  if (!evaluation.ok) {
    console.error(`[security-audit] ${evaluation.code}: ${evaluation.message}`);
    for (const advisory of evaluation.advisories) {
      console.error(`[security-audit] - ${advisory.severity}: ${advisory.title} (${advisory.url})`);
    }
    process.exitCode = 1;
    return;
  }

  if (evaluation.code === 'AUDIT_CLEAN') {
    console.log('[security-audit] no high or critical advisories');
    return;
  }

  console.log(
    `[security-audit] time-boxed exception ${evaluation.exception.id} applied until ${evaluation.exception.expiresOn}`,
  );
  console.log(`[security-audit] reason: ${evaluation.exception.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
