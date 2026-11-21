# Channel logos

The channel cards on the home page show each platform's official mark, to say "channelstack works
with this platform". Every file here is the unmodified official file, byte for byte, taken from the
company's own brand or media kit on 2026-11-20.

| File | Channel | Official source | Original file name | Used on |
|---|---|---|---|---|
| `slack.svg` | Slack | Media kit linked from https://slack.com/media-kit | `SLA-Slack-icon-RGB.svg` | light and dark |
| `github.svg` | GitHub | https://brand.github.com/GitHub_Logos.zip | `GitHub_Invertocat_Black.svg` | light |
| `github-white.svg` | GitHub | https://brand.github.com/GitHub_Logos.zip | `GitHub_Invertocat_White.svg` | dark |
| `linear.svg` | Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip | `logo-dark.svg` | light |
| `linear-light.svg` | Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip | `logo-light.svg` | dark |
| `notion.svg` | Notion | `NotionLogoFiles.zip` on https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286 | `notion-logo-block-main.svg` | light and dark |

## Guidelines

Summaries are paraphrased; read the linked page before changing how a mark is used.

| Channel | Guidelines | What they say about "works with" use on a third-party site |
|---|---|---|
| Slack | https://slack.com/terms-of-service/slack-brand | Text statements that an app integrates with Slack are allowed. The terms say not to use the Slack logo without a licence; other uses need a request to Slack with a mockup. |
| GitHub | https://brand.github.com/foundations/logo, https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy | "Show integration" is listed as an allowed use of a permitted logo; the same page also asks for prior written permission. Black or white mark only. |
| Linear | https://linear.app/brand | Allowed when the file is unaltered, has room around it and implies no endorsement. |
| Notion | https://notion.notion.site/Notion-s-brand-usage-guidelines-How-to-use-Notion-s-brand-in-your-marketing-689045e1761348f887a3c5c80295e00f | Text statements that an integration works with Notion are allowed. The guidelines say not to use the standalone Notion logo. |

**Decision.** The maintainer chose to show all four marks on the channel cards, knowing that
Slack's and Notion's guidelines don't grant this use and GitHub's are ambiguous. Asking Slack and
Notion for permission, or replacing those two marks with names, are the ways to close that gap.

## How the marks are shown

- Unmodified files, rendered with `<img>` at 32 px: no recolouring, cropping, rotation, effects or animation of a mark.
- "Works with" use only: one mark per channel card, next to the platform's name, smaller than channelstack's own branding.
- GitHub and Linear use their official dark-background files in the dark theme; Slack and Notion have one file for both.
- The footer states that channelstack is not affiliated with or endorsed by these companies and that the names and logos are their trademarks (`src/components/Footer.tsx`).
