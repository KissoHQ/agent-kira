import { isAbsolute } from "node:path";

import { z } from "zod";

const envSchema = z.object({
  OLLAMA_BASE_URL: z.url(),
  OLLAMA_MODEL: z.string().min(1),
  // Address the server listens on. Only this machine by default: a reverse proxy or a container
  // that publishes the widget sets it to 0.0.0.0.
  MASTRA_HOST: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).default("127.0.0.1"),
  ),
});

// An empty value in .env means the variable is not set.
const optionalToken = (prefix: string) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().startsWith(prefix, `Must start with ${prefix}`).optional(),
  );

// Slack is optional: without its two tokens, the server runs without it. With only one of them,
// the configuration is a mistake.
const slackEnvSchema = z
  .object({
    SLACK_BOT_TOKEN: optionalToken("xoxb-"),
    SLACK_APP_TOKEN: optionalToken("xapp-"),
  })
  .refine((env) => (env.SLACK_BOT_TOKEN === undefined) === (env.SLACK_APP_TOKEN === undefined), {
    message: "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set together",
  });

const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);

// Email is optional, like Slack: without an IMAP server, the server runs without it.
const emailEnvSchema = z
  .object({
    EMAIL_USER: z.string().min(1),
    EMAIL_PASSWORD: z.string().min(1),
    EMAIL_ADDRESS: z.email(),
    EMAIL_IMAP_HOST: z.string().min(1),
    EMAIL_IMAP_PORT: z.coerce.number().int().positive(),
    EMAIL_SMTP_HOST: z.string().min(1),
    EMAIL_SMTP_PORT: z.coerce.number().int().positive(),
    EMAIL_SECURE: z.stringbool().default(true),
    EMAIL_TRUSTED_AUTHSERV_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().optional(),
    ),
    EMAIL_TRUST_LOCAL_SENDERS: z.stringbool().default(false),
  })
  .refine((env) => !env.EMAIL_TRUST_LOCAL_SENDERS || localHosts.has(env.EMAIL_IMAP_HOST), {
    message: "EMAIL_TRUST_LOCAL_SENDERS is only allowed with a mailbox on this machine",
    path: ["EMAIL_TRUST_LOCAL_SENDERS"],
  })
  // Without TLS from the start, the password and the emails cross the network in clear, and the
  // clients go on in clear if someone in between removes the offer of STARTTLS. Only the local
  // mail server of the tests, on this machine, may do without it.
  .refine(
    (env) =>
      env.EMAIL_SECURE ||
      (localHosts.has(env.EMAIL_IMAP_HOST) && localHosts.has(env.EMAIL_SMTP_HOST)),
    {
      message:
        "EMAIL_SECURE=false is only allowed with mail servers on this machine: use the TLS ports, such as 993 and 465",
      path: ["EMAIL_SECURE"],
    },
  );

// An origin alone, such as https://portal.example.com: no path, no trailing slash.
const origin = z
  .url()
  .refine((value) => new URL(value).origin === value, { message: "Must be an origin only" });

const projectKey = /^[A-Z][A-Z0-9]{1,9}$/;
const minSecretLength = 32;

// "PORTAL=secret,SHOP=other-secret" as a map from project key to secret.
function parseIdentitySecrets(
  value: string,
  context: z.RefinementCtx,
): ReadonlyMap<string, string> {
  const secrets = new Map<string, string>();
  for (const entry of value.split(",").filter((item) => item.trim() !== "")) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, Math.max(separator, 0)).trim().toUpperCase();
    const secret = entry.slice(separator + 1).trim();
    if (separator < 0 || !projectKey.test(key)) {
      context.addIssue({ code: "custom", message: "Each entry must be PROJECT=secret" });
    } else if (secret.length < minSecretLength) {
      context.addIssue({ code: "custom", message: `The secret of ${key} is too short` });
    } else if (secrets.has(key)) {
      context.addIssue({ code: "custom", message: `${key} is given twice` });
    } else {
      secrets.set(key, secret);
    }
  }
  return secrets;
}

// The widget is optional, like Slack and email: without the origins of the applications that
// embed it, the server runs without it.
const widgetEnvSchema = z.object({
  WIDGET_ALLOWED_ORIGINS: z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim()))
    .pipe(z.array(origin).min(1)),
  // One secret per project, shared with the application of that project only, which signs the
  // identity of the person signed in: "PORTAL=secret,SHOP=other-secret". Optional: without it,
  // every person who writes through the widget is unverified.
  WIDGET_IDENTITY_SECRETS: z.preprocess(
    (value) => (value === "" || value === undefined ? "" : value),
    z.string().transform(parseIdentitySecrets),
  ),
  ATTACHMENTS_DIR: z.string().refine(isAbsolute, { message: "Must be an absolute path" }),
  // Set to true only behind a reverse proxy that adds the address of the person to X-Forwarded-For,
  // so the limits of the widget count people and not the proxy.
  WIDGET_TRUST_PROXY: z.stringbool().default(false),
  // Most space the attached files may take, in megabytes: beyond, new files are refused.
  WIDGET_ATTACHMENTS_QUOTA_MB: z.coerce.number().int().min(1).default(2048),
});

export type Env = z.infer<typeof envSchema>;
export type WidgetEnv = z.infer<typeof widgetEnvSchema>;
export type EmailEnv = z.infer<typeof emailEnvSchema>;
export interface SlackTokens {
  botToken: string;
  appToken: string;
}

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parse(envSchema, source);
}

// The Slack tokens, or undefined when Slack is not configured.
export function loadSlackTokens(source: NodeJS.ProcessEnv = process.env): SlackTokens | undefined {
  const env = parse(slackEnvSchema, source);
  if (env.SLACK_BOT_TOKEN === undefined || env.SLACK_APP_TOKEN === undefined) {
    return undefined;
  }
  return { botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN };
}

// The mailbox settings, or undefined when email is not configured.
export function loadEmailEnv(source: NodeJS.ProcessEnv = process.env): EmailEnv | undefined {
  if (source.EMAIL_IMAP_HOST === undefined || source.EMAIL_IMAP_HOST === "") {
    return undefined;
  }
  return parse(emailEnvSchema, source);
}

// The widget settings, or undefined when the widget is not configured.
export function loadWidgetEnv(source: NodeJS.ProcessEnv = process.env): WidgetEnv | undefined {
  if (source.WIDGET_ALLOWED_ORIGINS === undefined || source.WIDGET_ALLOWED_ORIGINS === "") {
    return undefined;
  }
  return parse(widgetEnvSchema, source);
}
