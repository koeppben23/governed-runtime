/**
 * @module integration/proofgraph/config-default-consistency.test
 * @description Config-default consistency (#762): seeded-inconsistency detection via
 * DI, plus a live guard over the real FlowGuardConfigSchema.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  evaluateConfigDefaultConsistency,
  checkConfigDefaultConsistency,
} from './config-default-consistency.js';

const V1 = { schemaVersion: 'v1' };

describe('evaluateConfigDefaultConsistency', () => {
  it('reports ok for a schema with complete, idempotent defaults', () => {
    const schema = z.object({
      schemaVersion: z.literal('v1'),
      a: z.object({ x: z.string() }).default({ x: 'y' }),
    });
    const report = evaluateConfigDefaultConsistency(schema, ['schemaVersion', 'a'], V1);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('detects a minimal config that does not normalize (required nested object, no default)', () => {
    const schema = z.object({
      schemaVersion: z.literal('v1'),
      a: z.object({ x: z.string() }),
    });
    const report = evaluateConfigDefaultConsistency(schema, ['schemaVersion', 'a'], V1);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.rule).toBe('defaults_parse');
  });

  it('detects an incomplete default (optional nested object omitted)', () => {
    const schema = z.object({
      schemaVersion: z.literal('v1'),
      a: z.object({}).optional(),
    });
    const report = evaluateConfigDefaultConsistency(schema, ['schemaVersion', 'a'], V1);
    expect(report.findings.some((f) => f.rule === 'defaults_complete')).toBe(true);
  });

  it('detects a non-idempotent default (re-parsing changes the config)', () => {
    const schema = z.object({
      schemaVersion: z.literal('v1'),
      n: z
        .number()
        .default(0)
        .transform((x) => x + 1),
    });
    const report = evaluateConfigDefaultConsistency(schema, ['schemaVersion', 'n'], V1);
    expect(report.findings.some((f) => f.rule === 'defaults_idempotent')).toBe(true);
  });
});

describe('checkConfigDefaultConsistency (live schema)', () => {
  it('the real FlowGuardConfigSchema has complete, idempotent defaults', () => {
    const report = checkConfigDefaultConsistency();
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
  });
});
