import type { MiddlewareHandler } from "hono";

// Names a browser uses for this machine. A page of another site that makes its own name point
// to 127.0.0.1 (DNS rebinding) still sends its own name, so it is refused.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  try {
    return loopbackHostnames.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

// A browser sends the origin of the page on every request that is not a plain navigation. Studio
// runs on the server itself, so any other origin is a page of another site.
function isOwnOrigin(origin: string | undefined, host: string | undefined): boolean {
  return origin === undefined || origin === `http://${host}` || origin === `https://${host}`;
}

const notFound = { error: "Not found" };

// Guards the routes Mastra serves besides the widget, which are public and check who writes
// themselves. The agent API and Studio let a caller run the agent, read its instructions and
// change its model, with no sign-in: the channels never need them, so a running server serves
// none of them. With `mastra dev`, they stay available to test the agent on this machine only.
export function apiGuard(options: { development: boolean }): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/health") {
      return next();
    }
    if (!options.development) {
      return c.json(notFound, 404);
    }
    const host = c.req.header("host");
    if (!isLoopbackHost(host) || !isOwnOrigin(c.req.header("origin"), host)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  };
}
