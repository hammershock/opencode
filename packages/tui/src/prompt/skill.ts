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

export function structuredSkillMentions(input: string, parts: readonly PromptInfo["parts"][number][]) {
  return parts
    .filter((part) => part.type === "skill")
    .flatMap((part) => {
      const rawStart = displayOffsetIndex(input, part.source.start)
      const rawEnd = displayOffsetIndex(input, part.source.end)
      if (input.slice(rawStart, rawEnd) !== part.source.value) return []
      const start = parts
        .filter(
          (candidate) =>
            candidate.type === "text" &&
            candidate.source?.text &&
            displayOffsetIndex(input, candidate.source.text.start) < rawStart,
        )
        .reduce(
          (offset, candidate) =>
            offset +
            (candidate.type === "text" && candidate.source?.text
              ? candidate.text.length - candidate.source.text.value.length
              : 0),
          rawStart,
        )
      return [
        {
          id: part.id,
          name: part.name,
          source: { start, end: start + part.source.value.length, text: part.source.value },
        },
      ]
    })
}
import { displayOffsetIndex } from "./display"
import type { PromptInfo } from "./history"
