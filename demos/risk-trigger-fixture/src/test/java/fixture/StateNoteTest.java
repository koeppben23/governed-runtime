package fixture;

import fixture.state.ModuleStateStore;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Positive runtime assertion for the retained ownership claim: a valid owner is
 * accepted, stored, and read back. This observes the accept path only;
 * rejection of missing or blank ownership is observed by
 * StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership. It asserts
 * nothing about the invariant documentation text.
 */
class StateNoteTest {
    @Test
    void storesValidOwnership() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        store.write("state-platform");
        assertEquals("state-platform", store.ownership());
    }
}
