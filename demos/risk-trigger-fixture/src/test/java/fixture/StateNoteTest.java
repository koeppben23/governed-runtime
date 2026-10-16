package fixture;

import fixture.state.ModuleStateStore;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Behavior fixtures for the retained runtime claim. `rejectsMissingOwnership` is
 * the claim's bound positive evidence: writes with a missing owner (null or
 * empty) are rejected. `storesValidOwnership` is a supplementary accept-path
 * observation. Whitespace-only rejection and the skip control live in
 * StateNoteFalsificationProbeTest. None of these observe the invariant sentence
 * or the review comment.
 */
class StateNoteTest {
    @Test
    void rejectsMissingOwnership() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        assertThrows(IllegalArgumentException.class, () -> store.write(null));
        assertThrows(IllegalArgumentException.class, () -> store.write(""));
    }

    @Test
    void storesValidOwnership() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        store.write("state-platform");
        assertEquals("state-platform", store.ownership());
    }
}
