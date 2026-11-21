/**
 * The workflows the reference agents offer beyond chatting: a deploy that needs approval, an
 * incident form, a ticket for a message. Both agents show the same things and say the same
 * words; how they wire them up is each framework's own business.
 */

/** What "deploy web to staging" asks for. Without an environment, the person is asked to pick one. */
export function deployRequest(text: string): { service: string; environment?: string } | undefined {
  const match = /\bdeploy (\w+)(?: to (\w+))?/i.exec(text);
  return match?.[1] ? { service: match[1], ...(match[2] ? { environment: match[2] } : {}) } : undefined;
}

const ENVIRONMENTS = ["staging", "production"] as const;

export const texts = {
  askApproval: (service: string, environment: string) => `Deploy ${service} to ${environment}?`,
  askEnvironment: (service: string) => `Where should ${service} go?`,
  deploying: (service: string, environment: string) => `Deploying ${service} to ${environment}…`,
  mayNotApprove: "Only workspace admins may approve a deploy.",
  approved: "Approved.",
  askIncident: "I can file that. Open the form when you're ready.",
  incidentFiled: (severity: string, summary: string) => `${severity} incident filed: ${summary}`,
  ticketCreated: "Created ticket ENG-1025 for this message.",
  channelSummary: (name: string) => `Here's a summary of #${name}.`,
} as const;

/** The prompts the agent offers when someone opens its split view. */
export const SUGGESTED_PROMPTS = [
  { title: "What changed?", message: "What changed in this channel today?" },
  { title: "Summarize", message: "Summarize this channel" },
];

/** Block Kit for the approval question: one Approve button that carries what to deploy. */
export const approvalBlocks = (service: string, environment: string) => [
  { type: "section", text: { type: "mrkdwn", text: texts.askApproval(service, environment) } },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "approve_deploy",
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        value: `${service}:${environment}`,
      },
    ],
  },
];

/** Block Kit for choosing where a service goes. */
export const environmentBlocks = (service: string) => [
  {
    type: "section",
    block_id: `deploy:${service}`,
    text: { type: "mrkdwn", text: texts.askEnvironment(service) },
    accessory: {
      type: "static_select",
      action_id: "pick_environment",
      placeholder: { type: "plain_text", text: "Environment" },
      options: ENVIRONMENTS.map((name) => ({ text: { type: "plain_text", text: name }, value: name })),
    },
  },
];

/** Block Kit for the offer to open the incident form. */
export const incidentOfferBlocks = () => [
  { type: "section", text: { type: "mrkdwn", text: texts.askIncident } },
  {
    type: "actions",
    elements: [{ type: "button", action_id: "open_incident_form", text: { type: "plain_text", text: "Open form" } }],
  },
];

/** The incident form. `channel` is where the result is announced; it rides along as `private_metadata`. */
export const incidentView = (channel: string) => ({
  type: "modal" as const,
  callback_id: "incident",
  private_metadata: channel,
  title: { type: "plain_text" as const, text: "File an incident" },
  submit: { type: "plain_text" as const, text: "File" },
  close: { type: "plain_text" as const, text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: "severity",
      label: { type: "plain_text", text: "Severity" },
      element: {
        type: "static_select",
        action_id: "value",
        options: ["SEV1", "SEV2", "SEV3"].map((name) => ({ text: { type: "plain_text", text: name }, value: name })),
      },
    },
    {
      type: "input",
      block_id: "summary",
      label: { type: "plain_text", text: "Summary" },
      element: { type: "plain_text_input", action_id: "value" },
    },
  ],
});
