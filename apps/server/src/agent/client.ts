import {
  agentServerUsername,
  type AgentTurnRequest,
  agentTurnReplySchema,
  type AgentTurnResult,
} from "@request-agent/core";

// The agent runs in its own process, built by eve. The server reaches it on its internal route,
// with the password that only the two of them know.
export interface AgentClient {
  // Handles a message: one turn of the agent, in a new session of the message.
  handle: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  // Asks the model to write its answer again, in the session of the message.
  rewrite: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  // Ends the session of a handled message: the agent then deletes what it stored about it.
  end: (messageId: string) => Promise<void>;
  // Whether the agent answers and can reach the database.
  ready: () => Promise<boolean>;
}

export interface AgentClientOptions {
  url: string;
  password: string;
  fetch?: typeof fetch;
}

// The agent stops the model at the time limit of the turn, then waits up to 60 s for it to stop:
// the server waits that long, and some more for the network, before it gives up.
const answerMarginMs = 90_000;

// Longest wait for the other calls, which do not run the model.
const shortCallMs = 10_000;

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`The agent could not ${what}: HTTP ${response.status} ${body.slice(0, 500)}`);
}

export function createAgentClient(options: AgentClientOptions): AgentClient {
  const send = options.fetch ?? fetch;
  const base = `${options.url.replace(/\/$/, "")}/eve/v1/kira`;
  const authorization = `Basic ${Buffer.from(`${agentServerUsername}:${options.password}`).toString("base64")}`;
  const messagePath = (messageId: string) => `${base}/messages/${encodeURIComponent(messageId)}`;

  async function turn(path: string, request: AgentTurnRequest): Promise<AgentTurnResult> {
    const response = await send(path, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(request.timeoutMs + answerMarginMs),
    });
    if (!response.ok) {
      throw await failure(response, "handle the message");
    }
    const reply = agentTurnReplySchema.parse(await response.json());
    if ("error" in reply) {
      throw new Error(`The agent could not handle the message: ${reply.error}`);
    }
    return reply.result;
  }

  return {
    handle: (request) => turn(messagePath(request.turn.messageId), request),
    rewrite: (request) => turn(`${messagePath(request.turn.messageId)}/rewrite`, request),
    end: async (messageId) => {
      const response = await send(messagePath(messageId), {
        method: "DELETE",
        headers: { authorization },
        signal: AbortSignal.timeout(shortCallMs),
      });
      if (!response.ok) {
        throw await failure(response, "end the session of the message");
      }
    },
    ready: async () => {
      try {
        const response = await send(`${base}/ready`, { signal: AbortSignal.timeout(shortCallMs) });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
