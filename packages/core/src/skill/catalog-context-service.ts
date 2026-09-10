export * as SkillCatalogContextService from "./catalog-context-service"

import { Context, Effect } from "effect"
import { Skill } from "@opencode-ai/schema/skill"

// Session imports this contract without pulling the Plugin implementation graph into its bundle cycle.
export interface Loaded {
  readonly snapshot: Skill.RegistrySnapshot
  readonly diagnostics: ReadonlyArray<Skill.ActivationDiagnostic>
  readonly transient: boolean
}

export interface Interface {
  readonly load: (input: { readonly forceReload: boolean }) => Effect.Effect<Loaded>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillCatalogContext") {}
