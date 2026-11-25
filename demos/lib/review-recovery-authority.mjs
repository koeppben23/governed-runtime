/** Read the installed product's review contract; the demo owns no review schema. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DemoNotVerifiedError } from './results.mjs';

export function reviewInvocationValidator(schema, hasValidStructuredInvocationContract) {
  if (
    typeof schema?.safeParse !== 'function' ||
    typeof hasValidStructuredInvocationContract !== 'function'
  ) {
    throw new DemoNotVerifiedError('installed product does not expose its V2 review contract');
  }
  return ({ obligation, invocation, parentSessionId }) => {
    const parsed = schema.safeParse(invocation);
    return (
      parsed.success &&
      hasValidStructuredInvocationContract({ obligation, invocation: parsed.data, parentSessionId })
    );
  };
}

export async function loadInstalledReviewInvocationValidator(workspace) {
  const dist = path.join(workspace, '.opencode', 'node_modules', '@flowguard', 'core', 'dist');
  let schema;
  let contract;
  try {
    [schema, contract] = await Promise.all([
      import(pathToFileURL(path.join(dist, 'state/evidence-review-invocation.js')).href),
      import(
        pathToFileURL(
          path.join(dist, 'integration/review/validation/review-validation-acceptance.js'),
        ).href
      ),
    ]);
  } catch {
    throw new DemoNotVerifiedError('installed product V2 review contract is unreadable');
  }
  return reviewInvocationValidator(
    schema.ReviewInvocationEvidence,
    contract.hasValidStructuredInvocationContract,
  );
}
