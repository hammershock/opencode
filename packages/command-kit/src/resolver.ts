import type { CommandRoute } from "./registry"
import type { CommandProvenance, InvocationContext, RawArguments, RegisteredCommand } from "./types"

export type CoreResolution<Context extends InvocationContext = InvocationContext> =
  | { status: "not-slash" | "not-found" }
  | {
      status: "matched"
      command: RegisteredCommand<Context>
      route: readonly string[]
      routeType: "canonical" | "alias"
      arguments: RawArguments
    }

export type UpstreamCandidate = {
  id: string
  path: readonly string[]
  provenance: CommandProvenance
}

export type ResolutionDiagnostic = {
  type: "shadowed"
  winner: UpstreamCandidate
  shadowed: {
    id: string
    path: readonly string[]
    provenance: CommandProvenance
  }
}

export type HostResolution<Context extends InvocationContext = InvocationContext> =
  | {
      status: "upstream"
      candidate: UpstreamCandidate
      arguments: RawArguments
      diagnostics: readonly ResolutionDiagnostic[]
    }
  | {
      status: "core"
      resolution: Extract<CoreResolution<Context>, { status: "matched" }>
      diagnostics: readonly []
    }
  | { status: "passthrough"; input: string; diagnostics: readonly [] }

export type UpstreamResolver = (input: string) => UpstreamCandidate | readonly UpstreamCandidate[] | undefined

export function resolveCore<Context extends InvocationContext>(
  input: string,
  routes: readonly CommandRoute<Context>[],
): CoreResolution<Context> {
  if (!input.startsWith("/")) return { status: "not-slash" }
  const tokens = scanFirstLine(input)
  const matches = routes
    .map((route) => ({ route, consumed: matchRoute(route.path, tokens) }))
    .filter((item): item is { route: CommandRoute<Context>; consumed: number } => item.consumed !== undefined)
    .sort((a, b) => b.route.path.length - a.route.path.length)
  const match = matches[0]
  if (!match) return { status: "not-found" }

  const argumentStart = skipOneSeparator(input, match.consumed)
  return {
    status: "matched",
    command: match.route.command,
    route: match.route.path,
    routeType: match.route.type,
    arguments: {
      source: input,
      value: input.slice(argumentStart),
      range: { start: argumentStart, end: input.length },
    },
  }
}

export function createHostResolver<Context extends InvocationContext>(
  routes: readonly CommandRoute<Context>[],
  upstream: UpstreamResolver,
) {
  return (input: string): HostResolution<Context> => {
    const upstreamResult = upstream(input)
    const candidates = upstreamResult ? (Array.isArray(upstreamResult) ? upstreamResult : [upstreamResult]) : []
    const candidate = candidates[0]
    const core = resolveCore(input, routes)
    if (candidate) {
      const diagnostics: ResolutionDiagnostic[] = []
      for (const shadowed of candidates.slice(1)) {
        diagnostics.push({ type: "shadowed", winner: candidate, shadowed })
      }
      if (core.status === "matched") {
        diagnostics.push({
          type: "shadowed",
          winner: candidate,
          shadowed: { id: core.command.id, path: core.route, provenance: core.command.provenance },
        })
      }
      return { status: "upstream", candidate, arguments: rawArguments(input, candidate.path), diagnostics }
    }
    if (core.status === "matched") return { status: "core", resolution: core, diagnostics: [] }
    return { status: "passthrough", input, diagnostics: [] }
  }
}

type Token = { value: string; start: number; end: number }

function scanFirstLine(input: string) {
  const newline = input.indexOf("\n")
  const end = newline === -1 ? input.length : newline
  const tokens: Token[] = []
  const matcher = /[^\t\v\f\r ]+/g
  const line = input.slice(0, end)
  for (const match of line.matchAll(matcher)) {
    const start = match.index
    tokens.push({ value: match[0], start, end: start + match[0].length })
  }
  return tokens
}

function matchRoute(path: readonly string[], tokens: readonly Token[]): number | undefined {
  if (tokens.length < path.length) return undefined
  const matched = path.every((token, index) => tokens[index]?.value === (index === 0 ? `/${token}` : token))
  if (!matched) return undefined
  return tokens[path.length - 1]?.end
}

function skipOneSeparator(input: string, offset: number) {
  const match = /^[\t\v\f\r\n ]+/.exec(input.slice(offset))
  if (!match) return offset
  return offset + match[0].length
}

function rawArguments(input: string, path: readonly string[]): RawArguments {
  const consumed = matchRoute(path, scanFirstLine(input)) ?? input.length
  const start = skipOneSeparator(input, consumed)
  return { source: input, value: input.slice(start), range: { start, end: input.length } }
}
