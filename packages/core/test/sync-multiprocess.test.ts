import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

type Message = {
  readonly type: string
  readonly workerID?: string
  readonly deviceID?: string
  readonly eventType?: string
  readonly aggregateID?: string
  readonly operation?: string
  readonly path?: string
  readonly id?: string
  readonly ok?: boolean
  readonly error?: string
  readonly result?: {
    readonly session?: { readonly id: string; readonly title: string }
    readonly cursors: readonly { readonly device_id: string; readonly cursor: number }[]
    readonly lease?: { readonly owner: string; readonly expires_at: number }
  }
}

type Worker = ReturnType<typeof spawnWorker>

function spawnWorker(input: { workerID: string; deviceID: string; deviceRoot: string; cloudRoot: string }) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture", "sync-control-worker.ts"), JSON.stringify(input)],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const messages: Message[] = []
  const waiters = new Set<{
    readonly predicate: (message: Message) => boolean
    resolve: (message: Message) => void
  }>()
  let stdout = ""
  let stderr = ""
  const dispatch = (message: Message) => {
    messages.push(message)
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue
      waiters.delete(waiter)
      waiter.resolve(message)
    }
  }
  const stdoutTask = (async () => {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk)
      const lines = stdout.split("\n")
      stdout = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) dispatch(JSON.parse(line) as Message)
    }
  })()
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk)
  })()
  const waitFor = (predicate: (message: Message) => boolean, timeout = 15_000, after = 0) => {
    const found = messages.slice(after).find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise<Message>((resolve, reject) => {
      const waiter = { predicate, resolve }
      waiters.add(waiter)
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(
          new Error(
            `Timed out waiting for ${input.workerID}; messages: ${JSON.stringify(messages.slice(-20))}; stderr: ${stderr.slice(-2_000)}`,
          ),
        )
      }, timeout)
      waiter.resolve = (message) => {
        clearTimeout(timer)
        resolve(message)
      }
    })
  }
  let sequence = 0
  const request = async (body: Record<string, unknown>) => {
    const id = `${input.workerID}:${++sequence}`
    child.stdin.write(JSON.stringify({ id, ...body }) + "\n")
    const response = await waitFor((message) => message.type === "response" && message.id === id)
    if (!response.ok) throw new Error(response.error ?? `${input.workerID} request failed`)
    return response
  }
  return {
    child,
    input,
    messages,
    mark: () => messages.length,
    waitFor,
    waitForAfter: (after: number, predicate: (message: Message) => boolean, timeout?: number) =>
      waitFor(predicate, timeout, after),
    request,
    ready: () => waitFor((message) => message.type === "ready"),
    stop: async () => {
      if (child.exitCode === null) child.kill()
      await Promise.all([child.exited, stdoutTask, stderrTask])
    },
    crash: async () => {
      if (child.exitCode === null) child.kill("SIGKILL")
      await Promise.all([child.exited, stdoutTask, stderrTask])
    },
  }
}

function providerLeader(workers: readonly Worker[]) {
  const calls = workers.flatMap((worker) => worker.messages.filter((message) => message.type === "provider-call"))
  const ids = new Set(calls.map((message) => message.workerID))
  if (ids.size !== 1) return
  return workers.find((worker) => worker.input.workerID === [...ids][0])
}

async function waitUntil<T>(read: () => T | undefined, description: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitUntilAsync(read: () => Promise<boolean>, description: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

test("coordinates multi-TUI leadership, alternating updates, deletion and crash takeover across real SQLite processes", async () => {
  await using tmp = await tmpdir()
  const cloudRoot = path.join(tmp.path, "cloud")
  const workers: Worker[] = []
  try {
    for (const input of [
      { workerID: "a-1", deviceID: "device-a", deviceRoot: path.join(tmp.path, "device-a"), cloudRoot },
      { workerID: "a-2", deviceID: "device-a", deviceRoot: path.join(tmp.path, "device-a"), cloudRoot },
      { workerID: "b-1", deviceID: "device-b", deviceRoot: path.join(tmp.path, "device-b"), cloudRoot },
      { workerID: "b-2", deviceID: "device-b", deviceRoot: path.join(tmp.path, "device-b"), cloudRoot },
    ]) {
      const worker = spawnWorker(input)
      workers.push(worker)
      await worker.ready()
    }
    const deviceA = workers.filter((worker) => worker.input.deviceID === "device-a")
    const deviceB = workers.filter((worker) => worker.input.deviceID === "device-b")
    await Promise.all([
      waitUntil(() => providerLeader(deviceA), "device A provider leader"),
      waitUntil(() => providerLeader(deviceB), "device B provider leader"),
    ])
    const leaderA = providerLeader(deviceA)!
    const leaderB = providerLeader(deviceB)!
    const observerA = deviceA.find((worker) => worker !== leaderA)!
    const observerB = deviceB.find((worker) => worker !== leaderB)!

    const firstSession = "ses_sync_process_a"
    const firstStarted = Date.now()
    const firstUploadMark = leaderA.mark()
    const firstReceiveMark = leaderB.mark()
    const firstProjectionMark = observerB.mark()
    await observerA.request({ op: "create", sessionID: firstSession, title: "created on A" })
    await leaderA.waitForAfter(
      firstUploadMark,
      (message) =>
        message.type === "provider-call" &&
        message.operation === "upload" &&
        message.path === "devices/device-a.head.json",
    )
    await leaderB.waitForAfter(
      firstReceiveMark,
      (message) =>
        message.type === "event" && message.eventType === "session.created" && message.aggregateID === firstSession,
    )
    await observerB.waitForAfter(
      firstProjectionMark,
      (message) => message.type === "event" && message.eventType === "sync.projection.updated",
    )
    expect(Date.now() - firstStarted).toBeLessThan(15_000)
    expect((await observerB.request({ op: "query", sessionID: firstSession })).result?.session).toEqual({
      id: firstSession,
      title: "created on A",
    })

    const secondSession = "ses_sync_process_b"
    const secondStarted = Date.now()
    const secondUploadMark = leaderB.mark()
    const secondReceiveMark = leaderA.mark()
    const secondProjectionMark = observerA.mark()
    await observerB.request({ op: "create", sessionID: secondSession, title: "created on B" })
    await leaderB.waitForAfter(
      secondUploadMark,
      (message) =>
        message.type === "provider-call" &&
        message.operation === "upload" &&
        message.path === "devices/device-b.head.json",
    )
    await leaderA.waitForAfter(
      secondReceiveMark,
      (message) =>
        message.type === "event" && message.eventType === "session.created" && message.aggregateID === secondSession,
    )
    await observerA.waitForAfter(
      secondProjectionMark,
      (message) => message.type === "event" && message.eventType === "sync.projection.updated",
    )
    expect(Date.now() - secondStarted).toBeLessThan(15_000)
    expect((await observerA.request({ op: "query", sessionID: secondSession })).result?.session).toEqual({
      id: secondSession,
      title: "created on B",
    })

    for (let round = 1; round <= 4; round++) {
      const source = round % 2 === 1 ? observerA : observerB
      const destination = round % 2 === 1 ? observerB : observerA
      const title = `alternating round ${round}`
      const started = Date.now()
      await source.request({ op: "update", sessionID: secondSession, title })
      await waitUntilAsync(
        async () =>
          (await destination.request({ op: "query", sessionID: secondSession })).result?.session?.title === title,
        `alternating Session update ${round}`,
      )
      expect(Date.now() - started).toBeLessThan(15_000)
    }

    const deletionStarted = Date.now()
    await observerA.request({ op: "delete", sessionID: firstSession })
    await waitUntilAsync(
      async () => (await observerB.request({ op: "query", sessionID: firstSession })).result?.session === undefined,
      "the control-log deletion to remove the Session on device B",
    )
    expect(Date.now() - deletionStarted).toBeLessThan(15_000)

    expect(
      new Set(
        deviceA.flatMap((worker) =>
          worker.messages.filter((item) => item.type === "provider-call").map((item) => item.workerID),
        ),
      ),
    ).toEqual(new Set([leaderA.input.workerID]))
    expect(
      new Set(
        deviceB.flatMap((worker) =>
          worker.messages.filter((item) => item.type === "provider-call").map((item) => item.workerID),
        ),
      ),
    ).toEqual(new Set([leaderB.input.workerID]))

    await leaderA.crash()
    const takeoverStarted = Date.now()
    const takeoverMark = observerA.mark()
    await observerA.request({ op: "expire-automatic-lease" })
    await observerA.waitForAfter(
      takeoverMark,
      (message) => message.type === "provider-call" && message.workerID === observerA.input.workerID,
      2_500,
    )
    expect(Date.now() - takeoverStarted).toBeLessThan(2_500)

    const afterCrash = "ses_sync_after_crash"
    const afterCrashUploadMark = leaderB.mark()
    const afterCrashReceiveMark = observerA.mark()
    await observerB.request({ op: "create", sessionID: afterCrash, title: "after leader crash" })
    await leaderB.waitForAfter(
      afterCrashUploadMark,
      (message) =>
        message.type === "provider-call" &&
        message.operation === "upload" &&
        message.path === "devices/device-b.head.json",
    )
    await observerA.waitForAfter(
      afterCrashReceiveMark,
      (message) =>
        message.type === "event" && message.eventType === "session.created" && message.aggregateID === afterCrash,
    )
    expect((await observerA.request({ op: "query", sessionID: afterCrash })).result?.session).toEqual({
      id: afterCrash,
      title: "after leader crash",
    })
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()))
  }
}, 45_000)
