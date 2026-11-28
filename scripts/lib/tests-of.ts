import ts from "typescript";

/** The functions that declare a test or a group of them, whatever their modifiers. */
const TESTS = new Set(["test", "it"]);
const GROUPS = new Set(["describe"]);

/**
 * The function a call declares with: `test`, `it` or `describe`, through any chain of modifiers
 * (`test.concurrent`, `test.skipIf(…)`, `describe.for(…)`, `test.concurrent.for(…)`), or nothing.
 */
function declarer(callee: ts.Expression): string | undefined {
  let at: ts.Expression = callee;
  for (;;) {
    if (ts.isIdentifier(at)) return at.text;
    if (ts.isPropertyAccessExpression(at)) at = at.expression;
    else if (ts.isCallExpression(at)) at = at.expression;
    else return undefined;
  }
}

/**
 * Every test in a file, by its full name ("describe > test"), with its source as written: each
 * `test(…)` and `it(…)`, with or without modifiers (`test.skipIf(…)(…)`, `test.concurrent(…)`,
 * `test.for(…)(…)`), inside `describe` blocks of any kind. A title must be a string literal.
 */
export function testsOf(source: string, file: string): Map<string, string> {
  const tests = new Map<string, string>();
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node, names: readonly string[]) => {
    if (ts.isCallExpression(node)) {
      const by = declarer(node.expression);
      const [title] = node.arguments;
      const name = title && ts.isStringLiteralLike(title) ? title.text : undefined;
      if (by !== undefined && name !== undefined && GROUPS.has(by)) {
        ts.forEachChild(node, (child) => visit(child, [...names, name]));
        return;
      }
      if (by !== undefined && name !== undefined && TESTS.has(by)) {
        tests.set([...names, name].join(" > "), node.getText(tree));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, names));
  };
  visit(tree, []);
  return tests;
}
