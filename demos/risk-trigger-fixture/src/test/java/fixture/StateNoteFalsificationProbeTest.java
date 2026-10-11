package fixture;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
        Path note = Path.of("src", "state", "module-state.md");
        String text = Files.readString(note);
        assertTrue(text.contains(StateNoteTest.INVARIANT), "falsifier: the invariant is absent");
        assertFalse(text.contains("ownership field is optional"),
            "falsifier: the invariant was relaxed");
    }
}
