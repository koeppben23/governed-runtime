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

function isAuditReport(report) {
  return (
    report !== null &&
    typeof report === 'object' &&
    report.vulnerabilities !== null &&
    typeof report.vulnerabilities === 'object' &&
    !Array.isArray(report.vulnerabilities)
  );
}

/**
 * A critical finding is never covered by the exception, even when its `via`
 * entry is only a dependency string rather than an advisory object.
 */
function criticalFindings(report) {
  const findings = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (vulnerability.severity === 'critical') {
      findings.push({
        name,
        severity: 'critical',
        title: `critical vulnerability entry: ${name}`,
      });
    }
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'object' && via !== null && via.severity === 'critical') {
        findings.push({
          name,
          severity: 'critical',
          title: via.title,
          url: via.url,
          range: via.range,
        });
      }
    }
  }
  return findings;
}

/**
 * Follow `via` dependency strings to the high/critical advisory objects that
 * make a vulnerability high. A high entry with no such path is unattributable.
 */
function reachableAdvisoryUrls(name, vulnerabilities, seen = new Set()) {
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || seen.has(name)) return new Set();
  seen.add(name);

  const urls = new Set();
  for (const via of vulnerability.via ?? []) {
    if (typeof via === 'string') {
      for (const url of reachableAdvisoryUrls(via, vulnerabilities, seen)) {
        urls.add(url);
      }
      continue;
    }
    if (
      via !== null &&
      typeof via === 'object' &&
      SEVERITIES.has(via.severity) &&
      typeof via.url === 'string'
    ) {
      urls.add(via.url);
    }
  }
  return urls;
}

/**
 * Evaluate an `npm audit --json` report against the exception list.
 * Returns a result instead of exiting so the policy is unit-testable.
 */
export function evaluateAudit(report, { now = new Date(), exceptions = AUDIT_EXCEPTIONS } = {}) {
  if (!isAuditReport(report)) {
    return {
      ok: false,
      code: 'AUDIT_INVALID_REPORT',
      message: 'npm audit did not return a report with a vulnerabilities object.',
      advisories: [],
    };
  }

  const critical = criticalFindings(report);
  if (critical.length > 0) {
    return {
      ok: false,
      code: 'AUDIT_CRITICAL',
      message: 'Critical advisories are never covered by an exception.',
      advisories: critical,
    };
  }

  const highEntries = Object.entries(report.vulnerabilities).filter(
    ([, vulnerability]) => vulnerability.severity === 'high',
  );
  if (highEntries.length === 0) {
    return { ok: true, code: 'AUDIT_CLEAN', advisories: [] };
  }

  const reachableByEntry = highEntries.map(([name]) => ({
    name,
    urls: reachableAdvisoryUrls(name, report.vulnerabilities),
  }));
  const unattributable = reachableByEntry.filter(({ urls }) => urls.size === 0);
  if (unattributable.length > 0) {
    return {
      ok: false,
      code: 'AUDIT_HIGH_UNATTRIBUTABLE',
      message: 'A high vulnerability is not traceable to any high/critical advisory.',
      advisories: unattributable.map(({ name }) => ({
        name,
        severity: 'high',
        title: `high vulnerability without an advisory path: ${name}`,
      })),
    };
  }

  const active = exceptions
    .map((exception) => ({ exception, expiry: exceptionExpiry(exception) }))
    .filter(({ expiry }) => expiry !== null && now <= expiry);

  const used = active.find(({ exception }) =>
    reachableByEntry.every(({ urls }) => urls.size === 1 && urls.has(exception.url)),
  );

  if (!used) {
    const allUrls = new Set(reachableByEntry.flatMap(({ urls }) => [...urls]));
    const matching = active.find(({ exception }) => allUrls.has(exception.url));
    if (!matching) {
      return {
        ok: false,
        code: 'AUDIT_UNEXCEPTED_HIGH',
        message: 'High advisories are present without an active matching exception.',
        advisories: reachableByEntry.flatMap(({ name, urls }) =>
          [...urls].map((url) => ({ name, severity: 'high', url })),
        ),
      };
    }
    return {
      ok: false,
      code: 'AUDIT_UNEXCEPTED_ADVISORY',
      message: 'A high advisory outside the active exception was reported.',
      advisories: reachableByEntry
        .filter(({ urls }) => urls.size !== 1 || !urls.has(matching.exception.url))
        .flatMap(({ name, urls }) => [...urls].map((url) => ({ name, severity: 'high', url }))),
    };
  }

  return {
    ok: true,
    code: 'AUDIT_EXCEPTION_APPLIED',
    exception: used.exception,
    advisories: reachableByEntry.flatMap(({ name, urls }) =>
      [...urls].map((url) => ({ name, severity: 'high', url })),
    ),
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
