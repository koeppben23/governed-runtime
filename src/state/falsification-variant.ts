/** Approved, exact source perturbation; never a shell command or a live edit. */
import { z } from 'zod';
import { canonicalRepoRelativePath } from '../shared/repo-path.js';

export const FalsificationVariant = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (path) => canonicalRepoRelativePath(path) === path,
        'variant path must be a canonical repository-relative path',
      ),
    before: z.string().min(1).max(100_000),
    after: z.string().max(100_000),
  })
  .strict()
  .refine((value) => value.before !== value.after, 'variant must change source bytes')
  .readonly();
export type FalsificationVariant = z.infer<typeof FalsificationVariant>;
