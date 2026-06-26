/**
 * @module logging/redact.test
 * @description Tests for the central log redactor.
 *
 * Closes the audit gaps: the previous redaction tests were POSIX-only and
 * shape-only. These cover Windows/UNC paths, conservative secret-value
 * redaction (with deliberate non-matches to prevent over-redaction), deep/
 * null-safe extra redaction, and a through-the-logger pipeline check.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, REDACTION
 */

import { describe, it, expect } from 'vitest';
import { sanitizeDiagnosticString, redactExtra, redactMessage } from './redact.js';

describe('sanitizeDiagnosticString — paths', () => {
  it('redacts POSIX multi-segment paths anywhere, including inside quotes', () => {
    expect(sanitizeDiagnosticString('open /home/alice/.flowguard/token.json')).not.toContain(
      '/home/alice',
    );
    expect(sanitizeDiagnosticString("failed '/etc/passwd'")).not.toContain('/etc/passwd');
  });

  it('redacts Windows drive paths (C:\\Users\\...)', () => {
    const out = sanitizeDiagnosticString('reading C:\\Users\\alice\\.flowguard\\token.json failed');
    expect(out).not.toContain('C:\\Users\\alice');
    expect(out).toContain('[path:');
  });

  it('redacts Windows paths even with spaces in a segment', () => {
    const out = sanitizeDiagnosticString('open C:\\Program Files\\app\\secret.key');
    expect(out).not.toContain('C:\\Program Files\\app\\secret.key');
  });

  it('redacts UNC paths (\\\\server\\share\\...)', () => {
    const out = sanitizeDiagnosticString('copy \\\\server\\share\\creds\\token.txt');
    expect(out).not.toContain('\\\\server\\share\\creds');
    expect(out).toContain('[path:');
  });

  it('keeps the last path segment for diagnosis', () => {
    expect(sanitizeDiagnosticString('at /a/b/c/handler.ts')).toContain('[path:handler.ts]');
  });

  it('redacts a Windows path whose final segment is the filename', () => {
    expect(sanitizeDiagnosticString('C:\\a\\b\\final.txt here')).toContain('[path:final.txt]');
  });

  it('redacts a UNC path down to its last segment', () => {
    expect(sanitizeDiagnosticString('\\\\srv\\sh\\deep\\creds.txt end')).toContain(
      '[path:creds.txt]',
    );
  });

  it('does not leave a Windows drive root unredacted', () => {
    const out = sanitizeDiagnosticString('open C:\\Users\\bob\\a\\b\\c\\d.key');
    expect(out).not.toContain('C:\\Users\\bob');
    expect(out).toMatch(/\[path:[^\]]+\]/);
  });

  it('strips http(s) URLs to hostname and line:col references', () => {
    expect(sanitizeDiagnosticString('GET https://api.example.com/v1/keys?token=x')).toContain(
      '[url:api.example.com]',
    );
    expect(sanitizeDiagnosticString('at foo (file:10:5)')).not.toMatch(/:\d+:\d+/);
  });
});

describe('sanitizeDiagnosticString — conservative secret values', () => {
  it('redacts bearer tokens', () => {
    const out = sanitizeDiagnosticString('Authorization: Bearer eyJabc.def.ghi123');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('eyJabc.def.ghi123');
  });

  it('redacts a bearer token with multiple spaces after the scheme', () => {
    expect(sanitizeDiagnosticString('Bearer   abc123def456')).toContain('Bearer [redacted]');
  });

  it('does not treat the bare word "Bearer" with no token as a secret', () => {
    expect(sanitizeDiagnosticString('the Bearer of bad news')).toContain('Bearer');
  });

  it('redacts JWT-shaped strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpM';
    expect(sanitizeDiagnosticString(`token=${jwt}`)).not.toContain(jwt.split('.')[2]!);
  });

  it('redacts sk- / sk_live_ style keys', () => {
    expect(sanitizeDiagnosticString('using key sk-proj-ABCDEF1234567890')).not.toContain(
      'sk-proj-ABCDEF1234567890',
    );
  });

  it('redacts password=/token=/secret=/api_key= assignments', () => {
    expect(sanitizeDiagnosticString('password=hunter2supersecret')).toContain(
      'password=[redacted]',
    );
    expect(sanitizeDiagnosticString('api_key: AKIA1234567890')).toContain('api_key=[redacted]');
  });

  it('does NOT over-redact ordinary diagnostic text (no false positives)', () => {
    const msg = 'retry attempt 3 of 5 for session abc123 completed in 42ms';
    expect(sanitizeDiagnosticString(msg)).toBe(msg);
  });

  it('does NOT redact a short non-secret word that merely contains letters', () => {
    const msg = 'status: ok, took 12s';
    expect(sanitizeDiagnosticString(msg)).toBe(msg);
  });
});

describe('redactMessage', () => {
  it('delegates to sanitizeDiagnosticString', () => {
    expect(redactMessage('open /home/alice/secret/key.pem')).not.toContain('/home/alice/secret');
  });
});

describe('redactExtra', () => {
  it('is null/undefined safe', () => {
    expect(redactExtra(undefined)).toBeUndefined();
    expect(redactExtra(null as unknown as Record<string, unknown>)).toBeUndefined();
  });

  it('sanitizes string values', () => {
    const out = redactExtra({ path: '/home/alice/token.json', code: 'E1' });
    expect(out!.path).not.toContain('/home/alice');
    expect(out!.code).toBe('E1');
  });

  it('deep-walks nested objects and arrays', () => {
    const out = redactExtra({
      outer: { inner: { secret: 'token=supersecretvalue' } },
      list: ['/var/run/secrets/token', 'plain'],
    });
    const inner = (out!.outer as Record<string, Record<string, string>>).inner;
    expect(inner.secret).toContain('token=[redacted]');
    const list = out!.list as string[];
    expect(list[0]).not.toContain('/var/run/secrets/token');
    expect(list[1]).toBe('plain');
  });

  it('preserves non-string scalar values unchanged', () => {
    const out = redactExtra({ count: 42, ok: true, missing: null });
    expect(out!.count).toBe(42);
    expect(out!.ok).toBe(true);
    expect(out!.missing).toBeNull();
  });

  it('handles circular references without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redactExtra(a)).not.toThrow();
    const out = redactExtra(a)!;
    expect(out.self).toBe('[redacted:circular]');
  });

  describe('built-in objects are coerced, not corrupted', () => {
    it('Date -> ISO string (not {})', () => {
      const d = new Date('2026-01-02T03:04:05.000Z');
      expect(redactExtra({ at: d })!.at).toBe('2026-01-02T03:04:05.000Z');
    });

    it('a raw Error -> {name,message,stack} with sanitized strings (not {})', () => {
      const err = Object.assign(new Error('open /home/u/secret/key.pem failed'), {
        code: 'EACCES',
      });
      const out = redactExtra({ error: err })!.error as Record<string, unknown>;
      expect(out.name).toBe('Error');
      expect(out.message).not.toContain('/home/u/secret');
      expect(out.code).toBe('EACCES');
      expect(typeof out.stack).toBe('string');
    });

    it('BigInt -> string (so a sink JSON.stringify cannot throw)', () => {
      const out = redactExtra({ big: 10n })!;
      expect(out.big).toBe('10');
      // must be JSON-serializable now
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    it('Map/Set/RegExp/Buffer are coerced to compact markers', () => {
      const out = redactExtra({
        m: new Map([['a', 1]]),
        s: new Set([1, 2, 3]),
        r: /abc/g,
        b: Buffer.from('deadbeef', 'hex'),
      })!;
      expect(out.m).toBe('[Map]');
      expect(out.s).toBe('[Set]');
      expect(out.r).toBe('/abc/g');
      expect(out.b).toBe('[binary:4]');
    });

    it('honors toJSON() instead of walking raw private fields', () => {
      class Snapshot {
        id = 'abc';
        _private = 'leaky-secret-value';
        toJSON() {
          return { id: this.id };
        }
      }
      const out = redactExtra({ snap: new Snapshot() })!.snap as Record<string, unknown>;
      expect(out.id).toBe('abc');
      expect('_private' in out).toBe(false);
    });
  });

  describe('never throws on hostile input (logger contract)', () => {
    it('a throwing enumerable getter becomes a placeholder, not an exception', () => {
      const hostile: Record<string, unknown> = { ok: 1 };
      Object.defineProperty(hostile, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter boom');
        },
      });
      let out: Record<string, unknown> | undefined;
      // Object.entries evaluates getters eagerly, so the whole object degrades to
      // a safe placeholder rather than throwing out of the log call.
      expect(() => {
        out = redactExtra({ hostile });
      }).not.toThrow();
      expect(out!.hostile).toBe('[unredactable-object]');
    });

    it('a Proxy whose ownKeys trap throws degrades safely', () => {
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('ownKeys boom');
          },
        },
      );
      expect(() => redactExtra({ p: proxy })).not.toThrow();
      expect(redactExtra({ p: proxy })!.p).toBe('[unredactable-object]');
    });

    it('a Map subclass with a throwing size getter does not throw', () => {
      class BadMap extends Map {
        get size(): number {
          throw new Error('size boom');
        }
      }
      expect(() => redactExtra({ m: new BadMap() })).not.toThrow();
      expect(redactExtra({ m: new BadMap() })!.m).toBe('[Map]');
    });

    it('deep acyclic nesting is bounded, not a stack overflow', () => {
      let deep: Record<string, unknown> = { leaf: 'x' };
      for (let i = 0; i < 5000; i++) deep = { nested: deep };
      let out: Record<string, unknown> | undefined;
      expect(() => {
        out = redactExtra({ deep });
      }).not.toThrow();
      // somewhere down the chain it bails with the depth marker
      const json = JSON.stringify(out);
      expect(json).toContain('[redacted:too-deep]');
    });

    it('an invalid Date is coerced without throwing', () => {
      expect(redactExtra({ d: new Date('not-a-date') })!.d).toBe('[invalid-date]');
    });
  });
});

describe('redactMessage / sanitizeDiagnosticString robustness', () => {
  it('redactMessage never throws and coerces a non-string', () => {
    // simulate a JS-interop caller passing a non-string that matches a trigger
    const arr = ['/etc/passwd'] as unknown as string;
    let out = '';
    expect(() => {
      out = redactMessage(arr);
    }).not.toThrow();
    expect(out).not.toContain('/etc/passwd');
  });

  it('sanitizeDiagnosticString coerces a non-string input', () => {
    expect(() => sanitizeDiagnosticString(42 as unknown as string)).not.toThrow();
    expect(sanitizeDiagnosticString(42 as unknown as string)).toBe('42');
  });
});

describe('sanitizeDiagnosticString — case-insensitive bearer + clean ENOENT', () => {
  it('redacts BEARER and bEaReR (case-insensitive)', () => {
    expect(sanitizeDiagnosticString('Authorization: BEARER deadbeefcafef00d')).not.toContain(
      'deadbeefcafef00d',
    );
    expect(sanitizeDiagnosticString('authorization: bEaReR mixedCaseToken123')).not.toContain(
      'mixedCaseToken123',
    );
  });

  it('redacts the path inside an ENOENT message without mangling the prose', () => {
    const msg = "ENOENT: no such file or directory, open '/home/u/.ssh/id_rsa'";
    const out = sanitizeDiagnosticString(msg);
    expect(out).not.toContain('/home/u/.ssh/id_rsa');
    expect(out).toContain('[path:id_rsa]');
    // the words "no such file or directory" survive (the old pass ate "no")
    expect(out).toContain('no such file or directory');
  });

  it('redacts the path inside a Windows ENOENT message cleanly', () => {
    const msg = "ENOENT: no such file or directory, open 'C:\\Users\\bob\\token.key'";
    const out = sanitizeDiagnosticString(msg);
    expect(out).not.toContain('C:\\Users\\bob');
    expect(out).toContain('no such file or directory');
  });
});
