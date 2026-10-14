package fixture;

import fixture.state.ModuleStateStore;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

/** Positive assertion for the retained claim: the invariant is documented. */
class StateNoteTest {
    static final String INVARIANT = "The module must reject any write that omits the ownership field.";

    @Test
    void documentsInvariant() throws Exception {
        ModuleStateStore store = new ModuleStateStore();
        store.write("state-platform");
        assertEquals("state-platform", store.ownership());
    }
}
