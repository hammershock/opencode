import type { Store } from "@opencode-ai/core/sync/secure-store"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { cmd } from "./cmd"

const MAX_STDIN_BYTES = 4 * 1024

export async function provisionBaiduAppFromStream(store: Store, input: AsyncIterable<Uint8Array | string>) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    size += bytes.byteLength
    if (size > MAX_STDIN_BYTES) throw new Error("Invalid Baidu app provisioning input")
    chunks.push(bytes)
  }
  if (!size) throw new Error("Invalid Baidu app provisioning input")
  await SyncSecureStore.provisionBaiduApp(store, Buffer.concat(chunks).toString("utf8"))
}

/** Hidden release-operator entrypoint. It is intentionally absent from user help. */
export const DeployProvisionBaiduAppCommand = cmd({
  command: "__deploy-provision-baidu-app",
  describe: false,
  async handler() {
    const store = await SyncSecureStore.detect()
    await provisionBaiduAppFromStream(store, process.stdin)
    process.stdout.write("Baidu OAuth application provisioned\n")
  },
})
