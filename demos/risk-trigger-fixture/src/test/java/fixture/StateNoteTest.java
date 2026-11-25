package fixture;

import fixture.state.ModuleStateStore;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Behavior fixtures for the retained runtime claim. `rejectsMissingOwnership` is
 * the claim's bound positive evidence and covers the FULL claimed property:
 * missing (null or empty) and blank (whitespace-only) owners are rejected.
 * `storesValidOwnership` is a supplementary accept-path observation.
 * `StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership` is the
 * independent adversarial counterexample; overlapping inputs between the two
 * rejection assertions are intentional — independence is carried by distinct
 * check attempts and evidence roles, never by disjoint test inputs. None of
 * these observe the invariant sentence or the review comment.
 */
class StateNoteTest {
    @Test
    void rejectsMissingOwnership() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        assertThrows(IllegalArgumentException.class, () -> store.write(null));
        assertThrows(IllegalArgumentException.class, () -> store.write(""));
        assertThrows(IllegalArgumentException.class, () -> store.write("   "));
        assertThrows(IllegalArgumentException.class, () -> store.write("\t"));
    }

    @Test
    void storesValidOwnership() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        store.write("state-platform");
        assertEquals("state-platform", store.ownership());
    }
}
