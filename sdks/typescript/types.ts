/**
 * The contract's type names (`api/*.d.ts`) that the generated SDK has no type of its own for: unions
 * of its handles, the option bags of its methods, and the values of its fields. Each one is read
 * from the generated code, so it can't drift from it. With them, `import type { AuthorRef } from
 * "channelstack"` works as the contract says.
 *
 * Not here: the test framework's own types (`ChannelstackFixture`, `ChannelstackIntegrationOptions`,
 * `ChannelstackMatchers`, `TextOptions`, in `channelstack/vitest`), and `SlackInjectedFault`, which
 * the SDK calls `SlackFault` (#37).
 */
import type * as G from "./generated/index.ts";

type Option<Method extends (...args: never[]) => unknown> = NonNullable<Parameters<Method>[0]>;

export type ChannelKind = "slack" | "github" | "linear" | "notion";
/** Text that may contain `@name` mentions. */
export type RichText = string;
/** ISO 8601 timestamp string. */
export type Timestamp = string;

export type SlackParticipant = G.SlackUser | G.SlackApp;
export type GitHubAuthor = G.GitHubUser | G.GitHubApp;
export type LinearAuthor = G.LinearUser | G.LinearApp;
export type NotionAuthor = G.NotionUser | G.NotionIntegration;

export type User = G.SlackUser | G.GitHubUser | G.LinearUser | G.NotionUser;
export type App = G.SlackApp | G.GitHubApp | G.LinearApp | G.NotionIntegration;
export type Principal = User | App;
/** Anything that can be named as an author in a matcher: a handle or its `name`. */
export type AuthorRef = Principal | string;
export type Resource = G.SlackConversation | G.GitHubRepo | G.LinearTeam | G.NotionPage | G.NotionDatabase;

type AnyDelivery = G.SlackDelivery | G.GitHubDelivery | G.LinearDelivery | G.NotionDelivery;
/** A delivery of any channel, narrowed by its `type` and `payload` as the contract's `Delivery<TType, TPayload>` is. */
export type Delivery<TType extends string = string, TPayload = unknown> = AnyDelivery & {
  readonly type: TType;
  readonly payload: TPayload;
};
export type DeliveryStatus = Delivery["status"];
export type DeliveryTransport = G.DeliveryAttempt["transport"];
export type SlackDeliveryType = G.SlackDelivery["type"];
export type ResendOptions = Option<G.GitHubDelivery["resend"]>;
export type SlackResendOptions = Option<G.SlackDelivery["resend"]>;
export type LinearResendOptions = Option<G.LinearDelivery["resend"]>;
export type DeliveryFilter =
  Option<G.GitHubFixture["deliveries"]> | Option<G.LinearFixture["deliveries"]> | Option<G.NotionFixture["deliveries"]>;

export type ApiCall = G.SlackApiCall | G.GitHubApiCall | G.LinearApiCall | G.NotionApiCall;
export type ApiCallFilter = Option<G.SlackFixture["calls"]>;
/** What every channel fixture has to inspect what the agent did: the fixture whose deliveries are `TDelivery`. */
export type Inspectable<TDelivery extends Delivery = Delivery> = TDelivery extends G.SlackDelivery
  ? G.SlackFixture
  : TDelivery extends G.GitHubDelivery
    ? G.GitHubFixture
    : TDelivery extends G.LinearDelivery
      ? G.LinearFixture
      : TDelivery extends G.NotionDelivery
        ? G.NotionFixture
        : never;

export type Transcript = G.SlackTranscript | G.GitHubTranscript | G.LinearTranscript | G.NotionTranscript;
export type TranscriptEntry = Transcript["entries"][number];
export type HasTranscript = { transcript(): Promise<Transcript> };
export type SlackHasTranscript = { transcript(options?: { as?: SlackParticipant }): Promise<G.SlackTranscript> };

export type SlackUserOptions = Option<G.SlackFixture["createUser"]>;
export type SlackChannelOptions = Option<G.SlackFixture["createChannel"]>;
export type GitHubUserOptions = Option<G.GitHubFixture["createUser"]>;
export type GitHubRepoOptions = Option<G.GitHubFixture["createRepo"]>;
export type GitHubChanges = Parameters<G.GitHubUser["push"]>[0];
export type LinearUserOptions = Option<G.LinearFixture["createUser"]>;
export type LinearTeamOptions = Option<G.LinearFixture["createTeam"]>;
export type LinearStateType = G.LinearIssueState["type"];
export type LinearPriority = NonNullable<Parameters<G.LinearUser["createIssue"]>[0]["priority"]>;
export type LinearSessionState = Awaited<ReturnType<G.LinearAgentSession["state"]>>;
export type LinearActivityType = G.LinearAgentActivity["type"];
export type NotionUserOptions = Option<G.NotionFixture["createUser"]>;
export type NotionPageOptions = Option<G.NotionFixture["createPage"]>;
export type NotionDatabaseOptions = Option<G.NotionFixture["createDatabase"]>;
