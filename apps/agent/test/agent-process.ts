import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds an agent of eve and starts it in its own process, as in production, for the tests and
// the measure of the agent.

// The agent of KIRA, with Ollama.
export const productionAgentRoot = fileURLToPath(new URL("../", import.meta.url));

// Longest wait for the build, then for the agent to answer.
const buildTimeoutMs = 300_000;
const startTimeoutMs = 60_000;

// eve sends its usage statistics to Vercel unless EVE_TELEMETRY_DISABLED is set. With NODE_ENV set
// to test, as Vitest does, eve replaces the model of the agent with one of its own: the agent runs
// as in production.
const agentEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...process.env,
  ...env,
  EVE_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
});

const eveOf = (root: string) => join(root, "node_modules", ".bin", "eve");

function collect(child: ChildProcess): () => string {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return () => output;
}

export async function buildAgent(root: string): Promise<void> {
  const child = spawn(eveOf(root), ["build"], {
    cwd: root,
    env: agentEnvironment({}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  const timer = setTimeout(() => child.kill(), buildTimeoutMs);
  await once(child, "exit");
  clearTimeout(timer);
  if (child.exitCode !== 0) {
    throw new Error(`The build of the agent in ${root} failed:\n${output()}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("No free port"));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The agent stopped:\n${output()}`);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(`${url}/eve/v1/kira/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(`The agent did not start:\n${output()}`);
}

export interface AgentProcess {
  url: string;
  stop: () => Promise<void>;
}

// Starts a built agent on a free port of this machine, and waits until it is ready.
export async function startAgent(root: string, env: NodeJS.ProcessEnv): Promise<AgentProcess> {
  const port = await freePort();
  const child = spawn(eveOf(root), ["start", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: agentEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  const url = `http://127.0.0.1:${port}`;
  await waitUntilReady(url, child, output);
  return {
    url,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
    },
  };
}
