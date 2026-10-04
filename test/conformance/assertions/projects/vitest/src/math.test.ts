import { describe, it, expect } from 'vitest';
import { add, subtract, multiply } from './math.js';

describe('calculator', () => {
  describe('add', () => {
    it('adds two positive numbers', () => {
      expect(add(2, 3)).toBe(5);
    });

    it('adds negative numbers', () => {
      expect(add(-1, -1)).toBe(-2);
    });
  });

  describe('subtract', () => {
    it('subtracts two numbers', () => {
      expect(subtract(5, 3)).toBe(2);
    });
  });

  describe('multiply', () => {
    it('multiplies two numbers', () => {
      expect(multiply(3, 4)).toBe(12);
    });

    it('failing multiplication', () => {
      expect(multiply(2, 3)).toBe(7);
    });
  });

  it.skip('skipped division test', () => {
    // intentionally skipped
    expect(1).toBe(1);
  });
});
