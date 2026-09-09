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
