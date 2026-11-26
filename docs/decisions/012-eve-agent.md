# 012 — The agent built with eve, in its own process

- Status: accepted
- Date: 2026-11-26
- Revises decisions [001](001-local-llm.md), [002](002-runtime-and-database.md), [003](003-agent-tools-security.md) and [009](009-agent-answers.md)

## Context

The instruction given for the project is: "Please redo your own agent using Vercel eve". [eve](https://github.com/vercel/eve) is an open source framework by Vercel, under the Apache 2.0 license, whose version 1.0 came out on 15 November 2026. This decision uses eve 1.5.0 with the AI SDK (`ai`) 7.0.177, the version the tests of eve 1.5.0 run with.

eve differs from Mastra in one way that shapes everything else. Mastra is a library: the server called `agent.generate()` like a function. eve is a whole program: an agent is a folder of files (instructions, tools, hooks, routes), and `eve build` turns it into a Node.js server of its own, which receives the messages, runs the model and keeps each conversation. eve offers no way to run an agent from another program without going through that server.

The agent must keep what KIRA already guarantees: no data leaves the machine (decision 001), the tools act only for the sender that the code verified (decision 003), the step and time limits, and the check of the answers before they are sent (decision 009).

## Options

| Option                                                                                                                                                     | Assessment                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything in eve: the channels become routes of eve                                                                                                       | The Slack channel of eve needs a public HTTPS address that Slack calls; KIRA uses Socket Mode, which needs none. Reading a mailbox over IMAP is a connection that stays open, which eve does not host: it runs its own Discord connection in a separate relay process. This would add processes, not remove them |
| Mastra kept for its server, eve for the agent                                                                                                              | A whole framework kept for `/health` and `/ready`                                                                                                                                                                                                                                                                |
| **Two processes: the server keeps the channels, the classification and the check of the answers; the agent, built with eve, runs the model and its tools** | **Chosen.** It is the way eve is built to run. The server calls the agent on one internal route, with a password, and gets back the answer and what each tool did. Mastra is removed: `/health` and `/ready` are served with Hono, which the widget already used                                                 |

## How it works

1. The server classifies the message and looks for duplicates, as before.
2. It sends the agent the message, wrapped as untrusted text, the information it computed and the classified turn, with the verified sender, on `POST /eve/v1/kira/messages/:messageId`, with Basic authentication and `AGENT_PASSWORD`. Both sides check what they receive against the schemas of `packages/core/src/agent/protocol.ts`.
3. The route starts the session of the message, at the address of its ID, with the turn as its caller. eve gives the caller to the tools and to the instructions from the session, out of reach of the model: the tools (`agent/tools/requests.ts`) are built for this sender only, and the information of the server is a system instruction (`agent/instructions/information.ts`). A session that the route did not start gets no tool.
4. Each tool returns what it did; the model reads it in plain words (`toModelOutput`), and the route returns the whole outcome to the server with the answer.
5. The server checks the answer. A rejected answer is sent back once, on `/rewrite`, in the same session, with the reasons. Then the server ends the session (`DELETE`), and eve deletes what it stored about it.

## What is rebuilt around eve

eve has no limit of steps, no time limit for a run, and its hooks see an answer only after it is recorded. These protections are rebuilt:

- **Step limit.** A hook on `model.requested` (`agent/hooks/step-limit.ts`) counts the calls of the model in the state of the session, which survives a restart, and cancels the turn before the call that goes past 8 for the turn, or 9 for the message with its rewrite. The view of the session that hooks receive keeps only the current turn: counting in it let a rewrite make 8 more calls.
- **Time limit.** The route waits for the end of the turn at most for the time the server gives, then cancels it. What the tools did stays.
- **Answer check.** It runs in the server, once the agent returned its answer. The server counts the rewrites itself: one at most. An answer that a limit cut is never sent.
- **Context window.** The agent sends Ollama the same window as the classifier, 8192 tokens, with thinking turned off. eve summarizes the conversation when it fills 90% of the window; this cannot be turned off. The largest prompt measured, 4081 tokens, stays under it; the longest run the step limit allows could go past it ([measures](../agent.md#limits-of-a-run)).
- **Long turns.** `fetch` of Node.js gives up on an answer whose headers, or next bytes, take more than 300 s. The first measure with the real model lost a message this way: loading the model made its turn longer than 5 minutes. The route therefore sends its headers at once, a space every 15 s while the turn runs, then the result or the reason of the failure in the body. A turn of 320 s was checked through the client of the server.

## What was locked down

- **No data leaves the machine.** eve sends usage statistics to Vercel by default: `EVE_TELEMETRY_DISABLED=1` is set in the image of the agent, the CI and the scripts that start it. During the handling of a message, the agent connects only to Ollama and to itself: checked by recording its network connections with `strace`. `eve build` reads the public list of models of Vercel (`ai-gateway.vercel.sh`), with no data of KIRA; without network it goes on, since the agent sets its context window itself.
- **No other entry.** The built-in routes of eve, which let a client open and read sessions, and its home page, are removed (`disableRoute()`). The agent has none of the tools of eve (`defaultTools: false`): it can neither run code, read files nor reach the web. It runs no sandbox.
- **No second copy of the messages.** eve keeps the session of a message on disk while it is handled. With `experimental.workflow.retention: 0`, it deletes it when the session ends, once the message is handled. Its title, which eve keeps after the deletion, is the ID of the message, not its first words, which eve takes by default.
- **The password is checked by the route itself.** `routeAuth` of eve returns the refusal instead of throwing it; a route that ignores it lets every request in. A test sends requests without the password and with another one.
- **The model of the agent is not replaced.** eve replaces the model of every agent with one of its own when `NODE_ENV` is `test`, as Vitest sets it. The scripts that start the agent set `NODE_ENV=production`.

## Consequences

- KIRA runs one more process: the agent, on port 4120, reached by the server only. In production, it is the `agent` service of `compose.production.yaml`, with no domain and with a volume for its sessions. It receives only the settings it needs.
- Locally, the agent is built with `pnpm build` and started with `pnpm agent`, next to `pnpm dev`.
- The tests start the real agent, with a model that plays a script (`apps/agent/test/scripted/`), in its own process: the tools, the hook, the route and the deletion of the sessions are tested as they run in production.
- After an upgrade of eve, the sessions that an older version started cannot go on. A session lasts as long as one message, and a new attempt at a message ends the earlier session and starts from the message alone: an upgrade costs at most a retry of the messages in progress.
- eve is young and moves fast: 7 versions in the 10 days after 1.0. Its version is pinned, and each upgrade is read in its changelog and checked with the tests and `pnpm eval:agent`.
- Storing the sessions in PostgreSQL, for several processes of the agent, is experimental in eve. KIRA runs one process of the agent, with the local storage of eve on its volume.

## Sources

- eve 1.5.0: [repository](https://github.com/vercel/eve) and its documentation, read at the commit of 25 November 2026: `docs/agent-config.md` (model, Ollama, limits, compaction, run data retention), `docs/channels/custom.mdx` (routes, `from().send()`, `cancel`, `end`), `docs/guides/auth-and-route-protection.md` (`httpBasic`, `routeAuth`), `docs/guides/hooks.md` (hooks run after the event is recorded; a cancel from `model.requested` acts before the call), `docs/concepts/state.md` (`defineState`), `docs/concepts/session-views-and-selectors.md`, `docs/dynamic-configuration/index.md`, `docs/guides/deployment/self-hosting/index.md` and `docs/reference/telemetry.md`
- eve 1.5.0, code checked: `runtime/agent/mock-model-adapter.js` (`NODE_ENV=test`), `internal/nitro/host/start-production-server.js` (`eve start` runs `node .output/server/index.mjs`), `compiler/model-catalog.js` (cached list of models)
- [Introducing eve](https://vercel.com/blog/introducing-eve), Vercel
- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/): LLM06 Excessive Agency
