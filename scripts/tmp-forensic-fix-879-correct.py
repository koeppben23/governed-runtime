from pathlib import Path

p = Path('scripts/tmp-forensic-fix-879.py')
s = p.read_text()
old1 = '''replace(
    "src/integration/review/shared-helpers.ts",
    """    childSessionId: string;\n    promptHash: string;\n    findingsHash: string;\n""",
    """    childSessionId: string;\n    attemptId: string;\n    promptHash: string;\n    findingsHash: string;\n    invokedAt: string;\n    fulfilledAt: string;\n""",
    1,
)
'''
new1 = '''replace(
    "src/integration/review/shared-helpers.ts",
    """function buildSdkSessionInvocation(\n  params: {\n    obligationId: string;\n    obligationType: ReviewObligationType;\n    sessionId: string;\n    childSessionId: string;\n    promptHash: string;\n    findingsHash: string;\n""",
    """function buildSdkSessionInvocation(\n  params: {\n    obligationId: string;\n    obligationType: ReviewObligationType;\n    sessionId: string;\n    childSessionId: string;\n    attemptId: string;\n    promptHash: string;\n    findingsHash: string;\n    invokedAt: string;\n    fulfilledAt: string;\n""",
)
'''
if s.count(old1) != 1:
    raise SystemExit(f'first ambiguous patch definition count={s.count(old1)}')
s = s.replace(old1, new1)
old2 = '''replace(
    "src/integration/review/shared-helpers.ts",
    """    childSessionId: string;\n    promptHash: string;\n    findingsHash: string;\n    reviewerResult: Pick<\n""",
    """    childSessionId: string;\n    attemptId: string;\n    promptHash: string;\n    findingsHash: string;\n    invokedAt: string;\n    fulfilledAt: string;\n    reviewerResult: Pick<\n""",
    1,
)
'''
new2 = '''replace(
    "src/integration/review/shared-helpers.ts",
    """export async function recordEvidenceOrBlockReuse(\n  deps: OrchestratorDeps,\n  sessDir: string,\n  params: {\n    obligationId: string;\n    obligationType: ReviewObligationType;\n    sessionId: string;\n    childSessionId: string;\n    promptHash: string;\n    findingsHash: string;\n    reviewerResult: Pick<\n""",
    """export async function recordEvidenceOrBlockReuse(\n  deps: OrchestratorDeps,\n  sessDir: string,\n  params: {\n    obligationId: string;\n    obligationType: ReviewObligationType;\n    sessionId: string;\n    childSessionId: string;\n    attemptId: string;\n    promptHash: string;\n    findingsHash: string;\n    invokedAt: string;\n    fulfilledAt: string;\n    reviewerResult: Pick<\n""",
)
'''
if s.count(old2) != 1:
    raise SystemExit(f'second ambiguous patch definition count={s.count(old2)}')
s = s.replace(old2, new2)
old3 = '''replace(
    "src/integration/review/orchestrator.ts",
    """  readonly modelCapabilityError: string;\n  onFailed: (info: {\n""",
    """  readonly modelCapabilityError: string;\n  readonly invokedAt: string;\n  onFailed: (info: {\n""",
)
'''
new3 = '''replace(
    "src/integration/review/orchestrator.ts",
    """  modelCapabilityError: string;\n  onFailed: (info: {\n""",
    """  modelCapabilityError: string;\n  invokedAt: string;\n  onFailed: (info: {\n""",
)
'''
if s.count(old3) != 1:
    raise SystemExit(f'orchestrator interface patch definition count={s.count(old3)}')
s = s.replace(old3, new3)
old4 = '''replace(
    "src/integration/review/content-review-pipeline.ts",
    """  prompt: string,\n): Promise<boolean> {\n""",
    """  prompt: string,\n  attemptId: string,\n): Promise<boolean> {\n""",
    1,
)
'''
new4 = '''replace(
    "src/integration/review/content-review-pipeline.ts",
    """async function enforceContentStrictGate(\n  ctx: PipelineContext,\n  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },\n  findings: {\n    reviewMode?: string;\n    attestation?: Record<string, unknown> | null;\n    overallVerdict?: string;\n  },\n  prompt: string,\n): Promise<boolean> {\n""",
    """async function enforceContentStrictGate(\n  ctx: PipelineContext,\n  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },\n  findings: {\n    reviewMode?: string;\n    attestation?: Record<string, unknown> | null;\n    overallVerdict?: string;\n  },\n  prompt: string,\n  attemptId: string,\n): Promise<boolean> {\n""",
)
'''
if s.count(old4) != 1:
    raise SystemExit(f'content review strict-gate patch definition count={s.count(old4)}')
p.write_text(s.replace(old4, new4))
