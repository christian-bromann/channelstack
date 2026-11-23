/** A refusal of the API, in Notion's error shape: `validation_error`, `object_not_found`, … */
export class NotionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A list's paging as a request gives it: refused when the cursor names nothing, or the size isn't 1 to 100. */
export function pagingOf(query: { start_cursor?: unknown; page_size?: unknown }): {
  start_cursor?: string;
  page_size?: number;
} {
  const size = query.page_size;
  if (size !== undefined && (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 100))
    throw new NotionApiError(
      400,
      "validation_error",
      "body failed validation: page_size should be a number from 1 to 100.",
    );
  if (query.start_cursor !== undefined && typeof query.start_cursor !== "string")
    throw new NotionApiError(400, "validation_error", "body failed validation: start_cursor should be a string.");
  return {
    ...(query.start_cursor === undefined ? {} : { start_cursor: query.start_cursor as string }),
    ...(size === undefined ? {} : { page_size: size as number }),
  };
}
