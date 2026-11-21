/** A modal with one required text input, as the Bolt receivers in the delivery tests open it. */
export const SUMMARY_VIEW = {
  type: "modal" as const,
  callback_id: "incident",
  title: { type: "plain_text" as const, text: "File an incident" },
  submit: { type: "plain_text" as const, text: "File" },
  blocks: [
    {
      type: "input",
      block_id: "summary",
      label: { type: "plain_text", text: "Summary" },
      element: { type: "plain_text_input", action_id: "text" },
    },
  ],
};
