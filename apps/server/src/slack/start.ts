import type { ChannelHandler } from "../channel-handler.ts";
import { errorMessage, type Logger } from "../logger.ts";
import { loadSlackTokens } from "../config.ts";
import { retryUntilDone } from "../retry.ts";
import { startSlackAdapter } from "./adapter.ts";
import { connectSlack } from "./connect.ts";

// Connects the agent to Slack when the Slack tokens are configured. Returns false otherwise, so
// the server keeps running without Slack.
export async function startSlackIfConfigured(
  handler: () => ChannelHandler,
  logger: Logger,
): Promise<boolean> {
  const tokens = loadSlackTokens();
  if (tokens === undefined) {
    logger.info("Slack is not configured: set SLACK_BOT_TOKEN and SLACK_APP_TOKEN to connect it");
    return false;
  }
  const { db, handle } = handler();
  // Slack may be unreachable when the server starts, such as after a restart of the machine: the
  // channel keeps trying instead of staying off until the next restart.
  const onFailure = (step: string) => (error: unknown, attempt: number) => {
    logger.error(`Slack could not ${step}, attempt ${attempt}`, { error: errorMessage(error) });
  };
  const slack = await retryUntilDone(() => connectSlack(tokens), {
    onFailure: onFailure("check the bot token"),
  });
  if (slack === undefined) {
    return false;
  }
  await startSlackAdapter({
    events: slack.events,
    web: slack.web,
    db,
    botUserId: slack.botUserId,
    teamId: slack.teamId,
    handle,
    logger: {
      info: (message) => {
        logger.info(message);
      },
      error: (message, error) => {
        logger.error(message, { error: errorMessage(error) });
      },
    },
  });
  await retryUntilDone(() => slack.start(), { onFailure: onFailure("open its connection") });
  return true;
}
