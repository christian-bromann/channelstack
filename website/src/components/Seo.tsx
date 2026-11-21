import { Head } from "vite-react-ssg";
import { SITE } from "../lib/site";

/** Title, description, canonical URL and social tags for one page. `path` starts with "/". */
export function Seo({ title, description = SITE.description, path, noindex = false }: { title: string; description?: string; path: string; noindex?: boolean }) {
  const url = SITE.url + (path === "/" ? "" : path);
  const image = `${SITE.url}/og.png`;
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      {noindex ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={url} />}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE.name} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="channelstack: your agent's whole world, on localhost." />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
    </Head>
  );
}
