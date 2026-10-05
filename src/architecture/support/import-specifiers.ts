/**
 * @module architecture/import-specifiers
 * @description Shared syntax-based module specifier collector for architecture
 * guards.
 *
 * This is deliberately AST-based, not regex-based: comments between `from`/
 * `import` and the string literal are trivia and cannot hide an edge, while
 * commented-out imports and import-looking string content cannot fabricate one.
 * The analysis stays syntactic — no type checking, symbol resolution, or
 * computed-path evaluation. Computed module paths are never reported as
 * statically resolvable specifiers.
 *
 * Covered forms: `import ... from`, `export ... from`, `import x = require(...)`,
 * dynamic `import()`, `require()`, and static `import('...')` type references.
 * Consumers own classification, path resolution, and policy decisions; this
 * module only extracts module paths plus the statement text needed for
 * diagnostics.
 *
 * @version v1
 */

import * as ts from 'typescript';

/** The syntax form that produced a specifier. */
export type ImportSpecifierKind =
  'import' | 're-export' | 'import-equals' | 'dynamic-import' | 'import-type' | 'require';

/** A syntactically recognized static module specifier. */
export interface ImportSpecifier {
  /** The literal module path exactly as written in source. */
  readonly module: string;
  /** Source text of the containing declaration or call, for diagnostics. */
  readonly raw: string;
  /** The syntax form that produced the specifier. */
  readonly kind: ImportSpecifierKind;
}

const DIAGNOSTIC_FILE_NAME = 'import-specifiers.ts';

/**
 * Collect every static module specifier from a TypeScript source text in
 * source order. Duplicates are preserved: each occurrence is an import site.
 */
export function collectImportSpecifiers(sourceText: string): ImportSpecifier[] {
  const sourceFile = ts.createSourceFile(
    DIAGNOSTIC_FILE_NAME,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: ImportSpecifier[] = [];

  const collect = (
    node: ts.Node,
    expression: ts.Expression | undefined,
    kind: ImportSpecifierKind,
  ): void => {
    if (expression === undefined || !ts.isStringLiteralLike(expression)) return;
    specifiers.push({ module: expression.text, raw: node.getText(sourceFile), kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      collect(node, node.moduleSpecifier, 'import');
    } else if (ts.isExportDeclaration(node)) {
      collect(node, node.moduleSpecifier, 're-export');
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        collect(node, reference.expression, 'import-equals');
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) {
        collect(node, argument.literal, 'import-type');
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        collect(node, node.arguments[0], 'dynamic-import');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        collect(node, node.arguments[0], 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}
