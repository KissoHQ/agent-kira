import { describe, expect, it } from "vitest";

import { loadWebEnv } from "./config.ts";

const required = {
  APP_DATABASE_URL: "postgresql://request_agent_app:secret@127.0.0.1:5433/request_agent",
};

describe("loadWebEnv", () => {
  it("listens on this machine and trusts no proxy by default", () => {
    expect(loadWebEnv(required)).toMatchObject({
      WEB_HOST: "127.0.0.1",
      WEB_PORT: 4112,
      WEB_TRUST_PROXY: false,
      WEB_TIME_ZONE: "Europe/Paris",
    });
  });

  it("trusts the proxy only when asked", () => {
    expect(loadWebEnv({ ...required, WEB_TRUST_PROXY: "true" }).WEB_TRUST_PROXY).toBe(true);
    expect(() => loadWebEnv({ ...required, WEB_TRUST_PROXY: "maybe" })).toThrow(/WEB_TRUST_PROXY/);
  });
});
