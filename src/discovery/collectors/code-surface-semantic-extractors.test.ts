import { describe, expect, it } from 'vitest';
import { extractSemanticCodeSurfaces } from './code-surface-semantic-extractors.js';

describe('Java Spring semantic endpoint extraction', () => {
  it('ignores mappings inside block comments that start after code on a previous line', () => {
    const result = extractSemanticCodeSurfaces(
      `
        class CommentedController {
          String docs; /*
            @GetMapping("/fake")
          */
          String helper() { return docs; }
        }
      `,
      'src/main/java/com/acme/CommentedController.java',
    );

    expect(result.endpoints).toHaveLength(0);
  });

  it('detects a mapped method but not control-flow expressions', () => {
    const result = extractSemanticCodeSurfaces(
      `
        class Controller {
          @GetMapping("/users")
          public String users() { return "users"; }
          @GetMapping("/other")
          if (ready) { return "no"; }
          @GetMapping("/third")
          return helper();
        }
      `,
      'src/main/java/com/acme/Controller.java',
    );

    expect(result.endpoints).toEqual([
      expect.objectContaining({ id: 'semantic-java-spring-controller' }),
    ]);
  });

  it('preserves generic methods and generic return types', () => {
    const result = extractSemanticCodeSurfaces(
      `
        class Controller {
          @GetMapping("/generic")
          public <T extends Comparable<T>> List<T> generic(T input) { return List.of(input); }
          @GetMapping("/generic-return")
          Map<String, Integer> counts() { return Map.of(); }
        }
      `,
      'src/main/java/com/acme/Controller.java',
    );

    expect(result.endpoints).toHaveLength(2);
  });

  it('scans adversarial annotation remainders in linear time', () => {
    const hostile = `@GetMapping("/x")\n${'$<'.repeat(20_000)}${'> $<'.repeat(20_000)}\n`;
    const result = extractSemanticCodeSurfaces(hostile, 'src/main/java/com/acme/Hostile.java');
    expect(result.endpoints).toHaveLength(0);
  });

  it('continues scanning after a multiline block comment ending before the mapped method', () => {
    const result = extractSemanticCodeSurfaces(
      `
        class CommentedController {
          @GetMapping("/users") /* explanation
           * still explanation
           */ public String users() { return "users"; }
        }
      `,
      'src/main/java/com/acme/CommentedController.java',
    );

    expect(result.endpoints).toEqual([
      expect.objectContaining({ id: 'semantic-java-spring-controller' }),
    ]);
  });
});
