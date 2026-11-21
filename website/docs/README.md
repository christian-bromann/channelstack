# Docs pages

Every `.md` or `.mdx` file in this folder is a page under `/docs`. The file name is the URL (`slack.mdx` → `/docs/slack`; `index.mdx` is `/docs`).

Frontmatter drives the sidebar, so adding a page needs no code change:

```yaml
---
title: Slack          # sidebar label and page title
order: 2              # position in the sidebar, ascending
description: …        # meta description (optional)
---
```

Fenced code blocks are highlighted at build time (`ts`, `tsx`, `js`, `python`, `bash`, `json`, `yaml`, `diff`).
