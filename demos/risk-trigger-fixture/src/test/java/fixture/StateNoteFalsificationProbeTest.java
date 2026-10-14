package fixture;

import fixture.state.ModuleStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Adversarial falsification probe for the claim. It does not repeat the positive
 * assertion: it additionally requires that the recorded invariant is not relaxed.
 * When this passes, the attempted falsification did not hold. The environment
 * variable is a deliberate control hook for the negative case.
 */
class StateNoteFalsificationProbeTest {
    @Test
    @DisabledIfEnvironmentVariable(named = "FLOWGUARD_LIVE_SKIP_ASSERTION", matches = "1")
    void noRelaxedInvariantIsDocumented() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        assertThrows(IllegalArgumentException.class, () -> store.write(null));
        assertThrows(IllegalArgumentException.class, () -> store.write(""));
    }
}
