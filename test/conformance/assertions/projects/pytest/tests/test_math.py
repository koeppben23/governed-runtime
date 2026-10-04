import pytest


def test_addition():
    assert 2 + 2 == 4


def test_subtraction():
    assert 5 - 3 == 2


def test_failing_assertion():
    assert 2 + 2 == 5


@pytest.mark.skip(reason="demonstrating skipped test")
def test_skipped():
    pass


@pytest.mark.parametrize("a,b,expected", [
    (2, 3, 5),
    (-1, -1, -2),
    (0, 5, 5),
])
def test_parametrized(a, b, expected):
    assert a + b == expected


@pytest.mark.parametrize("a,b,expected", [
    (2, 3, 6),
])
def test_parametrized_failing(a, b, expected):
    assert a + b == expected


class TestMultiply:
    def test_positive(self):
        assert 3 * 4 == 12

    def test_with_zero(self):
        assert 5 * 0 == 0

    def test_failing(self):
        assert 2 * 3 == 7
