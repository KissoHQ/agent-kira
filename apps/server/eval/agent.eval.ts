// Measures the agent with the real model, on the fictitious messages of agent-messages.json: how
// many model calls each kind of message takes, and how long each call to Ollama takes on the
// machine that runs it. The limits of the agent are set from these measures, as docs/agent.md
// describes. It runs on a temporary database, dropped at the end, and it is slow on a CPU, so it
// is not part of the tests. Usage: pnpm eval:agent
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  type Classifier,
  connectDatabase,
  createOllamaClassifier,
  createOllamaDuplicateJudge,
  createOllamaEmbedder,
  type DuplicateJudge,
  type Embedder,
  loadAppDatabaseEnv,
  loadClassifierEnv,
  loadKnowledgeEnv,
  loadServerDatabaseEnv,
  ollamaHeaders,
  saveArticle,
  searchKnowledge,
  storeInboundMessage,
} from "@request-agent/core";
import {
  asRole,
  createDatabaseIfMissing,
  demoArticles,
  disposableDatabaseName,
  dropDatabaseIfExists,
  loadTestDatabaseEnv,
  prepareDatabase,
  seedDatabase,
} from "@request-agent/core/testing";
import { createOllama } from "ollama-ai-provider-v2";
import { expect, it } from "vitest";
import { z } from "zod";

import { type HandlingLimits, loadHandlingLimits } from "../src/config";
import { maxAnswerRetries } from "../src/mastra/agents/answer-check";
import { type AgentRun, handleMessage, maxAgentSteps } from "../src/mastra/agents/handle-message";
import { createRequestAgent } from "../src/mastra/agents/request-agent";

const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));

// Long enough never to cut a call: the limits set in .env are compared with the measures after.
const measureTimeoutMs = 60 * 60 * 1000;

const sampleSchema = z.array(
  z.object({
    case: z.string().min(1),
    channel: z.enum(["EMAIL", "SLACK", "WIDGET"]),
    sender: z.string().min(1),
    trust: z.enum(["VERIFIED", "UNVERIFIED"]),
    // Messages with the same thread belong to the same conversation.
    thread: z.string().min(1),
    channelAddress: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().min(1),
  }),
);

interface Measure {
  case: string;
  type: string;
  // Calls to the model in the run of the agent; 0 when the agent was not run, as for thanks.
  modelCalls: number;
  cutBy: AgentRun["cutBy"];
  // Each call that classifies the message or judges a duplicate.
  classificationSeconds: number[];
  // Each call that turns a question into a vector.
  embeddingSeconds: number[];
  // Each step of the agent: one call to the model and the tools it asked for.
  stepSeconds: number[];
  stepStarts: number[];
  totalSeconds: number;
  error?: string;
}

function newMeasure(name: string): Measure {
  return {
    case: name,
    type: "-",
    modelCalls: 0,
    cutBy: undefined,
    classificationSeconds: [],
    embeddingSeconds: [],
    stepSeconds: [],
    stepStarts: [],
    totalSeconds: 0,
  };
}

// Vitest hides the console of a passed test outside a terminal, so the report is written to the
// standard output directly.
const print = (line: string) => process.stdout.write(`${line}\n`);

const secondsSince = (started: number) => (performance.now() - started) / 1000;

async function timed<T>(record: number[], call: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await call();
  } finally {
    record.push(secondsSince(started));
  }
}

// A model is loaded into memory by its first call, which then takes longer. Unloading the models
// first makes the measures include that wait, as after a restart of Ollama.
async function unloadModel(baseUrl: string, apiKey: string | undefined, model: string) {
  const response = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: ollamaHeaders(apiKey),
    body: JSON.stringify({ model, keep_alive: 0 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama did not unload ${model}: HTTP ${response.status}`);
  }
}

// A database next to the test database, on the same server, so the tests and this measure never
// empty each other's data.
function measureDatabaseUrl(testDatabaseUrl: string): string {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${disposableDatabaseName(testDatabaseUrl).replace(/_test$/, "_eval_test")}`;
  return url.href;
}

const slowest = (values: number[]) => Math.max(0, ...values);
const format = (seconds: number) => `${seconds.toFixed(1)} s`;

function reportMeasures(measures: Measure[]): void {
  print(
    "\nMessage | type | model calls | limit that cut it | slowest call: classification, step | total",
  );
  for (const m of measures) {
    print(
      `${m.case} | ${m.type} | ${m.modelCalls} | ${m.cutBy ?? "none"} | ` +
        `${format(slowest(m.classificationSeconds))}, ${format(slowest(m.stepSeconds))} | ${format(m.totalSeconds)}` +
        (m.error === undefined ? "" : ` | error: ${m.error}`),
    );
  }
}

function checkLimit(name: string, neededSeconds: number, setMs: number): void {
  const needed = Math.ceil(neededSeconds);
  const set = setMs / 1000;
  print(
    `  ${name}: at least ${needed} s from these measures; set to ${set} s: ${set >= needed ? "enough" : "too short"}`,
  );
}

function reportLimits(measures: Measure[], limits: HandlingLimits): void {
  const most = measures.reduce((a, b) => (b.modelCalls > a.modelCalls ? b : a));
  const cut = measures.filter((m) => m.cutBy !== undefined);
  print(
    `\nStep limit: ${maxAgentSteps} steps, plus ${maxAnswerRetries} answer written again after a rejection.`,
  );
  print(`  Most model calls for one message: ${most.modelCalls} (${most.case}).`);
  print(
    `  Runs cut by a limit: ${cut.length === 0 ? "none" : cut.map((m) => `${m.case} (${m.cutBy})`).join(", ")}.`,
  );
  const all = (pick: (m: Measure) => number[]) => measures.flatMap(pick);
  print("\nTime limits, from the slowest call measured:");
  checkLimit(
    "CLASSIFICATION_TIMEOUT_SECONDS",
    slowest(all((m) => m.classificationSeconds)),
    limits.classificationTimeoutMs,
  );
  checkLimit(
    "EMBEDDING_TIMEOUT_SECONDS",
    slowest(all((m) => m.embeddingSeconds)),
    limits.embeddingTimeoutMs,
  );
  // The longest run the step limit allows, every step as slow as the slowest one measured.
  checkLimit(
    `AGENT_TIMEOUT_SECONDS = (${maxAgentSteps} + ${maxAnswerRetries}) x slowest step`,
    (maxAgentSteps + maxAnswerRetries) * slowest(all((m) => m.stepSeconds)),
    limits.agentTimeoutMs,
  );
}

it("measures the agent with the real model", async () => {
  if (existsSync(rootEnvFile)) {
    process.loadEnvFile(rootEnvFile);
  }
  // No data leaves the machine (decision 001), as in the server.
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";
  const limits = loadHandlingLimits();
  const classifierEnv = loadClassifierEnv();
  const { OLLAMA_EMBEDDING_MODEL } = loadKnowledgeEnv();
  const { OLLAMA_BASE_URL: baseUrl, OLLAMA_API_KEY: apiKey, OLLAMA_MODEL: model } = classifierEnv;
  const samples = sampleSchema.parse(
    JSON.parse(readFileSync(new URL("agent-messages.json", import.meta.url), "utf8")),
  );
  const databaseUrl = measureDatabaseUrl(loadTestDatabaseEnv().TEST_DATABASE_URL);
  const serverDatabaseUrl = loadServerDatabaseEnv().SERVER_DATABASE_URL;

  // A database left by an interrupted measure is dropped first.
  await dropDatabaseIfExists(databaseUrl);
  await createDatabaseIfMissing(databaseUrl);
  await prepareDatabase(databaseUrl, loadAppDatabaseEnv().APP_DATABASE_URL, serverDatabaseUrl);
  const owner = connectDatabase(databaseUrl);
  const server = connectDatabase(asRole(databaseUrl, serverDatabaseUrl));
  try {
    const ollamaOptions = { baseUrl, model, timeoutMs: measureTimeoutMs, apiKey };
    const embedder = createOllamaEmbedder({ ...ollamaOptions, model: OLLAMA_EMBEDDING_MODEL });
    await seedDatabase(owner.db);
    for (const article of demoArticles) {
      // One article at a time, as `pnpm kb:import` does.
      // oxlint-disable-next-line no-await-in-loop
      await saveArticle(owner.db, embedder, article);
    }
    await unloadModel(baseUrl, apiKey, model);
    await unloadModel(baseUrl, apiKey, OLLAMA_EMBEDDING_MODEL);

    let current = newMeasure("");
    const classify = createOllamaClassifier(ollamaOptions);
    const judge = createOllamaDuplicateJudge(ollamaOptions);
    const timedClassify: Classifier = async (input) => {
      const classification = await timed(current.classificationSeconds, () => classify(input));
      current.type = classification.type;
      return classification;
    };
    const timedJudge: DuplicateJudge = (input) =>
      timed(current.classificationSeconds, () => judge(input));
    const timedEmbedder: Embedder = {
      model: embedder.model,
      embed: (texts, kind) => timed(current.embeddingSeconds, () => embedder.embed(texts, kind)),
    };
    // The same model as the server, which notes when each of its calls starts.
    const base = createOllama({
      baseURL: baseUrl,
      headers: apiKey === undefined ? undefined : { authorization: `Bearer ${apiKey}` },
    })(model);
    const timedModel = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "doGenerate") {
          return (...args: Parameters<typeof base.doGenerate>) => {
            current.stepStarts.push(performance.now());
            return target.doGenerate(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const agent = createRequestAgent(timedModel);

    const measures: Measure[] = [];
    for (const [index, sample] of samples.entries()) {
      current = newMeasure(sample.case);
      const started = performance.now();
      try {
        // Messages are handled one at a time, like in a channel, to measure the real latency.
        // oxlint-disable-next-line no-await-in-loop
        const stored = await storeInboundMessage(server.db, {
          channel: sample.channel,
          conversationExternalId: sample.thread,
          externalId: `eval-${index}`,
          sender: sample.sender,
          subject: sample.subject ?? null,
          bodyText: sample.text,
          raw: {},
          sentAt: new Date(),
        });
        const measure = current;
        // oxlint-disable-next-line no-await-in-loop
        await handleMessage(
          agent,
          server.db,
          {
            messageId: stored.messageId,
            trust: sample.trust,
            channelAddress: sample.channelAddress ?? null,
          },
          {
            classify: timedClassify,
            judgeDuplicate: timedJudge,
            reviewThreshold: classifierEnv.CLASSIFICATION_REVIEW_THRESHOLD,
            searchKnowledge: (actor, question) =>
              searchKnowledge(server.db, timedEmbedder, actor, question),
            agentTimeoutMs: measureTimeoutMs,
            onAgentRun: (run) => {
              const ended = performance.now();
              measure.modelCalls = run.modelCalls;
              measure.cutBy = run.cutBy;
              measure.stepSeconds = measure.stepStarts.map(
                (start, step) => ((measure.stepStarts[step + 1] ?? ended) - start) / 1000,
              );
            },
          },
        );
      } catch (error) {
        current.error = error instanceof Error ? error.message : String(error);
      }
      current.totalSeconds = secondsSince(started);
      print(`Measured: ${current.case}, ${format(current.totalSeconds)}`);
      measures.push(current);
    }
    reportMeasures(measures);
    reportLimits(measures, limits);
    // A message that failed has incomplete measures, so the measure as a whole fails.
    expect(
      measures.filter((m) => m.error !== undefined).map((m) => `${m.case}: ${m.error}`),
    ).toEqual([]);
  } finally {
    await server.close();
    await owner.close();
    await dropDatabaseIfExists(databaseUrl);
  }
});
