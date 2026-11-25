package fixture;

import fixture.state.ModuleStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Adversarial runtime probe for the retained ownership claim: a write that
 * omits a meaningful ownership value (null, empty, or whitespace-only) must be
 * rejected. It observes runtime behavior only — it does NOT observe the
 * invariant sentence or the review comment; those are documentation evidence
 * confirmed by content/diff inspection, never by Surefire.
 *
 * When this passes, the attempted falsification did not hold. The environment
 * variable is a deliberate control hook: a skipped probe is not sufficient
 * counterexample evidence. FlowGuard classifies skipped assertions as
 * not_verified, and the demo oracle requires this bound assertion to be
 * passed.
 */
class StateNoteFalsificationProbeTest {
    @Test
    @DisabledIfEnvironmentVariable(named = "FLOWGUARD_LIVE_SKIP_ASSERTION", matches = "1")
    void rejectsMissingOrBlankOwnership() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        assertThrows(IllegalArgumentException.class, () -> store.write(null));
        assertThrows(IllegalArgumentException.class, () -> store.write(""));
        assertThrows(IllegalArgumentException.class, () -> store.write("   "));
        assertThrows(IllegalArgumentException.class, () -> store.write("\t"));
    }
}
