import { expect, test } from "bun:test"
import path from "node:path"
import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isJsxAttribute,
  type Node,
} from "typescript"

// This guard covers every TUI source file that combines a scrollbox with pointer handlers.
// A failure means pointer focus has been wired to a reveal/scroll path again. Route the
// handler through a focus-only function; keyboard navigation may keep the reveal call.
// See "Input, completion and focus" in docs/ui-design-guidelines.md.
test("scrolling selector pointer handlers cannot call reveal or scroll functions", async () => {
  const root = path.resolve(import.meta.dir, "../../src")
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.tsx").scan({ cwd: root, absolute: true })) {
    const source = await Bun.file(file).text()
    if (!source.includes("<scrollbox")) continue
    violations.push(...pointerRevealCalls(path.relative(root, file), source))
  }

  expect(
    violations,
    "Pointer focus must not own the viewport. Use a focus-only handler and keep reveal/scroll calls on keyboard paths.",
  ).toEqual([])
})

test("scrolling selector guard reports the repair path", () => {
  expect(
    pointerRevealCalls("broken-selector.tsx", "<scrollbox><box onMouseMove={() => moveTo(4)} /></scrollbox>"),
  ).toEqual(["broken-selector.tsx:1 onMouseMove -> moveTo"])
})

// These are the TUI's scrollboxes whose cursor represents a selectable row. Their
// keyboard reveal path must use OpenTUI's geometry-aware primitive, not duplicated
// scrollTop/height arithmetic. If this fails, give each row a unique renderable ID
// and call scrollChildIntoView(id) after changing the keyboard selection.
test("scrolling selectors delegate keyboard reveal to OpenTUI", async () => {
  const root = path.resolve(import.meta.dir, "../../src")
  const selectors = [
    "component/prompt/autocomplete.tsx",
    "ui/dialog-select.tsx",
    "feature-plugins/system/diff-viewer-file-tree.tsx",
  ]

  for (const file of selectors) {
    const source = await Bun.file(path.join(root, file)).text()
    expect(source, `${file} must use OpenTUI scrollChildIntoView`).toContain(".scrollChildIntoView(")
    expect(source, `${file} must not maintain a parallel keyboard viewport algorithm`).not.toMatch(
      /\bscroll\?*\.(?:scrollBy|scrollTo)\(/,
    )
  }
})

function pointerRevealCalls(file: string, source: string) {
  const parsed = createSourceFile(file, source, ScriptTarget.Latest, true, ScriptKind.TSX)
  const violations: string[] = []

  function visit(node: Node) {
    if (isJsxAttribute(node) && ["onMouseMove", "onMouseOver"].includes(node.name.getText(parsed))) {
      forEachChild(node, function inspect(child) {
        if (isCallExpression(child)) {
          const callee = child.expression.getText(parsed)
          if (
            /(?:^|\.)(?:move|moveTo|reveal|recenter|ensureVisible|scrollTo|scrollBy|scrollToSelection)$/.test(callee)
          ) {
            const position = parsed.getLineAndCharacterOfPosition(child.getStart(parsed))
            violations.push(`${file}:${position.line + 1} ${node.name.getText(parsed)} -> ${callee}`)
          }
        }
        forEachChild(child, inspect)
      })
    }
    forEachChild(node, visit)
  }

  visit(parsed)
  return violations
}
