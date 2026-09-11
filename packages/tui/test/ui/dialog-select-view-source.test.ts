import { expect, test } from "bun:test"
import path from "node:path"
import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isFunctionExpression,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isPropertyAssignment,
  type Node,
} from "typescript"

const viewFields = new Set(["titleView", "footer", "categoryView", "margin"])

// Dialog option models can outlive the dialog that renders them. Creating JSX while
// building those models leaves OpenTUI effects owned by the producer, so they may
// update renderables after the dialog has destroyed them. Keep views as factories;
// DialogSelect invokes them under its own disposable owner.
test("TUI option models cannot retain eagerly-created JSX", async () => {
  const root = path.resolve(import.meta.dir, "../../src")
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.tsx").scan({ cwd: root, absolute: true })) {
    violations.push(...eagerOptionViews(path.relative(root, file), await Bun.file(file).text()))
  }

  expect(
    violations,
    "Store view fields as `() => <View />` so their renderables are owned and disposed by DialogSelect.",
  ).toEqual([])
})

test("retained JSX guard distinguishes eager views from factories", () => {
  expect(eagerOptionViews("broken.tsx", "const option = { footer: <Status /> }")).toEqual(["broken.tsx:1 footer"])
  expect(eagerOptionViews("safe.tsx", "const option = { footer: () => <Status /> }")).toEqual([])
})

function eagerOptionViews(file: string, source: string) {
  const parsed = createSourceFile(file, source, ScriptTarget.Latest, true, ScriptKind.TSX)
  const violations: string[] = []

  function visit(node: Node) {
    if (isPropertyAssignment(node) && viewFields.has(node.name.getText(parsed)) && containsEagerJsx(node.initializer)) {
      const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
      violations.push(`${file}:${position.line + 1} ${node.name.getText(parsed)}`)
    }
    forEachChild(node, visit)
  }

  visit(parsed)
  return violations
}

function containsEagerJsx(node: Node) {
  if (isArrowFunction(node) || isFunctionExpression(node)) return false
  if (isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node)) return true
  const children: Node[] = []
  forEachChild(node, (child) => children.push(child))
  return children.some(containsEagerJsx)
}
