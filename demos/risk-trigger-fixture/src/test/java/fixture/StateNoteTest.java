package fixture;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Positive assertion for the retained claim: the invariant is documented. */
class StateNoteTest {
    static final String INVARIANT = "The module must reject any write that omits the ownership field.";

    @Test
    void documentsInvariant() throws Exception {
        Path note = Path.of("src", "state", "module-state.md");
        assertTrue(Files.exists(note), "the state note must exist");
        assertTrue(Files.readString(note).contains(INVARIANT),
            "the state note must document the ownership invariant");
    }
}
