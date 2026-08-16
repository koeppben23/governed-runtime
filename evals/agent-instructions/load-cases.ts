import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EvalCaseSchema, type EvalCase } from './schema.js';

export function loadCases(casesDir: string): EvalCase[] {
  const entries = readdirSync(casesDir);
  const yamlFiles = entries.filter(
    (f) => extname(f) === '.yaml' || extname(f) === '.yml',
  );

  return yamlFiles.map((file) => {
    const raw = readFileSync(join(casesDir, file), 'utf-8');
    const parsed = parseYaml(raw);
    const result = EvalCaseSchema.safeParse(parsed);

    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(
        `Invalid eval case "${file}":\n${issues}`,
      );
    }

    return result.data;
  });
}
