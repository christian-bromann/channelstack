# Logos

Third-party logos on the site, each the unmodified official file, byte for byte, taken from its
owner's own brand or media kit on 2026-11-20 (Resend's on 2026-11-25, Discord's on 2026-11-27): the six platform marks on
the channel cards of the home page, to say "channelstack works with this platform". The example
player's language switch names its languages (TypeScript, Python, Rust) in text, with a dot in each
one's GitHub colour, so it shows no logos.

| File | Used for | Official source | Path inside the kit | Used on | SHA-256 |
|---|---|---|---|---|---|
| `slack.svg` | Slack | Media kit linked from https://slack.com/media-kit | `SLA-Slack-icon-RGB.svg` | light and dark | `08f20f65a7d900c40358ca441caa7b834d82083356aa40d1f17d0844e8b3f73f` |
| `github.svg` | GitHub | https://brand.github.com/GitHub_Logos.zip | `GitHub Logos/SVG/GitHub_Invertocat_Black.svg` | light | `693d7abe6f899646cc2e96856723b45e95f71885a54910b2749f6decdf7e1ee1` |
| `github-white.svg` | GitHub | https://brand.github.com/GitHub_Logos.zip | `GitHub Logos/SVG/GitHub_Invertocat_White.svg` | dark | `ccd84c89b1056345608fc3489357f8acc7397e49a3cdc2d418b6c8016911d47b` |
| `linear.svg` | Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip | `logo-dark.svg` | light | `e683e95a5eb9b360ae06360c0350fd1b5fcf3d2222ef9de8e71fa0bc413dccc3` |
| `linear-light.svg` | Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip | `logo-light.svg` | dark | `32f9883452188b39787f8242c7bfce723ded255f35f13254e727871d3dae2fd1` |
| `notion.svg` | Notion | `NotionLogoFiles.zip` on https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286 | `notion-logo-block-main.svg` | light and dark | `840a6f78e87f39cc4a4b0743a00cc6fd82c07ba5dc51d778d7976b6575bcf4fb` |
| `resend.svg` | Resend | https://cdn.resend.com/brand/resend-brand-assets.zip, linked from https://resend.com/brand | `resend-brand-assets/resend-icon-black.svg` | light | `7251dba7137e25a4117154bfdaef8333128a9dcc67446912ddcf6d6048573b12` |
| `resend-white.svg` | Resend | https://cdn.resend.com/brand/resend-brand-assets.zip, linked from https://resend.com/brand | `resend-brand-assets/resend-icon-white.svg` | dark | `9d6a386b319b8d0f421918e270f843d9996e31021fad9e41bc4c10a8882b9908` |
| `discord.svg` | Discord | https://cdn.discordapp.com/assets/content/a736b95923ddbc155e828651c92471292e40727655d770a06cec89c48ba0b41f.zip, the Symbol's colour kit linked from https://discord.com/branding | `Discord_Symbol_Color/Discord-Symbol-Blurple.svg` | light and dark | `d06eaa51e78a9984ebbd3fbc82f0245ac2ecb5bf0150f537204397c1da5c7bd8` |

To re-check a file, download the kit, and compare `shasum -a 256` of the file at that path with the sum above.

## Guidelines

Summaries are paraphrased; read the linked page before changing how a mark is used.

| Owner | Guidelines | What they say about this use on a third-party site |
|---|---|---|
| Slack | https://slack.com/terms-of-service/slack-brand | Text statements that an app integrates with Slack are allowed. The terms say not to use the Slack logo without a licence; other uses need a request to Slack with a mockup. |
| GitHub | https://brand.github.com/foundations/logo, https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy | "Show integration" is listed as an allowed use of a permitted logo; the same page also asks for prior written permission. Black or white mark only. |
| Linear | https://linear.app/brand | Allowed when the file is unaltered, has room around it and implies no endorsement. |
| Notion | https://notion.notion.site/Notion-s-brand-usage-guidelines-How-to-use-Notion-s-brand-in-your-marketing-689045e1761348f887a3c5c80295e00f | Text statements that an integration works with Notion are allowed. The guidelines say not to use the standalone Notion logo. |
| Discord | https://discord.com/branding ("Legal Brand Guidelines") | The logo may be used in colour, black or white, unedited ("do not edit, change, distort, recolor, or reconfigure"), digitally, to say you use Discord, without implying sponsorship; the Symbol is for where the Discord brand is clear, as on a card that names it. Not in a product's own name or logo. |
| Resend | https://resend.com/brand | Use the files unaltered. The page recommends the wordmark "for stronger brand recognition"; the kit's icon is used here because every card shows a square mark next to the platform's name. |

**Decision.** The maintainer chose to show all six marks on the channel cards, knowing that
Slack's and Notion's guidelines don't grant this use and GitHub's are ambiguous. Asking Slack and
Notion for permission, or replacing those two marks with names, are the ways to close that gap.

## How the marks are shown

- Unmodified files, rendered with `<img>` at 32 px: no recolouring, cropping, rotation, effects or animation of a mark.
- "Works with" use only: one platform mark per channel card, next to the platform's name, and nowhere else on the site.
- GitHub, Linear and Resend use their official dark-background files in the dark theme; Slack, Notion and Discord (its blurple Symbol) have one file for both.
- The footer states that channelstack is not affiliated with or endorsed by the six platforms, and that all names and logos shown, including TypeScript (Microsoft), Python (Python Software Foundation) and Rust (Rust Foundation), are trademarks of their owners (`src/components/Footer.tsx`).
