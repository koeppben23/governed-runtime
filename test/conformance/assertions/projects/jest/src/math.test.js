const { add, subtract, multiply } = require('./math.js');

describe('calculator', () => {
  describe('add', () => {
    test('adds two positive numbers', () => {
      expect(add(2, 3)).toBe(5);
    });

    test('adds negative numbers', () => {
      expect(add(-1, -1)).toBe(-2);
    });
  });

  describe('subtract', () => {
    test('subtracts two numbers', () => {
      expect(subtract(5, 3)).toBe(2);
    });
  });

  describe('multiply', () => {
    test('multiplies two numbers', () => {
      expect(multiply(3, 4)).toBe(12);
    });

    test('failing multiplication', () => {
      expect(multiply(2, 3)).toBe(7);
    });
  });

  test.skip('skipped division test', () => {
    // intentionally skipped
    expect(1).toBe(1);
  });
});
