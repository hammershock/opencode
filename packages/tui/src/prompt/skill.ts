import { displayOffsetIndex } from "./display"
import type { PromptInfo } from "./history"

export type SkillCatalogEntry = {
  id: string
  name: string
  description?: string
  sourceLabel: string
  digest: string
}

export function skillDisplayLabel(skill: SkillCatalogEntry, catalog: readonly SkillCatalogEntry[]) {
  return `$${skill.name}${catalog.filter((candidate) => candidate.name === skill.name).length > 1 ? ` · ${skill.sourceLabel}` : ""}`
}

export function skillCatalogInput<T extends { readonly sessionID?: string; readonly agent?: string }>(
  visible: boolean,
  input: T,
) {
  if (!visible) return
  if (!input.sessionID && !input.agent) return
  return input
}

export function admittedSkills(
  catalog: readonly SkillCatalogEntry[],
  admitted: { readonly skills: readonly SkillCatalogEntry[] } | null | undefined,
) {
  if (!admitted) return []
  const identities = new Map(admitted.skills.map((skill) => [skill.id, skill]))
  return catalog.filter((skill) => {
    const expected = identities.get(skill.id)
    return (
      expected?.name === skill.name && expected.sourceLabel === skill.sourceLabel && expected.digest === skill.digest
    )
  })
}

export function structuredSkillMentions(input: string, parts: readonly PromptInfo["parts"][number][]) {
  return structuredMentions(input, parts).map((item) => item.mention)
}

export function bareSkillMentions(input: string, parts: readonly PromptInfo["parts"][number][]) {
  const occupied = structuredMentions(input, parts)
  const result: {
    name: string
    source: { start: number; end: number; text: string }
    display: { start: number; end: number }
  }[] = []
  let fence: number | undefined

  for (let index = 0; index < input.length; index++) {
    if (input[index] === "`" && !escaped(input, index)) {
      const run = input.slice(index).match(/^`+/)![0].length
      if (fence === undefined) fence = run
      else if (fence === run) fence = undefined
      index += run - 1
      continue
    }
    if (fence !== undefined || input[index] !== "$" || escaped(input, index)) continue
    if (occupied.some((item) => item.rawStart <= index && index < item.rawEnd)) continue

    const before = index === 0 ? undefined : Array.from(input.slice(0, index)).at(-1)
    if (before && /[\p{L}\p{M}\p{N}_@-]/u.test(before)) continue
    const match = input.slice(index).match(/^\$([a-z0-9]+(?:-[a-z0-9]+)*)/)
    if (!match) continue
    const rawEnd = index + match[0].length
    const after = input.slice(rawEnd).match(/^./u)?.[0]
    if (after && /[\p{L}\p{M}\p{N}_@-]/u.test(after)) continue

    const start = expandedOffset(input, parts, index)
    result.push({
      name: match[1],
      source: { start, end: expandedOffset(input, parts, rawEnd), text: match[0] },
      display: { start: index, end: rawEnd },
    })
    index = rawEnd - 1
  }

  return result
}

export function resolveSkillMentions(
  input: string,
  parts: readonly PromptInfo["parts"][number][],
  catalog: readonly SkillCatalogEntry[],
) {
  const explicit = structuredSkillMentions(input, parts)
  const byName = Map.groupBy(catalog, (skill) => skill.name)
  const bare = bareSkillMentions(input, parts)
  const ambiguous = bare.find((mention) => (byName.get(mention.name)?.length ?? 0) > 1)
  if (ambiguous) return { mentions: explicit, ambiguous }

  const mentions = [
    ...explicit,
    ...bare.flatMap((mention) => {
      const matches = byName.get(mention.name)
      if (matches?.length !== 1) return []
      return [{ id: matches[0].id, name: mention.name, source: mention.source }]
    }),
  ].sort((a, b) => a.source.start - b.source.start)
  const seen = new Set<string>()
  return {
    mentions: mentions.filter((mention) => {
      if (seen.has(mention.id)) return false
      seen.add(mention.id)
      return true
    }),
  }
}

export async function resolveSubmittedSkillMentions(input: {
  text: string
  parts: readonly PromptInfo["parts"][number][]
  shell: boolean
  load: () => Promise<SkillCatalogEntry[] | undefined>
  show: (source: { start: number; end: number }) => void
}) {
  const bare = input.shell ? [] : bareSkillMentions(input.text, input.parts)
  const catalog = bare.length ? await input.load() : []
  if (!catalog) return undefined
  const resolution = resolveSkillMentions(input.text, input.parts, catalog)
  if (!resolution.ambiguous) return resolution.mentions
  input.show(resolution.ambiguous.display)
  return undefined
}

function structuredMentions(input: string, parts: readonly PromptInfo["parts"][number][]) {
  return parts
    .filter((part) => part.type === "skill")
    .flatMap((part) => {
      const rawStart = displayOffsetIndex(input, part.source.start)
      const rawEnd = displayOffsetIndex(input, part.source.end)
      if (input.slice(rawStart, rawEnd) !== part.source.value) return []
      const start = expandedOffset(input, parts, rawStart)
      return [
        {
          rawStart,
          rawEnd,
          mention: {
            id: part.id,
            name: part.name,
            source: { start, end: start + part.source.value.length, text: part.source.value },
          },
        },
      ]
    })
}

function expandedOffset(input: string, parts: readonly PromptInfo["parts"][number][], rawOffset: number) {
  return parts
    .filter(
      (part) =>
        part.type === "text" && part.source?.text && displayOffsetIndex(input, part.source.text.start) < rawOffset,
    )
    .reduce(
      (offset, part) =>
        offset + (part.type === "text" && part.source?.text ? part.text.length - part.source.text.value.length : 0),
      rawOffset,
    )
}

function escaped(input: string, index: number) {
  let count = 0
  while (index - count - 1 >= 0 && input[index - count - 1] === "\\") count++
  return count % 2 === 1
}
