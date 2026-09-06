export type RexdPhase =
  | "ssh"
  | "detect"
  | "unsupported-platform"
  | "download"
  | "checksum"
  | "install"
  | "launch"
  | "handshake"
  | "capability"
  | "directory"
  | "transport"
  | "cancelled"

export class RexdError extends Error {
  override readonly name = "RexdError"

  constructor(
    readonly phase: RexdPhase,
    message: string,
    readonly retryable: boolean,
    readonly outcome: "failed" | "unknown" = "failed",
    readonly diagnostic?: string,
  ) {
    super(message)
  }
}

export function cancelled(signal: AbortSignal, outcome: "failed" | "unknown" = "failed") {
  return new RexdError("cancelled", "Rexd operation cancelled", true, outcome, abortReason(signal))
}

export function redactDiagnostic(value: string, secrets: readonly string[] = []) {
  return secrets
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
    .replace(/(-----BEGIN [^-]+-----)[\s\S]*?(-----END [^-]+-----)/g, "$1[redacted]$2")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(-16 * 1024)
}

function abortReason(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason.name
  return "AbortError"
}
