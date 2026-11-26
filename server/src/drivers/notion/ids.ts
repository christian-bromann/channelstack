import { idFormats, LOWER_ALNUM, UPPER_ALNUM, uuid } from "../../core/ids/index.ts";

/**
 * Every id the Notion fake generates, in the platform's own format (architecture.md 3.2).
 */
export const NOTION_IDS = idFormats("notion", {
  uuid: uuid,
  // A database property's id: four characters, URL-encoded as the API hands them out (`%3DkLq`).
  propertyId: {
    pattern: /^(?:%[0-9A-F]{2}|[A-Za-z0-9]){4}$/,
    accepts: /^(?:%[0-9A-F]{2}|[A-Za-z0-9_.~-])+$/,
    generate: (draw) => encodeURIComponent(draw.chars(4, `${UPPER_ALNUM}${LOWER_ALNUM.slice(10)}:;<=>?@[]^`)),
  },
});
