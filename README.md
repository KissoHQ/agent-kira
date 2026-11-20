# agent-kira

Multi-channel AI agent that centralizes requests about the company's projects. It receives messages from Slack and from a dedicated mailbox, understands them, classifies them and stores them as structured requests that can be found, followed and updated. The agent core is built with [Mastra](https://mastra.ai) and runs on a local language model through [Ollama](https://ollama.com).

## Status

The P0 and P1 scope of the brief is in place: the Slack and Email channels, the agent and its classification, the structured storage with its history, duplicate detection, human validation and the web interface of the team. Of the bonuses, the web widget (P2) and the per-project knowledge base, with answers to support questions (P3), are in place too. The three scenarios, Email → Agent → Request, Slack → Agent → Request and Widget → Agent → Request, are described step by step in [`docs/demo.md`](docs/demo.md).

| Feature                                                       | Priority | Status      |
| ------------------------------------------------------------- | -------- | ----------- |
| Monorepo, TypeScript, lint, format and test tooling           | —        | Done        |
| Mastra agent connected to a local Ollama model                | P0       | Done        |
| Local PostgreSQL database                                     | P0       | Done        |
| Data model and structured storage with history and provenance | P0       | Done        |
| Typed tools (create, update, find, list, status, search)      | P0       | Done        |
| Classification and uncertainty handling                       | P0       | Done        |
| Slack integration                                             | P0       | Done        |
| Email integration                                             | P0       | Done        |
| Email conversations, duplicates, human validation             | P1       | Done        |
| Web interface to consult and review requests                  | P1       | Done        |
| Embeddable web widget, with files and screen captures         | P2       | Done        |
| Answers to questions about requests                           | P3       | Done        |
| Per-project knowledge base and RAG                            | P3       | Done        |
| Integration with code repositories                            | P3       | Not planned |

## Architecture at a glance

```mermaid
flowchart LR
    Slack["Slack<br/>Socket Mode"] --> Handler["Message handler<br/>apps/server"]
    Email["Email<br/>IMAP and SMTP"] --> Handler
    Handler --> Classifier["Classifier<br/>packages/core"]
    Classifier --> Ollama
    Handler --> Agent[Request agent]
    Agent --> Ollama["Ollama<br/>local model"]
    Agent --> Tools["Request tools<br/>built for each message"]
    Tools --> Core["Business core<br/>packages/core"]
    Web["Web interface<br/>apps/web"] --> Core
    Core --> Postgres[("PostgreSQL<br/>Docker")]
```

The business core holds the data model and the request operations, with no dependency on any channel. Slack, Email and the web widget are input adapters in front of the same agent: each one stores the message received, tells whether the channel verified its sender, and hands it to the message handler. The data model is described in [`docs/data-model.md`](docs/data-model.md). The web interface is a separate process that uses the business core directly, without the agent: the team signs in to consult every request and to validate the decisions of the agent.

Each message is first classified by a separate call to the model, which gives its type, priority, title and summary, with a confidence read from the model's token probabilities. A request waits for a human review when this confidence is low, when its project is unclear or when its sender is unverified. How a message is handled, the types and the measured quality are described in [`docs/agent.md`](docs/agent.md).

The agent works only through thirteen typed tools: `identify_contact`, `identify_project`, `create_request`, `request_clarification`, `update_request`, `find_request`, `list_project_requests`, `list_my_requests`, `get_request_status`, `add_message_to_request`, `search_requests`, `forward_to_team` and `search_knowledge_base`, which finds the help articles of the sender's projects by meaning ([decision 010](docs/decisions/010-knowledge-base.md)). Every message is written by someone outside the system, so the design assumes a message can try to manipulate the model, and limits what it can obtain:

- The tools are built for each message, bound to its sender in the code. They are not registered on the Mastra server, so its HTTP API cannot run them, and neither the model nor a client can change who they act for.
- A verified sender reaches only the requests of the projects they work on, the requests they made, and the help articles of their projects. Any other request answers "not found". A sender changes only the requests they made, and a person of the team then checks the change. An unverified sender only gets the tools to file the message, which then waits for a human review.
- Text that other people wrote, such as the title of another person's request, reaches the model marked as data, like the message itself.
- The project is identified by fixed rules before the model runs: a channel dedicated to a project, then a project key written in the message, then the only project of the sender. When several projects remain possible, the result is ambiguous and the model cannot pick one at random.
- The model makes at most 8 calls per message, tool inputs have bounded sizes, a message is filed only once, and every change is written to the request history.
- The agent writes the answer, and the code checks it before it is sent: no request that no tool returned, no codes, no promise that nobody keeps, no false claim that a question was passed to the team. When no answer passes, the code writes it from what the tools did. A question the data cannot answer is passed to the team, and a message the agent leaves unhandled is filed for a review, so none is lost.
- Each part connects to the database with its own restricted role. The agent server uses `request_agent_server`: it cannot read or write the accounts of the team, change what a message said, nor delete anything. The web interface uses `request_agent_app`, which cannot change the schema or rewrite the history, and only deletes the links between contacts or channels and projects. Their passwords are sent to the database as SCRAM-SHA-256 verifiers, never in clear.

The parts of the system, the path of a message and how to add a channel are described in [`docs/architecture.md`](docs/architecture.md). The reasons behind the main technical choices are recorded in [`docs/decisions/`](docs/decisions/).

## Prerequisites

| Tool    | Version | Notes                                                                                      |
| ------- | ------- | ------------------------------------------------------------------------------------------ |
| Node.js | 26.12.1 | Pinned in `.nvmrc`. Installing it with [nvm](https://github.com/nvm-sh/nvm) is recommended |
| pnpm    | 12.15.0 | Pinned in `package.json` (`packageManager`)                                                |
| Ollama  | 0.40.11 | Version tested. Older versions can refuse recent models (0.40.3 does)                      |
| Docker  | 29.1.3  | Version tested, with Docker Compose 2.40.3. Runs the database                              |

The `ornith:9b` model takes 5.6 GB and needs about 6 GB of free RAM. The embedding model of the knowledge base, `qwen3-embedding:0.6b`, takes 1.2 GB more once loaded. It runs on the CPU when no GPU is available, which makes each answer take 2 to 7 minutes, as measured on the development machine.

## Installation

```bash
git clone git@github.com:KissoHQ/agent-kira.git
cd agent-kira

nvm install 26.12.1
nvm use
npm install -g pnpm@12.15.0

pnpm install

ollama pull ornith:9b
ollama pull qwen3-embedding:0.6b
```

## Configuration

One file, at the root, configures the whole project. It is created from its template and never committed:

```bash
cp .env.example .env
```

| Variable                                                                   | Role                                                                                                                                            | Example value                                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                                                        | Password of the `request_agent` database user, used by Docker Compose                                                                           | `change-me`                                                                      |
| `POSTGRES_PORT`                                                            | Port of the database on the machine (localhost only)                                                                                            | `5433`                                                                           |
| `DATABASE_URL`                                                             | Connection to the development database, as its owner. Used by the migrations and the demo data                                                  | `postgresql://request_agent:change-me@127.0.0.1:5433/request_agent`              |
| `APP_DATABASE_URL`                                                         | Connection used by the application, with the restricted `request_agent_app` role                                                                | `postgresql://request_agent_app:change-me-too@127.0.0.1:5433/request_agent`      |
| `SERVER_DATABASE_URL`                                                      | Connection used by the agent server, with the `request_agent_server` role, which has fewer rights still                                         | `postgresql://request_agent_server:change-me-three@127.0.0.1:5433/request_agent` |
| `TEST_DATABASE_URL`                                                        | Connection to the test database. Its name must end with `_test`                                                                                 | `postgresql://request_agent:change-me@127.0.0.1:5433/request_agent_test`         |
| `OLLAMA_BASE_URL`                                                          | Ollama API endpoint. Must end with `/api`                                                                                                       | `http://127.0.0.1:11434/api`                                                     |
| `OLLAMA_MODEL`                                                             | Model used by the agent. It must be pulled first                                                                                                | `ornith:9b`                                                                      |
| `OLLAMA_EMBEDDING_MODEL`                                                   | Optional. Model of the knowledge base, with vectors of 1024 numbers. It must be pulled first                                                    | `qwen3-embedding:0.6b` (default)                                                 |
| `MASTRA_HOST`                                                              | Optional. Address the agent server listens on, for `/health` and `/ready`. Keep it on this machine: Mastra reads JSON bodies whole              | `127.0.0.1` (default)                                                            |
| `OLLAMA_API_KEY`                                                           | Optional. Bearer token of an authenticating proxy in front of a remote Ollama                                                                   | —                                                                                |
| `LOG_LEVEL`                                                                | Optional. Level of the logs of the agent server: `debug`, `info`, `warn` or `error`                                                             | `info` (default)                                                                 |
| `CLASSIFICATION_REVIEW_THRESHOLD`                                          | Optional. Below this confidence, from 0 to 1, a request waits for a human review                                                                | `0.8` (default)                                                                  |
| `SLACK_BOT_TOKEN`                                                          | Optional. Bot token of the Slack app. Without the two Slack tokens, the server runs without Slack                                               | `xoxb-…`                                                                         |
| `SLACK_APP_TOKEN`                                                          | Optional. App-level token with the `connections:write` scope, for Socket Mode                                                                   | `xapp-…`                                                                         |
| `LOCAL_MAIL_USER`, `LOCAL_MAIL_PASSWORD`                                   | Login and password of the agent's mailbox on the local mail server, used by Docker Compose. Never a real password                               | `agent`, `change-me-mail`                                                        |
| `LOCAL_MAIL_IMAP_PORT`, `LOCAL_MAIL_SMTP_PORT`                             | Optional. Ports of the local mail server on the machine (localhost only). They stay the same when the agent uses Gmail                          | `3143`, `3025` (default)                                                         |
| `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT`, `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT` | Servers of the agent's mailbox. Without `EMAIL_IMAP_HOST`, the server runs without email                                                        | `127.0.0.1`, `3143`, `127.0.0.1`, `3025` (local mail server)                     |
| `EMAIL_USER`, `EMAIL_PASSWORD`                                             | Login and password of the mailbox. On the local mail server, the same as `LOCAL_MAIL_USER` and `LOCAL_MAIL_PASSWORD`                            | `agent`, `change-me-mail`                                                        |
| `EMAIL_ADDRESS`                                                            | Address the agent receives and answers from                                                                                                     | `agent@requests.example`                                                         |
| `EMAIL_SECURE`                                                             | `true` to connect with TLS, as real mail servers require. Defaults to `true`                                                                    | `false` (local mail server)                                                      |
| `EMAIL_TRUSTED_AUTHSERV_ID`                                                | Optional. Name of the receiving server in its `Authentication-Results` header. Only that header can verify a sender                             | `mx.google.com`                                                                  |
| `EMAIL_TRUST_LOCAL_SENDERS`                                                | Optional, local tests only: every sender counts as verified. Refused for a mailbox that is not on this machine                                  | `true`                                                                           |
| `TEST_EMAIL_USER`, `TEST_EMAIL_PASSWORD`                                   | Mailbox of the tests, on the local mail server, even when the agent uses Gmail. The tests empty it                                              | `agent-test`, `change-me-mail-test`                                              |
| `TEST_EMAIL_HOST`, `TEST_EMAIL_IMAP_PORT`, `TEST_EMAIL_SMTP_PORT`          | Optional. Server of the tests' mailbox, by default the local mail server                                                                        | `127.0.0.1`, `3143`, `3025`                                                      |
| `WEB_HOST`, `WEB_PORT`                                                     | Optional. Address and port of the web interface. Open it to the network only behind HTTPS                                                       | `127.0.0.1`, `4112` (default)                                                    |
| `WIDGET_ALLOWED_ORIGINS`                                                   | Optional. Origins of the applications that embed the widget, separated by commas. Without it, the server runs without the widget                | `http://localhost:4114` (demo page)                                              |
| `WIDGET_IDENTITY_SECRETS`                                                  | Optional. One secret per project, `PROJECT=secret`, given only to the application of that project, to sign the identity of the person signed in | `PORTAL=` followed by the output of `openssl rand -hex 32`                       |
| `ATTACHMENTS_DIR`                                                          | Absolute path of the folder of the files attached through the widget. Read by the web interface for downloads                                   | `/home/you/request-agent-attachments`                                            |
| `WIDGET_ATTACHMENTS_QUOTA_MB`                                              | Optional. Most space the files of the widget may take, in megabytes                                                                             | `2048` (default)                                                                 |
| `WIDGET_TRUST_PROXY`                                                       | Optional. `true` only behind a reverse proxy that adds the address of the person to `X-Forwarded-For`                                           | `false` (default)                                                                |
| `WEB_TIME_ZONE`                                                            | Optional. Time zone of the dates shown in the web interface, as an IANA name                                                                    | `Europe/Paris` (default)                                                         |
| `WEB_TRUST_PROXY`                                                          | Optional. `true` only behind a reverse proxy that adds the address of the person to `X-Forwarded-For`                                           | `false` (default)                                                                |
| `WEB_PUBLIC_ORIGIN`                                                        | Optional. Origin of the interface behind a reverse proxy; forms are only accepted from it                                                       | `https://kira.example.com`                                                       |

Set a password of your choice, and use the same password and port in `DATABASE_URL` and `TEST_DATABASE_URL`. Docker Compose refuses to start the database without a password. This password is applied only when the database is created, at the first start: changing it later has no effect on the existing database.

Choose other passwords, of printable ASCII characters, for `APP_DATABASE_URL` and `SERVER_DATABASE_URL`. `pnpm db:migrate` applies them to the `request_agent_app` and `request_agent_server` roles each time it runs, so they can be changed later.

The server refuses to start and names the faulty variable when one of them is missing or invalid.

## Running

Start the database and the local mail server. The command waits until they are started:

```bash
pnpm db:up
```

The database keeps its data in a Docker volume. `pnpm db:down` stops both without deleting it. The local mail server keeps emails in memory only.

Create the tables and the two roles of the applications, then insert the fictitious demo data. Both commands can be run again safely:

```bash
pnpm db:migrate
pnpm db:seed
```

Ollama must be running. Start it in a separate terminal if it is not already running as a service:

```bash
ollama serve
```

Development mode, with reload on file changes:

```bash
pnpm dev
```

The API is available on `http://localhost:4111/api` and Mastra Studio, the built-in interface to test the agent, on `http://localhost:4111`. They have no sign-in, so they answer only requests addressed to this machine (`localhost`, `127.0.0.1`), and refuse those sent by a page of another site open in the browser.

The built server (`pnpm start`) serves neither the API nor Studio: only `/health` and `/ready`. The widget listens apart, on `WIDGET_PORT` (4113). The channels call the agent inside the server and never need its API.

Production build and start:

```bash
pnpm build
pnpm start
```

## Deployment

KIRA runs on one server with Docker Compose, from `compose.production.yaml`: the database, a step that applies the migrations, the agent server and the web interface. Their images are built from `Dockerfile` and run as an unprivileged user. Ollama runs apart, on a machine with enough memory, ideally with a GPU: on a CPU, an answer takes from 2 to 8 minutes.

1. On the server, create `.env` from `.env.example`. These variables differ from a local install:

   | Variable                                                                  | Value on the server                                                                                                                    |
   | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`, `APP_DATABASE_URL`, `SERVER_DATABASE_URL`                 | Host `postgres:5432`, the database service of the Compose file, such as `postgresql://request_agent_app:…@postgres:5432/request_agent` |
   | `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`                                       | Address of Ollama as the containers reach it, and the key of the proxy in front of it, if any                                          |
   | `WEB_PUBLIC_ORIGIN`, `WEB_TRUST_PROXY`                                    | Address of the interface, such as `https://kira.example.com`, and `true`                                                               |
   | `WIDGET_ALLOWED_ORIGINS`, `WIDGET_IDENTITY_SECRETS`, `WIDGET_TRUST_PROXY` | Origins and secrets of the applications that embed the widget, and `true`                                                              |
   | `EMAIL_*`                                                                 | The real mailbox, over TLS (see [Connecting email](#connecting-email)), or removed to run without email                                |
   | `LOCAL_MAIL_*`, `TEST_*`, `POSTGRES_PORT`                                 | Removed: they serve the local mail server, the tests and the local database only                                                       |

   `MASTRA_HOST`, `WIDGET_HOST`, `WEB_HOST`, the ports and `ATTACHMENTS_DIR` are set by the images and the Compose file, which take precedence over `.env`.

2. Build and start everything. The `migrate` service applies the migrations and sets the passwords of the roles; the agent server and the web interface start once it succeeded:

   ```bash
   docker compose -f compose.production.yaml up -d --build
   ```

3. Create the first administrator:

   ```bash
   docker compose -f compose.production.yaml run --rm -it tools node packages/core/scripts/add-staff.ts --email dana.support@team.example --name "Dana Support" --role admin
   ```

4. Put a reverse proxy with HTTPS in front of the two services, which listen on this machine only:
   - the web interface, such as `https://kira.example.com`, to `127.0.0.1:4112`;
   - the widget, such as `https://widget.example.com/widget/`, to `127.0.0.1:4113`, with a body limit of 16 MB.

   The Mastra server of the agent, on port 4111, is not published: it listens inside its container only, where its health check reads `/ready`.

5. Check the services. `/ready` checks the database, and for the agent server the model in Ollama and the start of each channel, and answers 503 with what is missing. Its checks run at most once every 5 seconds:

   ```bash
   docker compose -f compose.production.yaml ps
   docker compose -f compose.production.yaml exec server node -e "fetch('http://127.0.0.1:4111/ready').then((r) => r.text()).then(console.log)"
   curl http://127.0.0.1:4112/ready
   ```

   `ps` shows the agent server `healthy` once everything it needs is ready.

To update, get the new version and run the same `up` command: the migrations run first. The logs are read with `docker compose -f compose.production.yaml logs -f server web`; `LOG_LEVEL` sets their level. Mastra sends no usage statistics: `MASTRA_TELEMETRY_DISABLED` is set.

The maintenance commands run in the `tools` service, which `docker compose run` starts on demand, with the files of the widget writable. Daily maintenance, such as from cron, and backups of the database and of the files of the widget:

```bash
docker compose -f compose.production.yaml run --rm tools node packages/core/scripts/purge.ts
docker compose -f compose.production.yaml exec -T postgres pg_dump -U request_agent request_agent > kira.sql
docker run --rm -v kira_attachments:/data:ro -v "$PWD":/backup node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c tar czf /backup/attachments.tgz -C /data .
```

To erase a person on the server (see [Personal data](#personal-data)):

```bash
docker compose -f compose.production.yaml run --rm tools node packages/core/scripts/erase-contact.ts --email bruno.leroy@globex.example --confirm
```

The agent server and the web interface each run as one container: they keep the queue of messages and the limits of sign-in and of the widget in memory.

## Web interface

The team consults the requests and validates the decisions of the agent in a web interface, started separately from the agent server. It needs the database only.

1. Create the first administrator. The command asks for the password twice, without showing it, and requires at least 15 characters. Running it again for the same email sets a new password and ends the open sessions:

   ```bash
   pnpm staff:add --email dana.support@team.example --name "Dana Support" --role admin
   ```

   The administrator then creates the other accounts in the interface, under Administration → Équipe.

2. Start the interface:

   ```bash
   pnpm web
   ```

   It runs until it is stopped with Ctrl+C in its terminal. When port 4112 is already in use, often by another interface still running, it says so and stops: stop the other one, or choose another port with `WEB_PORT` in `.env`.

3. Open `http://127.0.0.1:4112` in Chrome or Firefox and sign in. Safari refuses the session cookie over plain HTTP, even on this machine.

The interface lists the requests with a search and filters, shows the review queue with the reasons of each review, and shows each request with its messages, the answers of the agent and its full history. A request can be validated with corrections, changed to another status or marked as a duplicate: the history records the person who did it. When the request changed while the page was open, such as a new message, the action is refused and the page shows the request as it is now.

Two roles share the interface:

| Role          | Can                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member        | Handle the requests, and change their own password under "Mon compte"                                                                                                |
| Administrator | Also manage, under "Administration": the clients, their projects, the contacts and their projects, the channels dedicated to a project, and the accounts of the team |

Nothing is deleted: a client or a project that ends is archived, a contact or an account is disabled, so the history of the requests stays whole. Every change to an account of the team asks the own password of the administrator again, and every action of the administration is written to the logs with who did it. The key of a project never changes once created: the widget, the channels and the commands name it. A session ends after 8 hours, or after 1 hour without use. The choices and protections of the interface are described in [decision 008](docs/decisions/008-web-interface.md).

## Knowledge base

The agent answers questions on how to use a product from the help articles of the sender's projects. Load the fictitious articles of the demonstration projects, which needs Ollama:

```bash
pnpm kb:import --demo
```

To load your own articles, write one Markdown file per article, in a folder per project key, with the title as the first `# ` heading, such as `help/PORTAL/factures.md`. Then run `pnpm kb:import help`. Running it again updates the articles of the same files. How the articles are searched, and why, is described in [decision 010](docs/decisions/010-knowledge-base.md).

## Web widget

Client applications embed the widget with one script tag: their users write to the agent from the application, attach files or a capture of their screen, and follow the answer and the status of their request. The application signs the identity of the person signed in, so the agent knows who writes. How to embed it and sign the identity is described in [`docs/widget.md`](docs/widget.md), and the choices in [decision 011](docs/decisions/011-web-widget.md).

To try it locally, set `WIDGET_ALLOWED_ORIGINS`, `WIDGET_IDENTITY_SECRETS` and `ATTACHMENTS_DIR` as [`docs/widget.md`](docs/widget.md) shows, start the agent server, then open the demo page of a fictitious customer portal:

```bash
pnpm demo:widget
```

## Connecting Slack

The agent connects to Slack in Socket Mode: the server opens the connection, so no public address or tunnel is needed. Use a test workspace, never a company workspace with real data.

1. Create a free workspace at [slack.com/get-started](https://slack.com/get-started#/createnew).
2. At [api.slack.com/apps](https://api.slack.com/apps), select **Create New App**, then **From a manifest**, choose the workspace, and paste the content of [`apps/server/slack-app-manifest.yaml`](apps/server/slack-app-manifest.yaml).
3. In **Basic Information**, under **App-Level Tokens**, generate a token with the `connections:write` scope, and set it as `SLACK_APP_TOKEN` in `.env`.
4. In **Install App**, install the app to the workspace, and set the **Bot User OAuth Token** as `SLACK_BOT_TOKEN` in `.env`.
5. Start the server with `pnpm dev`. The log shows `Slack adapter listening`.
6. In Slack, invite the bot to a channel with `/invite @Request agent`, then mention it, or send it a direct message.

The agent handles mentions, direct messages, messages with a file, and replies in the threads it already takes part in, from people who already wrote to it there: a colleague who answers in the thread without naming the agent is not handled. It ignores the other messages of a channel, without storing them. It adds 👀 to a message it handles, then answers in its thread, usually 2 to 7 minutes later on a CPU. Its answers are posted as plain text: they cannot notify a channel or hide a link.

A Slack user only gets rights when a contact with their Slack member ID exists, and when Slack says they belong to the workspace of the app: a person of another organization, such as in a Slack Connect channel, is unverified. An administrator sets the Slack member ID of a contact, and the channels dedicated to a project, in the web interface.

## Connecting email

The agent watches its mailbox over IMAP and answers over SMTP. With the values of `.env.example`, it uses the local mail server started by `pnpm db:up`, with no account to create: start the server with `pnpm dev`, and the log shows `Email adapter listening`.

Any mail client can write to the agent on the local mail server, at `127.0.0.1`, SMTP port `3025` and IMAP port `3143`, which `LOCAL_MAIL_SMTP_PORT` and `LOCAL_MAIL_IMAP_PORT` can change. It accepts mail for any address, and creates a mailbox for each recipient, whose login and password are its address. Only this machine can reach it: the tests keep using it.

### With Gmail

For people to write to the agent from their own mailbox, the agent gets a Gmail account of its own. It handles and answers every email of its inbox, so it must never be a personal mailbox.

1. Create the Gmail account of the agent.
2. Turn on 2-Step Verification for that account, at <https://myaccount.google.com/signinoptions/twosv>.
3. Create an app password at <https://myaccount.google.com/apppasswords>. Google refuses the account password itself over IMAP and SMTP.
4. In `.env`, set the email variables as below, with the app password written without spaces:

   ```dotenv
   EMAIL_USER=the-agent-address@gmail.com
   EMAIL_PASSWORD=the-app-password
   EMAIL_ADDRESS=the-agent-address@gmail.com
   EMAIL_IMAP_HOST=imap.gmail.com
   EMAIL_IMAP_PORT=993
   EMAIL_SMTP_HOST=smtp.gmail.com
   EMAIL_SMTP_PORT=465
   EMAIL_SECURE=true
   EMAIL_TRUSTED_AUTHSERV_ID=mx.google.com
   ```

5. Register each person who writes to the agent, with their organization and projects, so their emails are recognized:

   ```bash
   pnpm contact:add --email emma.petit@example.com --name "Emma Petit" --organization Acme --project SHOP
   ```

At its first start, the agent reads the unread emails of the inbox: mark the welcome emails of Google as read before. After that, it also handles the emails that a person opened in Gmail before it read them. Changing the app password, or the account password, which revokes app passwords, requires updating `EMAIL_PASSWORD`. The choices are explained in [decision 006](docs/decisions/006-email-connection.md).

### What the agent does with an email

The agent handles each new email, keeps it with its attachments' descriptions, and answers in the same thread, with the request reference in the subject. A reply is attached to its conversation through its `In-Reply-To` and `References` headers, and the history quoted in a reply is not given to the model. An email that names a thread where nobody of its email domain wrote starts its own thread, so it never joins the conversation of another company. Automatic emails, such as out-of-office replies, mailing lists or bounces, are kept but neither handled nor answered, and the answers of the agent are marked `Auto-Submitted: auto-replied`, so robots do not answer each other.

A sender is only verified by the `Authentication-Results` header that the receiving mail server adds, when it shows that DMARC passed for the sender's domain: set `EMAIL_TRUSTED_AUTHSERV_ID` to the name of that server. A sender can write such a header in the email itself, so any other one is ignored. The local mail server adds no such header: without `EMAIL_TRUST_LOCAL_SENDERS=true`, every sender is unverified there, and their requests wait for a review.

The From address of an unverified email can be forged, to make the agent write to someone else from the company's domain. So the answers depend on the sender:

| Sender                                              | Answer                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Verified                                            | The answer of the agent, at most 30 an hour to one address                                   |
| Unverified                                          | A fixed notice, "Nous avons bien reçu votre message…", with the reference, at most one a day |
| DMARC failed for its domain at the receiving server | Nothing: the request is filed for a review                                                   |

`EMAIL_SECURE=false` is refused for a mail server on another machine: real servers are reached on their TLS ports, such as 993 for IMAP and 465 for SMTP.

An address dedicated to a project, such as one forwarded to the agent's mailbox, is declared in `project_channels`.

## Usage

The demonstration of both scenarios, with the expected results, is in [`docs/demo.md`](docs/demo.md). On the local mail server, a fictitious email can be sent to the agent, and its answer awaited, with:

```bash
pnpm demo:email
```

With `pnpm dev`, the API of the Mastra server can also be called directly. Send a message to the agent:

```bash
curl -X POST http://localhost:4111/api/agents/request-agent/generate \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Bonjour"}]}'
```

The JSON response contains the answer in the `text` field. This route reaches the agent without its request tools: they are only given to messages received through a channel, such as Slack.

## Personal data

A person who asks for their data to be erased (GDPR, article 17) is erased with one command, as the owner of the database. Without `--confirm`, it only shows what it would erase:

```bash
pnpm contact:erase --email bruno.leroy@globex.example
pnpm contact:erase --email bruno.leroy@globex.example --confirm
```

It replaces what the person wrote and the answers they got with "[effacé à la demande de la personne]", empties the original payloads of their conversations, including the emails of others that may quote them, removes the texts of their requests and the texts kept in their history, deletes their files from `ATTACHMENTS_DIR`, and replaces their name, email and Slack ID. A message of the person still waiting for the agent is closed: the agent neither files nor answers it. A file that cannot be deleted is listed with the reason, to be deleted by hand, and the command ends with an error. Nothing is deleted from the history: the requests keep their type, status, project and dates. `--slack U012AB3CD` names a Slack person. An account of the team is disabled in the web interface instead.

`pnpm db:purge` deletes the sessions of the web interface that ended more than 30 days ago, and empties the original payload of the messages handled, and of the answers sent, more than 365 days ago (`--source-retention-days` changes it). Their text stays. It is meant to run once a day, such as from cron.

## Tests and code quality

| Command                    | What it checks                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                | Tests (Vitest) of every package, one package after the other, including the two demonstration scenarios from the channel to the stored request. The model is simulated, Ollama is not needed. The tests need the database and the local mail server (`pnpm db:up`) and use the separate test database, created automatically |
| `pnpm typecheck`           | TypeScript types, in strict mode                                                                                                                                                                                                                                                                                             |
| `pnpm lint`                | Lint rules with oxlint, including type-aware rules                                                                                                                                                                                                                                                                           |
| `pnpm format:check`        | Formatting with Prettier. `pnpm format` fixes it                                                                                                                                                                                                                                                                             |
| `pnpm eval:classification` | Quality of the classifier on labeled messages, with the real model. Needs Ollama and takes 30 to 60 minutes on a CPU, so it is not part of `pnpm test`                                                                                                                                                                       |
| `pnpm eval:duplicates`     | Quality of the duplicate check on labeled messages and their candidates, with the real model. Needs Ollama and takes about 15 minutes on a CPU                                                                                                                                                                               |

## Project structure

```
agent-kira/
├── apps/
│   ├── web/                        Web interface of the team
│   │   └── src/
│   │       ├── main.ts             Starts the interface
│   │       ├── config.ts           Environment variables validation
│   │       ├── listen.ts           Starts listening, and tells a busy port in plain words
│   │       ├── app.ts              Pages, actions, sign-in and protections
│   │       ├── admin.ts            Administration pages and the page of one's own account
│   │       ├── sign-in-limiter.ts  Refuses sign-in for a while after repeated failures
│   │       ├── password-checks.ts  Bounds the password checks running and waiting at once
│   │       └── views/              Pages, rendered on the server, and their labels in French
│   └── server/                     Mastra server
│       ├── slack-app-manifest.yaml Settings of the Slack app
│       ├── scripts/demo-email.ts   Sends a demonstration email and waits for the answer
│       ├── scripts/demo-widget.ts  Demo page of a customer portal that embeds the widget
│       └── src/
│           ├── config.ts           Environment variables validation
│           ├── channel-handler.ts  Database and agent shared by the channel adapters
│           ├── reliable-handling.ts  Retries, and filing for a person after the last failure
│           ├── retry.ts            Waits before reaching again a service that is down
│           ├── readiness.ts        /ready: database, model and channels
│           ├── scenarios.test.ts   Email → Agent → Request and Slack → Agent → Request, end to end
│           ├── email/
│           │   ├── parse.ts        Reads an email: sender, thread, new text, attachments
│           │   ├── policy.ts       Verified senders and automatic emails
│           │   ├── adapter.ts      Stores, queues and answers emails
│           │   ├── connect.ts      IMAP and SMTP clients
│           │   └── start.ts        Starts email with the server when it is configured
│           ├── widget/
│           │   ├── script.ts       The script embedded by the applications
│           │   ├── adapter.ts      Stores, queues and answers widget messages, and serves conversations
│           │   ├── identity.ts     Identity of the person, signed by the application
│           │   ├── files.ts        Attached files: count, size and type read from the content
│           │   ├── admission.ts    Limits of the public widget: rate, waiting messages, uploads
│           │   └── start.ts        Routes on the Mastra server, started when the widget is configured
│           ├── slack/
│           │   ├── events.ts       Which Slack events reach the agent
│           │   ├── adapter.ts      Stores, queues and answers Slack messages
│           │   ├── connect.ts      Socket Mode and Web API clients
│           │   └── start.ts        Starts Slack with the server when it is configured
│           └── mastra/
│               ├── index.ts        Mastra entry point: registers the agent
│               ├── api-guard.ts    Closes the Mastra API outside development
│               ├── agents/
│               │   ├── request-agent.ts   Agent and its instructions
│               │   ├── handle-message.ts  Runs the agent on one message, with its tools
│               │   ├── answer-check.ts    Checks the answer of the agent before it is sent
│               │   └── reply.ts           Answer written by code when no answer passes
│               └── tools/
│                   ├── request-tools.ts   The thirteen tools of the agent
│                   └── explain.ts         Codes of the database in plain words
├── packages/
│   └── core/                       Business core, independent of any channel
│       ├── drizzle/                SQL migrations, generated from the schema
│       ├── eval/                   Labeled messages to measure the classifier
│       ├── scripts/                Migration, demo data, team accounts, contacts, knowledge base, erasure, purge and evaluation commands
│       ├── src/
│       │   ├── env.ts              Environment variables validation
│       │   ├── untrusted.ts        Wraps text written by senders before a model reads it
│       │   ├── messages/
│       │   │   ├── inbox.ts        Stores channel messages once, with their conversation
│       │   │   ├── conversation.ts What a conversation said, where it started, who wrote in it
│       │   │   ├── handling.ts     Which messages are handled, and the failed attempts
│       │   │   └── mailbox-cursor.ts  How far the agent has read its mailbox
│       │   ├── contacts/
│       │   │   ├── save-contact.ts Registers a person who writes to the agent
│       │   │   └── membership.ts   Whether a person works on a project
│       │   ├── admin/
│       │   │   ├── catalog.ts      Organizations, projects and their channels
│       │   │   └── people.ts       Contacts and the projects they work on
│       │   ├── privacy/
│       │   │   └── erase.ts        Erasure of a person, and purge of old data
│       │   ├── limits/
│       │   │   └── rate-limiter.ts Requests per key in windows of time
│       │   ├── knowledge/
│       │   │   ├── embedder.ts     Vectors of articles and questions, from Ollama
│       │   │   ├── articles.ts     Saves articles and finds those closest to a question
│       │   │   └── demo-articles.ts  Fictitious help articles of the demonstration projects
│       │   ├── classification/
│       │   │   ├── taxonomy.ts     Definitions of the request types and priorities
│       │   │   ├── classifier.ts   Classification call to Ollama, with its confidence
│       │   │   ├── duplicate-judge.ts  Asks the model which request repeats a message
│       │   │   └── ollama.ts       Structured call to Ollama and token probabilities
│       │   ├── staff/
│       │   │   ├── password.ts     Argon2id password hashes
│       │   │   ├── accounts.ts     Accounts of the team and sign-in
│       │   │   └── sessions.ts     Sessions of the web interface
│       │   ├── db/
│       │   │   ├── schema.ts       Data model
│       │   │   ├── client.ts       Database connection
│       │   │   ├── errors.ts       PostgreSQL error codes the code expects
│       │   │   ├── migrate.ts      Migration runner
│       │   │   ├── app-role.ts     Passwords of the two restricted roles of the applications
│       │   │   └── seed.ts         Fictitious demo data
│       │   └── requests/
│       │       ├── turn.ts         Sender and project of the message, computed before the model
│       │       ├── classified-turn.ts  Classification of the message and human review rules
│       │       ├── access.ts       The access rule applied to every operation
│       │       ├── reference.ts    References such as REQ-0042
│       │       ├── views.ts        What the operations return, and their results
│       │       ├── inputs.ts       Validated inputs of the operations
│       │       ├── commands.ts     Create, clarify, update, add a message
│       │       ├── duplicates.ts   Candidates for a duplicate, and the check by the model
│       │       ├── review.ts       Review queue: list, review, mark as duplicate
│       │       ├── console.ts      What the web interface reads, and status changes
│       │       └── queries.ts      Find, status, list, search, identify
│       └── test/                   Test database setup and fixtures, shared with the apps
├── docs/
│   ├── architecture.md             Parts, path of a message, adding a channel
│   ├── demo.md                     Step-by-step demonstration of the three scenarios
│   ├── widget.md                   Embedding the widget in an application
│   ├── agent.md                    How a message is handled, types, review, measured quality
│   ├── data-model.md               Tables and their columns
│   └── decisions/                  Technical choices and their reasons
├── .github/
│   ├── workflows/ci.yml            Checks of every pull request
│   ├── dependabot.yml              Weekly updates of dependencies, actions and images
│   └── pull_request_template.md
├── .env.example                    Configuration template
├── compose.yaml                    Local PostgreSQL database and mail server
├── compose.production.yaml         KIRA on one server: database, migrations, agent server, web interface
├── Dockerfile                      Images of the agent server and of the web interface
├── .nvmrc                          Node.js version
├── .oxlintrc.json                  Lint rules
├── package.json                    Root scripts
├── pnpm-workspace.yaml             Workspace packages and shared dependency versions
└── tsconfig.base.json              TypeScript settings shared by all packages
```

All dependency versions are declared once in the `catalog` of `pnpm-workspace.yaml`, and packages reference them with `catalog:`.

## Known limitations

- Slack messages, emails and widget messages are handled one at a time. A message left unhandled by a restart is handled again at the next start.
- The agent works at most 15 minutes on one message. Beyond, the message is filed for a person, who gets its reference.
- An answer is kept with its message until the channel takes it. When Slack or the mail server refuses it, it is sent again after 1, 5 and 15 minutes, then every 15 minutes, and again after a restart. It is given up a day after its message was handled, counted from the database so a restart does not start again, or at once when the refusal is final: a Slack channel deleted or archived, the bot removed from it, an address or a message the mail server refuses for good. The log says so, and the request stays in the web interface. A Slack call waits at most 30 seconds.
- When Slack or the mail server is unreachable at startup, the server tries again after 10 seconds, then waits longer each time, up to every 5 minutes.
- Duplicates are found among requests sharing words or spelling with the message: a rewording with no word in common, such as "CB" for "carte bancaire", is missed.
- Email attachments are described (name, type, size) in the interface but cannot be downloaded: their content is only kept inside the stored source of the email. Files sent through the widget are stored and can be downloaded by the team.
- The text of a message is kept up to 10,000 characters and its subject up to 500, so the model and the search always read a bounded text. A longer text ends with " […]" in the interface. The original message stays whole in the stored source.
- The widget must be reachable from the browsers of the applications. It listens on this machine only by default: a reverse proxy serves `WIDGET_PORT` over HTTPS.
- A support question answered from a help article gets no request: if the model wrongly judges that an article answers it, the team does not see it. The articles themselves are written and kept up to date by the team.
- Answers are written by a small local model. The check blocks codes, promises, unknown requests and false claims of forwarding, but a clumsy sentence can still pass. The system records no assignee and no planned date: questions about them are passed to the team.
- The Mastra server API and Studio have no authentication: only `pnpm dev` serves them, to this machine only. They give no access to the request tools. The web interface of the team has its own accounts.
- Sign-in to the web interface allows 5 attempts per email and 30 per network address within 15 minutes, then refuses them for 15 minutes. Two password checks run at a time and 50 more can wait; beyond, the interface asks to retry in a few seconds. These counts are kept in memory: a restart clears them.
- Mastra keeps its own data (agent memory, traces) in memory and loses it on restart.
- The local model takes about 6 GB of memory: on a machine with 16 GB, other heavy programs such as web browsers can make Linux stop it for lack of memory.
- The local model is slow on a CPU: classifying a message takes from 20 s to 60 s, and the agent adds its own calls. Its classification is measured on 80 fictitious messages only, described in [`docs/agent.md`](docs/agent.md).
