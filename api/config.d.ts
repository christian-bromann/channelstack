/**
 * `channelstack.config.ts`: describes only the agent's app on each channel.
 * No users, channels, repos or pages; tests create those themselves.
 */

export interface ChannelstackConfig {
  slack?: SlackConfig;
  github?: GitHubConfig;
  linear?: LinearConfig;
  notion?: NotionConfig;
  server?: ServerConfig;
}

export interface ServerConfig {
  /** Serve through portless as `*.localhost` (default) or on plain ports. */
  portless?: boolean;
  /** Without portless: the single port for all channels. Default 4500. */
  port?: number;
  /** Serve plain HTTP instead of HTTPS. */
  tls?: boolean;
  /** Default timeout for matchers and waits. Default "10s". */
  timeout?: import("./common").Duration;
  /** Default quiet window for negative and exact-count matchers. Default "750ms". */
  quietFor?: import("./common").Duration;
}

// ---------------------------------------------------------------------------

export interface SlackConfig {
  /** Workspace display name. Default "Acme". */
  workspace?: string;
  app: SlackAppConfig;
}

/** Credentials that make an app real (live). Without them the app is fake. Also read from `CHANNELSTACK_<CHANNEL>_*` env vars. */
export interface SlackLiveApp {
  appId?: string;
  botToken?: string;
}

export type SlackAppConfig = { name: string } & SlackLiveApp & (
  | {
      /** Path to the app's real manifest (YAML or JSON). Scopes, events and URLs come from it. */
      manifest: string;
      /** Override the URLs in the manifest, e.g. to point at `https://my-agent.localhost`. */
      urls?: Partial<SlackAppUrls>;
    }
  | {
      manifest?: undefined;
      scopes: { bot: string[]; user?: string[] };
      /** Event types the app subscribes to, e.g. `app_mention`, `message.im`. */
      botEvents: string[];
      /** Use Socket Mode instead of HTTP delivery. Then `urls` is not needed. */
      socketMode?: boolean;
      urls?: Partial<SlackAppUrls>;
      /** Enable the agent/assistant split view (`assistant_thread_started` etc.). */
      agentView?: boolean;
      slashCommands?: Array<{ command: string; description?: string; url?: string }>;
    }
);

export interface SlackAppUrls {
  /** Events API Request URL. */
  events: string;
  /** Interactivity Request URL (block_actions, view_submission). */
  interactivity: string;
  /** OAuth redirect URL, if the agent runs the install flow itself. */
  redirect: string;
}

// ---------------------------------------------------------------------------

export interface GitHubConfig {
  /** Organization login every created repo belongs to by default. Default "acme". */
  org?: string;
  app: GitHubAppConfig;
}

export type GitHubPermissionLevel = "read" | "write" | "admin";

export interface GitHubAppConfig {
  /** App slug; its bot is `<name>[bot]`. */
  name: string;
  /** Live: a real GitHub App installed on a test org. */
  appId?: number;
  privateKey?: string;
  /** Webhook URL. Omit for apps that only call the API (no events). */
  webhook?: string;
  /** Repository and organization permissions, as in the real app settings. */
  permissions: Partial<Record<
    | "contents" | "issues" | "pull_requests" | "checks" | "statuses" | "metadata"
    | "actions" | "discussions" | "members" | "workflows",
    GitHubPermissionLevel
  >>;
  /** Webhook events the app subscribes to, e.g. `issue_comment`, `pull_request_review_comment`. */
  events: string[];
}

// ---------------------------------------------------------------------------

export interface LinearConfig {
  /** Workspace display name. Default "Acme". */
  workspace?: string;
  app: LinearAppConfig;
}

export interface LinearAppConfig {
  name: string;
  /** Live: the real OAuth app's credentials. */
  clientId?: string;
  clientSecret?: string;
  webhook: string;
  /** Install as an agent (`actor=app`), so it can be mentioned and delegated to. Default true. */
  agent?: boolean;
  scopes?: Array<"read" | "write" | "issues:create" | "comments:create" | "app:assignable" | "app:mentionable">;
  /** Webhook resource types besides AgentSessionEvent, e.g. `Issue`, `Comment`. */
  resourceTypes?: string[];
}

// ---------------------------------------------------------------------------

export interface NotionConfig {
  /** Workspace display name. Default "Acme". */
  workspace?: string;
  integration: NotionIntegrationConfig;
}

export interface NotionIntegrationConfig {
  name: string;
  /** Live: the real integration's token. */
  token?: string;
  webhook?: string;
  /** Webhook event types, e.g. `comment.created`, `page.content_updated`. */
  events?: string[];
  capabilities?: Array<
    "read_content" | "update_content" | "insert_content" | "read_comments" | "insert_comments" | "read_user_info"
  >;
}

export declare function defineConfig(config: ChannelstackConfig): ChannelstackConfig;
