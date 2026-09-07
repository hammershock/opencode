import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TerminalEnvironmentStale"
const projectID = "proj_terminal_environment_stale"
const sessionID = "ses_terminal_environment_stale"
const originalID = "pty_terminal_environment_old"
const replacementID = "pty_terminal_environment_new"

test.use({ viewport: { width: 1440, height: 900 } })

test("shows a stale terminal and restarts only after the explicit action", async ({ page }) => {
  let restarted = 0
  let restartFulfilled = 0
  let restartAdmission: string | undefined
  let listed = 0
  await mockOpenCodeServer(page, {
    protocol: "v1",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "terminal-environment-stale",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "terminal-environment-stale",
        projectID,
        directory,
        title: "Terminal environment stale",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })

  const location = { directory, project: { id: projectID, directory } }
  const info = (id: string, generation: number, stale: boolean) => ({
    id,
    title: "Terminal 1",
    command: "cmd.exe",
    args: [],
    cwd: directory,
    status: "running",
    pid: generation,
    environmentGeneration: generation,
    environmentStale: stale,
  })

  await page.route("**/api/pty?*", (route) => {
    listed += 1
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location, data: [info(originalID, 1, true)] }),
    })
  })
  await page.route("**/pty?*", (route) => {
    listed += 1
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([info(originalID, 1, true)]),
    })
  })
  await page.route(`**/api/pty/${originalID}/restart*`, async (route) => {
    restarted += 1
    restartAdmission = (route.request().postDataJSON() as { sessionID?: string }).sessionID
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location, data: info(replacementID, 2, false) }),
    })
    restartFulfilled += 1
  })
  await page.route(`**/pty/${originalID}/restart*`, async (route) => {
    restarted += 1
    restartAdmission = (route.request().postDataJSON() as { sessionID?: string }).sessionID
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(info(replacementID, 2, false)),
    })
    restartFulfilled += 1
  })
  await page.route(/\/api\/pty\/[^/]+\/connect-token/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location, data: { ticket: "e2e-ticket", expires_in: 60 } }),
    }),
  )
  await page.route(/\/pty\/[^/]+\/connect-token/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ticket: "e2e-ticket", expires_in: 60 }),
    }),
  )
  await page.routeWebSocket(/\/api\/pty\/[^/]+\/connect/, () => undefined)
  await page.routeWebSocket(/\/pty\/[^/]+\/connect/, () => undefined)
  await page.addInitScript(
    ({ terminalKey, ptyID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ terminal: { height: 320, opened: true } }))
      localStorage.setItem(
        terminalKey,
        JSON.stringify({
          active: ptyID,
          all: [{ id: ptyID, title: "Terminal 1", titleNumber: 1 }],
        }),
      )
    },
    { terminalKey: `${base64Encode(directory)}/terminal.v1`, ptyID: originalID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal environment stale")

  const tab = page.getByRole("tab", { name: /Terminal 1/ })
  await expect(tab).toBeVisible()
  await expect.poll(() => listed).toBeGreaterThan(0)
  await expect(tab.getByLabel("Environment changed. Restart terminal to apply.")).toBeVisible()
  expect(restarted).toBe(0)

  await tab.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Restart terminal" }).click()

  await expect.poll(() => restarted).toBe(1)
  await expect.poll(() => restartFulfilled).toBe(1)
  expect(restartAdmission).toBe(sessionID)
  await expect(page.getByText("Failed to restart terminal")).toHaveCount(0)
  await expect
    .poll(() => page.locator('[id^="terminal-wrapper-"]').evaluateAll((items) => items.map((item) => item.id)))
    .toEqual([`terminal-wrapper-${replacementID}`])
  await expect(page.getByLabel("Environment changed. Restart terminal to apply.")).toBeHidden()
  await expect(page.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute("aria-selected", "true")
})
