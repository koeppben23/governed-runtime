package math

import "testing"

func TestAddition(t *testing.T) {
	if result := Add(2, 3); result != 5 {
		t.Errorf("Add(2,3) = %d; want 5", result)
	}
}

func TestSubtraction(t *testing.T) {
	if result := Subtract(5, 3); result != 2 {
		t.Errorf("Subtract(5,3) = %d; want 2", result)
	}
}

func TestFailing(t *testing.T) {
	if result := Multiply(2, 3); result != 7 {
		t.Errorf("Multiply(2,3) = %d; want 7", result)
	}
}

func TestSkipped(t *testing.T) {
	t.Skip("demonstrating skipped test")
}

func TestNested(t *testing.T) {
	t.Run("multiplication", func(t *testing.T) {
		if result := Multiply(3, 4); result != 12 {
			t.Errorf("Multiply(3,4) = %d; want 12", result)
		}
	})

	t.Run("nested_failing", func(t *testing.T) {
		if result := Add(1, 1); result != 3 {
			t.Errorf("Add(1,1) = %d; want 3", result)
		}
	})
}
