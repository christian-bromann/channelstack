import { Head } from "vite-react-ssg";

// Imported, not served from public/, so the URL carries a content hash: when the image changes,
// its URL changes, and link previews that cache by URL show the new one.
import ogImage from "../assets/og.png";
import { SITE } from "../lib/site";

const IMAGE_ALT =
  "channelstack: your agent's whole world, on localhost. Test AI agents in Slack, GitHub, Linear and Notion.";

/**
 * Title, description, canonical URL and link-preview tags for one page. `path` starts with "/".
 * Pass `structured` on the home page to describe the site and the software to search engines.
 */
export function Seo({
  title,
  description = SITE.description,
  path,
  noindex = false,
  structured = false,
}: {
  title: string;
  description?: string;
  path: string;
  noindex?: boolean;
  structured?: boolean;
}) {
  const url = SITE.url + (path === "/" ? "" : path);
  const image = SITE.url + ogImage;
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      {noindex ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={url} />}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE.name} />
      <meta property="og:locale" content="en_US" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={IMAGE_ALT} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
      <meta name="twitter:image:alt" content={IMAGE_ALT} />
      {structured ? (
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebSite", "@id": `${SITE.url}/#website`, url: SITE.url, name: SITE.name, description },
              {
                "@type": "SoftwareApplication",
                name: SITE.name,
                url: SITE.url,
                description,
                image,
                applicationCategory: "DeveloperApplication",
                operatingSystem: "macOS, Linux, Windows",
                license: "https://opensource.org/license/mit",
                codeRepository: SITE.repo,
              },
            ],
          })}
        </script>
      ) : null}
    </Head>
  );
}
