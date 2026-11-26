import type { Hono } from "hono";

import { iso } from "../../../core/clock/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { resendDownloadSignature } from "../signing.ts";
import type { ResendEmailRecord } from "../world.ts";
import type { ResendStore } from "./store.ts";

/** How long a download link works: an hour, as Resend's (found against Resend). */
const LINK_MS = 3_600_000;
/** Where the links are served, on the fake's own host: Resend's CDN (`cdn.resend.app`) is another host. */
const PREFIX = "/_cdn";

/** A link to what the API doesn't answer itself, as Resend's answers carry one. */
export interface DownloadLink {
  readonly download_url: string;
  readonly expires_at: string;
}

/** What a link opens: an email's raw message, or one of its attachments by id. */
type File = "raw" | { readonly attachment: string };

/**
 * Resend's download links, as its CDN serves them: a received email's raw message and every
 * email's attachments, signed and working for an hour, opened without the API key.
 */
export function createDownloads(context: DriverContext, store: ResendStore) {
  const { clock } = context;
  const pathOf = (email: ResendEmailRecord, file: File) =>
    `${PREFIX}/${email.id}/${file === "raw" ? "raw" : file.attachment}`;
  const signature = (path: string, expires: number) =>
    resendDownloadSignature(context.secret("downloadKey"), path, expires);

  /** What a path opens, if the email and its file are there. */
  const open = (email: ResendEmailRecord | undefined, name: string) => {
    if (email === undefined) return undefined;
    if (name === "raw") {
      return email.raw === undefined
        ? undefined
        : { bytes: Buffer.from(email.raw, "utf8"), type: "application/octet-stream", filename: email.id };
    }
    const attachment = email.attachments.find((each) => each.id === name);
    return attachment?.content === undefined
      ? undefined
      : { bytes: Buffer.from(attachment.content), type: attachment.contentType, filename: attachment.filename };
  };

  return {
    /** A link to an email's raw message or one of its attachments, working for an hour from now. */
    link(email: ResendEmailRecord, file: File): DownloadLink {
      const path = pathOf(email, file);
      // In whole seconds, as the link's `Expires`: `expires_at` is the moment it stops working.
      const expires = Math.floor((clock() + LINK_MS) / 1000);
      const url = new URL(`${context.apiUrl()}${path}`);
      url.searchParams.set("Expires", String(expires));
      url.searchParams.set("Signature", signature(path, expires));
      return { download_url: url.toString(), expires_at: iso(expires * 1000) };
    },

    /**
     * Serve what the links open. A link that is changed, or used after it expired, is refused as a
     * CDN refuses it (403 `AccessDenied`); the API key isn't asked for, and no API call is on record.
     */
    serve(api: Hono): void {
      api.get(`${PREFIX}/:email/:file`, (c) => {
        const path = `${PREFIX}/${c.req.param("email")}/${c.req.param("file")}`;
        const expires = Number(c.req.query("Expires"));
        const given = c.req.query("Signature") ?? "";
        const valid =
          Number.isInteger(expires) && constantTimeEqual(given, signature(path, expires)) && clock() < expires * 1000;
        if (!valid)
          return c.body("<Error><Code>AccessDenied</Code><Message>Access denied</Message></Error>", 403, {
            "content-type": "text/xml",
          });
        const found = open(store.emails.find(c.req.param("email")), c.req.param("file"));
        if (!found) return c.body("<Error><Code>NoSuchKey</Code></Error>", 404, { "content-type": "text/xml" });
        return c.body(found.bytes, 200, {
          "content-type": found.type,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
          "x-content-type-options": "nosniff",
        });
      });
    },
  };
}
