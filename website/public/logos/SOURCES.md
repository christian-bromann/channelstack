# Logos

Third-party logos on the site, each the unmodified official file, byte for byte, taken from its
owner's own brand or media kit on 2026-11-20:

- the four platform marks on the channel cards of the home page, to say "channelstack works with
  this platform";
- the TypeScript and Python marks on the language switch of the example player.

| File | Used for | Official source | Path inside the kit | Used on | SHA-256 |
|---|---|---|---|---|---|
| `slack.svg` | Slack | Media kit linked from https://slack.com/media-kit | `SLA-Slack-icon-RGB.svg` | light and dark | `08f20f65a7d900c40358ca441caa7b834d82083356aa40d1f17d0844e8b3f73f` |
| `github.svg` | GitHub | https://brand.github.com/GitHub_Logos.zip | `GitHub Logos/SVG/GitHub_Invertocat_Black.svg` | light | `693d7abe6f899646cc2e96856723b45e95f71885a54910b2749f6decdf7e1ee1` |
| `github-white.svg` | GitHub | https://brand.github.com/GitHub_Logos.zip | `GitHub Logos/SVG/GitHub_Invertocat_White.svg` | dark | `ccd84c89b1056345608fc3489357f8acc7397e49a3cdc2d418b6c8016911d47b` |
| `linear.svg` | Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip | `logo-dark.svg` | light | `e683e95a5eb9b360ae06360c0350fd1b5fcf3d2222ef9de8e71fa0bc413dccc3` |
| `linear-light.svg` | Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip | `logo-light.svg` | dark | `32f9883452188b39787f8242c7bfce723ded255f35f13254e727871d3dae2fd1` |
| `notion.svg` | Notion | `NotionLogoFiles.zip` on https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286 | `notion-logo-block-main.svg` | light and dark | `840a6f78e87f39cc4a4b0743a00cc6fd82c07ba5dc51d778d7976b6575bcf4fb` |
| `typescript.svg` | TypeScript (TS \| Py switch) | Asset pack on https://www.typescriptlang.org/branding/ | `ts-logo-128.svg` | light and dark | `25e995fa85ae9ff6b5749f4ffeb21b2fe71d74e9b8d8db8eac4b9732cd9ef287` |
| `python.svg` | Python (TS \| Py switch) | "SVG format of only two snakes" on https://www.python.org/community/logos/ | `python-logo-only.svg` | light and dark | `baec8662a1461c2cacc326b54d2727cb2f1ce07ba02d00f5b826d035104f649f` |

To re-check a file, download the kit, and compare `shasum -a 256` of the file at that path with the sum above.

## Guidelines

Summaries are paraphrased; read the linked page before changing how a mark is used.

| Channel | Guidelines | What they say about this use on a third-party site |
|---|---|---|
| Slack | https://slack.com/terms-of-service/slack-brand | Text statements that an app integrates with Slack are allowed. The terms say not to use the Slack logo without a licence; other uses need a request to Slack with a mockup. |
| GitHub | https://brand.github.com/foundations/logo, https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy | "Show integration" is listed as an allowed use of a permitted logo; the same page also asks for prior written permission. Black or white mark only. |
| Linear | https://linear.app/brand | Allowed when the file is unaltered, has room around it and implies no endorsement. |
| Notion | https://notion.notion.site/Notion-s-brand-usage-guidelines-How-to-use-Notion-s-brand-in-your-marketing-689045e1761348f887a3c5c80295e00f | Text statements that an integration works with Notion are allowed. The guidelines say not to use the standalone Notion logo. |
| TypeScript | https://www.typescriptlang.org/branding/ | Allowed: the blue mark is the logo to use when referring to TypeScript. Don't use it as your own product's logo, modify its shape or imply endorsement. |
| Python | https://www.python.org/community/logos/ and the PSF Trademark Usage Policy | Allowed: the PSF wants the logo used widely to indicate use of, or suitability for, Python. Ask first for derived versions. |

**Decision.** The maintainer chose to show all four marks on the channel cards, knowing that
Slack's and Notion's guidelines don't grant this use and GitHub's are ambiguous. Asking Slack and
Notion for permission, or replacing those two marks with names, are the ways to close that gap.

## How the marks are shown

- Unmodified files, rendered with `<img>` at 32 px: no recolouring, cropping, rotation, effects or animation of a mark.
- "Works with" use only: one platform mark per channel card, next to the platform's name, and nowhere else on the site.
- The TypeScript and Python marks appear only on the language switch of the example player, at 18 px, to name the language of the sample.
- GitHub and Linear use their official dark-background files in the dark theme; Slack and Notion have one file for both.
- The footer states that channelstack is not affiliated with or endorsed by these companies and that the names and logos are their trademarks (`src/components/Footer.tsx`).
