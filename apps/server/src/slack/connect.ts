import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { SlackEventSource, SlackWebApi } from "./adapter.ts";

export interface SlackConnection {
  events: SlackEventSource;
  web: SlackWebApi;
  botUserId: string;
  teamId: string;
  start: () => Promise<void>;
}

// Slack reads <, > and & as the start of a mention, a link or an entity: the answer is escaped, as
// Slack documents, so a text written by the model cannot notify a whole channel with <!channel> or
// hide a link behind a label.
export function escapeForSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const slackCallTimeoutMs = 30_000;

// Opens the Socket Mode connection: the server connects to Slack, so no public address is needed.
// Events arrive on a connection authenticated by the app token, so their sender is the Slack user.
export async function connectSlack(tokens: {
  appToken: string;
  botToken: string;
}): Promise<SlackConnection> {
  // No retry and a bounded wait inside a call: the answers are sent one at a time, and the delivery
  // of the server tries again later. The default of the client tries for about 30 minutes, with no
  // limit on one call, which would hold every other Slack message during an outage of Slack.
  const client = new WebClient(tokens.botToken, {
    timeout: slackCallTimeoutMs,
    retryConfig: { retries: 0 },
  });
  const identity = await client.auth.test();
  if (identity.user_id === undefined || identity.team_id === undefined) {
    throw new Error("Slack did not return the identity of the bot");
  }
  const socket = new SocketModeClient({ appToken: tokens.appToken });
  return {
    botUserId: identity.user_id,
    teamId: identity.team_id,
    events: {
      on: (type, listener) => {
        socket.on(type, listener);
      },
    },
    web: {
      postInThread: async ({ channel, threadTs, text }) => {
        const message = { channel, thread_ts: threadTs, text: escapeForSlack(text) };
        // This is the Slack Web API method, not the browser's window.postMessage the rule is about.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        const posted = await client.chat.postMessage(message);
        if (posted.ts === undefined) {
          throw new Error("Slack did not return the timestamp of the posted message");
        }
        return { ts: posted.ts };
      },
      addReaction: async ({ channel, ts, name }) => {
        await client.reactions.add({ channel, timestamp: ts, name });
      },
    },
    start: async () => {
      await socket.start();
    },
  };
}
