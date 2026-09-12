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
p.write_text(s.replace(old2, new2))
