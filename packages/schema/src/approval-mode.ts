export * as ApprovalMode from "./approval-mode"

import { Schema } from "effect"

export const Mode = Schema.Literals(["normal", "auto"]).annotate({ identifier: "ApprovalMode" })
export type Mode = typeof Mode.Type
