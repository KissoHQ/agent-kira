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

  it("reads how long the attached files are kept, 40 days unless set", () => {
    expect(loadWebEnv(required).ATTACHMENT_RETENTION_DAYS).toBe(40);
    expect(
      loadWebEnv({ ...required, ATTACHMENT_RETENTION_DAYS: "" }).ATTACHMENT_RETENTION_DAYS,
    ).toBe(40);
    expect(
      loadWebEnv({ ...required, ATTACHMENT_RETENTION_DAYS: "90" }).ATTACHMENT_RETENTION_DAYS,
    ).toBe(90);
    expect(() => loadWebEnv({ ...required, ATTACHMENT_RETENTION_DAYS: "0" })).toThrow(
      /ATTACHMENT_RETENTION_DAYS/,
    );
  });

  it("reads an empty address or port as not set", () => {
    expect(loadWebEnv({ ...required, WEB_HOST: "", WEB_PORT: "" })).toMatchObject({
      WEB_HOST: "127.0.0.1",
      WEB_PORT: 4112,
    });
    expect(loadWebEnv({ ...required, WEB_PORT: "8080" }).WEB_PORT).toBe(8080);
  });

  it("reads the public origin of the interface, and refuses one with a path", () => {
    expect(
      loadWebEnv({ ...required, WEB_PUBLIC_ORIGIN: "https://kira.example.com" }).WEB_PUBLIC_ORIGIN,
    ).toBe("https://kira.example.com");
    expect(loadWebEnv({ ...required, WEB_PUBLIC_ORIGIN: "" }).WEB_PUBLIC_ORIGIN).toBeUndefined();
    expect(() =>
      loadWebEnv({ ...required, WEB_PUBLIC_ORIGIN: "https://kira.example.com/app" }),
    ).toThrow(/WEB_PUBLIC_ORIGIN/);
  });

  it("trusts the proxy only when asked", () => {
    expect(loadWebEnv({ ...required, WEB_TRUST_PROXY: "true" }).WEB_TRUST_PROXY).toBe(true);
    expect(() => loadWebEnv({ ...required, WEB_TRUST_PROXY: "maybe" })).toThrow(/WEB_TRUST_PROXY/);
  });
});
