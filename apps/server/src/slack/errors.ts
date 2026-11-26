// Errors of chat.postMessage that come from where the answer goes, and stay whatever the wait
// (https://docs.slack.dev/reference/methods/chat.postMessage): the channel was deleted or archived,
// the bot was removed from it, or posting there is not allowed. An error of the token is not one of
// them: it is fixed in the configuration, and the answers then go out after a restart.
const permanentErrors = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "cannot_reply_to_message",
  "posting_to_channel_denied",
  "messages_tab_disabled",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "msg_blocks_too_long",
  "no_text",
]);

// The code of @slack/web-api for an error that Slack itself returned.
const platformError = "slack_webapi_platform_error";

export function isPermanentSlackError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || !("data" in error)) {
    return false;
  }
  const { code, data } = error;
  return (
    code === platformError &&
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string" &&
    permanentErrors.has(data.error)
  );
}
