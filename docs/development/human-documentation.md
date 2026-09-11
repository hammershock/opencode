# Human-facing documentation

This standard governs documentation written for users, prospective contributors, and security reporters. RFCs continue to own durable product and architecture decisions; issues own task status; human-facing documents explain the current product without becoming a second roadmap or implementation ledger.

The English document is canonical. Public top-level documents should have a maintained Simplified Chinese peer using the `.zh.md` suffix. Internal development notes and RFCs do not require translation. The repository root keeps only `README.md` and `README.zh.md`; additional audience or task documentation belongs under `docs/`.

## README contract

The root README should let a new reader answer, in order:

1. What is this product?
2. How is it related to upstream OpenCode?
3. Why would I use it?
4. Which platforms and features are actually supported?
5. How do I install it and get help?

Keep the README focused on orientation and first use. Move detailed tutorials, architecture, troubleshooting, and protocol material into linked documents. The English and Chinese README must preserve the same product claims, limitations, links, and section order even when the prose is adapted rather than translated literally.

Every derivative-project README must place this statement, or a semantic equivalent, before the first installation command:

> OpenCode Transit is an independent project built on OpenCode. It is not developed, endorsed, or maintained by the OpenCode team and is not affiliated with them.

Link `OpenCode` to the upstream repository and retain upstream copyright and license attribution.

## Structure and claims

Use this default structure: brand header and language switch, one-sentence positioning, non-affiliation notice, meaningful badges, one overview visual, highlights, quick start, platform/support table, documentation and help, contributing, security, upstream credits, and license.

- Put the product's distinguishing behavior before exhaustive installation variants.
- Label experimental or beta features beside the first claim, not only in a footnote.
- Describe observed behavior and explicit support. Code paths, prototypes, or one successful local run do not establish platform support.
- State important exclusions where readers could reasonably infer them, especially security, synchronization, remote execution, and platform boundaries.
- Do not use absolute claims such as “secure”, “zero crash”, “zero configuration”, or “works everywhere” without a defined and continuously verified contract.
- Do not copy upstream marketing text when the fork behaves differently.

## Badges and visuals

Use at most four badges in the root README. Each badge must point to this fork and communicate an actionable fact such as the current release, CI state, license, or supported platforms. Do not display upstream CI, package-download, Discord, or release badges as if they described the fork.

Store durable visual assets in the repository and link them with relative paths. Prefer SVG for logos and diagrams and compressed WebP or PNG for screenshots. Provide useful alternative text and explicit display dimensions. Check the README in GitHub light and dark themes and at narrow widths.

Brand assets must be original and visibly distinct from upstream. Screenshots and recordings use sanitized fixtures: no credentials, tokens, private hostnames, personal paths, account identifiers, or production Session content. The root README should normally contain no more than one hero/overview visual and three feature visuals.

## Links, language, and accessibility

- Use descriptive link labels, stable relative links for repository files, and HTTPS for external sites.
- Do not link to planned pages or unpublished artifacts. Verify anchors and image paths before merge.
- Use plain, inclusive language, short sections, meaningful headings, and text alternatives that explain the information conveyed by an image.
- Avoid screenshots of text when normal Markdown communicates the same information.
- Update the canonical and translated public document in the same PR when a product claim, support promise, install command, or security route changes.

## Review checklist

- Claims match accepted RFCs and current verified behavior.
- The upstream relationship and non-affiliation notice are prominent.
- Installation commands target fork-owned artifacts and do not overwrite `opencode`.
- Supported platforms and feature maturity are explicit.
- English and Simplified Chinese public documents have semantic parity.
- Badges, links, anchors, images, alt text, and narrow-width rendering work.
- No secret, personal data, machine-specific path, or external login state appears.
- Contributor and security links point to the fork, not upstream.

## References

- [GitHub: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [Open Source Guides: Starting an Open Source Project](https://opensource.guide/starting-a-project/)
- [Standard Readme specification](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)
- [VSCodium](https://github.com/VSCodium/vscodium) for explicit derivative-project positioning
- [uv](https://github.com/astral-sh/uv), [aider](https://github.com/Aider-AI/aider), and [fzf](https://github.com/junegunn/fzf) for concise highlights and visual hierarchy
- [frp](https://github.com/fatedier/frp) for maintained English and Chinese entry points
