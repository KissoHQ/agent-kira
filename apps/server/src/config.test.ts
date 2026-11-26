import { describe, expect, it } from "vitest";

import {
  loadEmailEnv,
  loadEnv,
  loadHandlingLimits,
  loadSlackTokens,
  loadWidgetEnv,
} from "./config";

const validEnv = {
  OLLAMA_BASE_URL: "http://127.0.0.1:11434/api",
  OLLAMA_MODEL: "ornith:9b",
};

describe("loadEnv", () => {
  it("returns the parsed configuration when every variable is valid", () => {
    expect(
      loadEnv({ ...validEnv, MASTRA_HOST: "0.0.0.0", OLLAMA_API_KEY: "key", LOG_LEVEL: "warn" }),
    ).toEqual({
      ...validEnv,
      MASTRA_HOST: "0.0.0.0",
      OLLAMA_API_KEY: "key",
      LOG_LEVEL: "warn",
    });
  });

  it("logs at the info level and sends no key to Ollama by default", () => {
    expect(loadEnv({ ...validEnv, OLLAMA_API_KEY: "" })).toMatchObject({
      LOG_LEVEL: "info",
      OLLAMA_API_KEY: undefined,
    });
  });

  it("rejects an Ollama URL without /api, which answers 404 to every call", () => {
    expect(() => loadEnv({ ...validEnv, OLLAMA_BASE_URL: "http://127.0.0.1:11434" })).toThrow(
      /Must end with \/api/,
    );
  });

  it("listens on this machine only by default, including with an empty value", () => {
    expect(loadEnv(validEnv).MASTRA_HOST).toBe("127.0.0.1");
    expect(loadEnv({ ...validEnv, MASTRA_HOST: "" }).MASTRA_HOST).toBe("127.0.0.1");
  });

  it("rejects a base URL that is not a URL", () => {
    expect(() => loadEnv({ ...validEnv, OLLAMA_BASE_URL: "localhost" })).toThrow(/OLLAMA_BASE_URL/);
  });

  it("rejects a missing model", () => {
    expect(() => loadEnv({ OLLAMA_BASE_URL: validEnv.OLLAMA_BASE_URL })).toThrow(/OLLAMA_MODEL/);
  });
});

describe("loadHandlingLimits", () => {
  it("keeps the limits measured on a CPU when none is set, including with empty values", () => {
    const defaults = {
      classificationTimeoutMs: 300_000,
      agentTimeoutMs: 900_000,
      embeddingTimeoutMs: 60_000,
    };
    expect(loadHandlingLimits({})).toEqual(defaults);
    expect(
      loadHandlingLimits({
        CLASSIFICATION_TIMEOUT_SECONDS: "",
        AGENT_TIMEOUT_SECONDS: "",
        EMBEDDING_TIMEOUT_SECONDS: "",
      }),
    ).toEqual(defaults);
  });

  it("reads the limits measured on the machine that runs Ollama, in seconds", () => {
    expect(
      loadHandlingLimits({
        CLASSIFICATION_TIMEOUT_SECONDS: "30",
        AGENT_TIMEOUT_SECONDS: "240",
        EMBEDDING_TIMEOUT_SECONDS: "5",
      }),
    ).toEqual({
      classificationTimeoutMs: 30_000,
      agentTimeoutMs: 240_000,
      embeddingTimeoutMs: 5000,
    });
  });

  it.each(["0", "-5", "1.5", "ten", "2147484"])(
    "rejects %s, which is not a whole number of seconds a timer of Node.js can wait",
    (value) => {
      expect(() => loadHandlingLimits({ AGENT_TIMEOUT_SECONDS: value })).toThrow(
        /AGENT_TIMEOUT_SECONDS/,
      );
    },
  );

  it("accepts the longest wait a timer of Node.js can hold", () => {
    expect(loadHandlingLimits({ AGENT_TIMEOUT_SECONDS: "2147483" }).agentTimeoutMs).toBe(
      2_147_483_000,
    );
  });
});

describe("loadSlackTokens", () => {
  const tokens = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" };

  it("returns the two tokens when Slack is configured", () => {
    expect(loadSlackTokens(tokens)).toEqual({ botToken: "xoxb-1", appToken: "xapp-1" });
  });

  it("is undefined when Slack is not configured, including with empty values", () => {
    expect(loadSlackTokens({})).toBeUndefined();
    expect(loadSlackTokens({ SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "" })).toBeUndefined();
  });

  it("rejects only one of the two tokens", () => {
    expect(() => loadSlackTokens({ SLACK_BOT_TOKEN: "xoxb-1" })).toThrow(/set together/);
  });

  it("rejects a token of the wrong kind, such as a user token", () => {
    expect(() => loadSlackTokens({ ...tokens, SLACK_BOT_TOKEN: "xoxp-1" })).toThrow(/xoxb-/);
  });
});

describe("loadEmailEnv", () => {
  const local = {
    EMAIL_USER: "agent",
    EMAIL_PASSWORD: "secret",
    EMAIL_ADDRESS: "agent@requests.example",
    EMAIL_IMAP_HOST: "127.0.0.1",
    EMAIL_IMAP_PORT: "3143",
    EMAIL_SMTP_HOST: "127.0.0.1",
    EMAIL_SMTP_PORT: "3025",
    EMAIL_SECURE: "false",
  };

  it("is undefined when no mailbox is configured", () => {
    expect(loadEmailEnv({})).toBeUndefined();
  });

  it("reads the mailbox settings, with TLS and no sender trust by default", () => {
    const { EMAIL_SECURE: _secure, ...withoutSecure } = local;

    expect(loadEmailEnv(withoutSecure)).toMatchObject({
      EMAIL_IMAP_PORT: 3143,
      EMAIL_SECURE: true,
      EMAIL_TRUST_LOCAL_SENDERS: false,
    });
  });

  it("trusts every sender only for a mailbox on this machine", () => {
    expect(
      loadEmailEnv({ ...local, EMAIL_TRUST_LOCAL_SENDERS: "true" })?.EMAIL_TRUST_LOCAL_SENDERS,
    ).toBe(true);
    expect(() =>
      loadEmailEnv({
        ...local,
        EMAIL_IMAP_HOST: "imap.gmail.com",
        EMAIL_TRUST_LOCAL_SENDERS: "true",
      }),
    ).toThrow(/only allowed with a mailbox on this machine/);
  });

  it("rejects an invalid address", () => {
    expect(() => loadEmailEnv({ ...local, EMAIL_ADDRESS: "agent" })).toThrow(/EMAIL_ADDRESS/);
  });

  it("refuses to connect without TLS to a mail server on another machine", () => {
    for (const host of [
      { EMAIL_IMAP_HOST: "imap.gmail.com" },
      { EMAIL_SMTP_HOST: "smtp.gmail.com" },
    ]) {
      expect(() => loadEmailEnv({ ...local, ...host })).toThrow(
        /EMAIL_SECURE=false is only allowed with mail servers on this machine/,
      );
    }
    expect(
      loadEmailEnv({ ...local, EMAIL_IMAP_HOST: "imap.gmail.com", EMAIL_SECURE: "true" })
        ?.EMAIL_SECURE,
    ).toBe(true);
  });
});

describe("loadWidgetEnv", () => {
  const widget = {
    WIDGET_ALLOWED_ORIGINS: "https://portal.example.com, http://localhost:4114",
    ATTACHMENTS_DIR: "/var/lib/request-agent/attachments",
  };

  it("is undefined when no origin is set, so the server runs without the widget", () => {
    expect(loadWidgetEnv({})).toBeUndefined();
    expect(loadWidgetEnv({ WIDGET_ALLOWED_ORIGINS: "" })).toBeUndefined();
  });

  it("reads the origins, and no secret when none is set", () => {
    expect(loadWidgetEnv({ ...widget, WIDGET_IDENTITY_SECRETS: "" })).toEqual({
      WIDGET_ALLOWED_ORIGINS: ["https://portal.example.com", "http://localhost:4114"],
      WIDGET_IDENTITY_SECRETS: new Map(),
      ATTACHMENTS_DIR: "/var/lib/request-agent/attachments",
      WIDGET_HOST: "127.0.0.1",
      WIDGET_PORT: 4113,
      WIDGET_TRUST_PROXY: false,
      WIDGET_ATTACHMENTS_QUOTA_MB: 2048,
    });
    expect(loadWidgetEnv(widget)?.WIDGET_IDENTITY_SECRETS).toEqual(new Map());
  });

  it("reads the quota of the attached files, in megabytes", () => {
    expect(
      loadWidgetEnv({ ...widget, WIDGET_ATTACHMENTS_QUOTA_MB: "500" })?.WIDGET_ATTACHMENTS_QUOTA_MB,
    ).toBe(500);
    expect(
      loadWidgetEnv({ ...widget, WIDGET_ATTACHMENTS_QUOTA_MB: "" })?.WIDGET_ATTACHMENTS_QUOTA_MB,
    ).toBe(2048);
    expect(() => loadWidgetEnv({ ...widget, WIDGET_ATTACHMENTS_QUOTA_MB: "0" })).toThrow(
      /WIDGET_ATTACHMENTS_QUOTA_MB/,
    );
  });

  it("listens on this machine only, on its own port, unless told otherwise", () => {
    const set = loadWidgetEnv({ ...widget, WIDGET_HOST: "0.0.0.0", WIDGET_PORT: "8080" });
    expect([set?.WIDGET_HOST, set?.WIDGET_PORT]).toEqual(["0.0.0.0", 8080]);
    const empty = loadWidgetEnv({ ...widget, WIDGET_HOST: "", WIDGET_PORT: "" });
    expect([empty?.WIDGET_HOST, empty?.WIDGET_PORT]).toEqual(["127.0.0.1", 4113]);
    expect(() => loadWidgetEnv({ ...widget, WIDGET_PORT: "70000" })).toThrow(/WIDGET_PORT/);
  });

  it("trusts a reverse proxy only when asked", () => {
    expect(loadWidgetEnv({ ...widget, WIDGET_TRUST_PROXY: "true" })?.WIDGET_TRUST_PROXY).toBe(true);
    expect(() => loadWidgetEnv({ ...widget, WIDGET_TRUST_PROXY: "maybe" })).toThrow(
      /WIDGET_TRUST_PROXY/,
    );
  });

  it("reads one secret per project", () => {
    const portal = "p".repeat(32);
    const shop = "s".repeat(40);

    expect(
      loadWidgetEnv({ ...widget, WIDGET_IDENTITY_SECRETS: ` portal=${portal} , SHOP=${shop}` })
        ?.WIDGET_IDENTITY_SECRETS,
    ).toEqual(
      new Map([
        ["PORTAL", portal],
        ["SHOP", shop],
      ]),
    );
  });

  it("refuses a secret without project, a short secret or a project given twice", () => {
    const secret = "x".repeat(32);
    for (const value of [secret, "PORTAL=short", `PORTAL=${secret},portal=${secret}`]) {
      expect(() => loadWidgetEnv({ ...widget, WIDGET_IDENTITY_SECRETS: value })).toThrow(
        /WIDGET_IDENTITY_SECRETS/,
      );
    }
  });

  it("refuses an origin with a path or a relative folder", () => {
    expect(() =>
      loadWidgetEnv({ ...widget, WIDGET_ALLOWED_ORIGINS: "https://portal.example.com/app" }),
    ).toThrow(/WIDGET_ALLOWED_ORIGINS/);
    expect(() => loadWidgetEnv({ ...widget, ATTACHMENTS_DIR: "attachments" })).toThrow(
      /ATTACHMENTS_DIR/,
    );
  });
});
