import { describe, expect, it } from 'vitest';
import { AUDIT_EXCEPTIONS, evaluateAudit } from '../security-audit.mjs';

const allowed = AUDIT_EXCEPTIONS[0]!;
const now = new Date('2026-11-17T00:00:00Z');
const options = { now, exceptions: [allowed] };

function reportWith(...via: unknown[]) {
  return {
    vulnerabilities: {
      sample: {
        severity: 'high',
        via,
      },
    },
  };
}

describe('security audit exception gate', () => {
  it('passes a clean audit', () => {
    expect(evaluateAudit({ vulnerabilities: {} }, options)).toMatchObject({
      ok: true,
      code: 'AUDIT_CLEAN',
    });
  });

  it('applies the documented exception to the allowed advisory and its chain', () => {
    const result = evaluateAudit(
      {
        vulnerabilities: {
          picomatch: {
            severity: 'high',
            via: [
              {
                severity: 'high',
                url: allowed.url,
                title: 'picomatch ReDoS',
                range: '<=4.0.7',
              },
            ],
          },
          fdir: { severity: 'high', via: ['picomatch'] },
        },
      },
      options,
    );

    expect(result).toMatchObject({
      ok: true,
      code: 'AUDIT_EXCEPTION_APPLIED',
      exception: { id: allowed.id },
    });
  });

  it('fails an unrelated high advisory', () => {
    expect(
      evaluateAudit(
        reportWith({
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-other',
          title: 'other',
          range: '*',
        }),
        options,
      ),
    ).toMatchObject({ ok: false, code: 'AUDIT_UNEXCEPTED_HIGH' });
  });

  it('fails when the allowed advisory is mixed with an unrelated high advisory', () => {
    expect(
      evaluateAudit(
        reportWith(
          {
            severity: 'high',
            url: allowed.url,
            title: 'allowed',
            range: '<=4.0.7',
          },
          {
            severity: 'high',
            url: 'https://github.com/advisories/GHSA-other',
            title: 'other',
            range: '*',
          },
        ),
        options,
      ),
    ).toMatchObject({ ok: false, code: 'AUDIT_UNEXCEPTED_ADVISORY' });
  });

  it('never applies an exception to a critical advisory', () => {
    expect(
      evaluateAudit(
        reportWith({
          severity: 'critical',
          url: allowed.url,
          title: 'allowed but critical',
          range: '<=4.0.7',
        }),
        options,
      ),
    ).toMatchObject({ ok: false, code: 'AUDIT_CRITICAL' });
  });

  it('fails an expired exception', () => {
    expect(
      evaluateAudit(
        reportWith({
          severity: 'high',
          url: allowed.url,
          title: 'allowed',
          range: '<=4.0.7',
        }),
        { now: new Date('2026-12-18T00:00:00Z'), exceptions: [allowed] },
      ),
    ).toMatchObject({ ok: false, code: 'AUDIT_UNEXCEPTED_HIGH' });
  });

  it('fails closed when a high vulnerability has no identifiable advisory', () => {
    expect(evaluateAudit(reportWith('dependency-chain'), options)).toMatchObject({
      ok: false,
      code: 'AUDIT_HIGH_WITHOUT_ADVISORY',
    });
  });
});
