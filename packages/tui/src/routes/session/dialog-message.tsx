import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
import { canonicalUserText, restoreCanonicalPrompt } from "../../util/session-message"
import { useToast } from "../../ui/toast"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const data = useData()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const canonical = createMemo(() => {
    const item = data.session.message.list(props.sessionID)?.find((message) => message.id === props.messageID)
    return item?.type === "user" ? item : undefined
  })
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: async (dialog) => {
            const current = canonical()
            if (current) {
              const session = data.session.get(props.sessionID)
              if (!session) return
              try {
                const catalog = await sdk.client.v2.skill.catalog(
                  {
                    location: {
                      directory: session.location.directory,
                      workspace: session.location.workspaceID,
                      ...(session.location.target?.type === "rexd" ? { target: session.location.target.targetID } : {}),
                    },
                  },
                  { throwOnError: true },
                )
                const restored = restoreCanonicalPrompt(current, catalog.data.data.skills)
                if ("missing" in restored) {
                  toast.show({
                    message: `Cannot revert: $${restored.missing} is no longer available. Reload Skills and try again.`,
                    variant: "error",
                  })
                  return
                }
                await sdk.client.v2.session.interrupt({ sessionID: props.sessionID }, { throwOnError: true })
                await sdk.client.v2.session.revert.stage(
                  { sessionID: props.sessionID, messageID: current.id },
                  { throwOnError: true },
                )
                props.setPrompt?.(restored.prompt)
                dialog.clear()
              } catch (error) {
                toast.error(error)
              }
              return
            }
            const msg = message()
            if (!msg) return

            void sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              const parts = sync.data.part[msg.id]
              const promptInfo = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const current = canonical()
            if (current) {
              await clipboard.write?.(canonicalUserText(current))
              dialog.clear()
              return
            }
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
