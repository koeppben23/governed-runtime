/** Frozen, additive repository-specific authority-surface mappings. */
import { z } from 'zod';
import { SpecificRiskTrigger } from './risk-trigger.js';

const RepositoryGlob = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.*\-/]+$/)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      value
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part !== '.' &&
            part !== '..' &&
            (!part.includes('**') || part === '**'),
        ),
    'Use a relative POSIX glob; ** must occupy a whole segment',
  );
export const RiskTriggerPathsSchema = z
  .array(z.object({ trigger: SpecificRiskTrigger, pattern: RepositoryGlob }).strict())
  .max(100)
  .readonly();
export type RiskTriggerPaths = z.infer<typeof RiskTriggerPathsSchema>;
