# Channel logos

**No logo files are shipped yet.** The channel cards on the home page show names only. This file
records where each official mark comes from and what its owner's guidelines say about showing it
on a third-party "works with" page, as read on 2026-11-20. Re-read the linked pages before
adding a logo: the summaries below are paraphrased.

To add a logo: put the unmodified official SVG in this folder, add it to `LOGOS` in
`src/pages/Home.tsx` (one file for light backgrounds, one for dark), and update this table.

| Channel | Official source of the mark | Guidelines | "Works with" use without written permission | Status |
|---|---|---|---|---|
| Slack | Media kit linked from https://slack.com/media-kit (`SLA-Slack-icon-RGB.svg`) | https://slack.com/terms-of-service/slack-brand | No. The brand terms say not to use the Slack logo; saying in text that an app integrates with Slack is allowed. Other uses need a request to Slack with a mockup. | Not used |
| Notion | `NotionLogoFiles.zip` on https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286 (`notion-logo-block-main.svg`) | https://notion.notion.site/Notion-s-brand-usage-guidelines-How-to-use-Notion-s-brand-in-your-marketing-689045e1761348f887a3c5c80295e00f | No. The guidelines say not to use the standalone Notion logo; stating in text that an integration works with Notion is allowed. | Not used |
| GitHub | https://brand.github.com/GitHub_Logos.zip (`GitHub_Invertocat_Black.svg`, `GitHub_Invertocat_White.svg`) | https://brand.github.com/foundations/logo and https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy | Unclear. "Show integration" is listed as an allowed use, but the same page asks for prior written permission. | Not used, pending a decision |
| Linear | https://static.linear.app/design-assets/Linear-Brand-Assets.zip (`logo-dark.svg`, `logo-light.svg`) | https://linear.app/brand | Yes, when the file is unaltered, has room around it and implies no endorsement. | Not used, to keep the row consistent |

## Rules to follow when a logo is added

- Use the official file byte for byte: no recolouring, cropping, rotation, effects or animation of the mark itself.
- GitHub: black or white mark only, whichever contrasts best; keep it less prominent than channelstack's own name.
- Linear: the dark mark (`#222326`) on light backgrounds, the light mark on dark backgrounds.
- Keep the non-affiliation and trademark line in the footer (`src/components/Footer.tsx`).
