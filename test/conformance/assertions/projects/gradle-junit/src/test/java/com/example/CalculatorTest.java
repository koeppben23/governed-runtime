package com.example;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;

class CalculatorTest {

    @Test
    void testAddition() {
        assertEquals(4, 2 + 2);
    }

    @Test
    void testSubtraction() {
        assertEquals(2, 5 - 3);
    }

    @Test
    void testFailingAssertion() {
        assertEquals(5, 2 + 2);
    }

    @Test
    @Disabled("demonstrating skipped test")
    void testSkipped() {
        // intentionally skipped
    }

    @Nested
    class AdvancedOperations {

        @Test
        void testMultiplication() {
            assertEquals(6, 3 * 2);
        }

        @Test
        void testNestedFailing() {
            fail("nested failure");
        }
    }
}
