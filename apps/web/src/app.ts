import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  authenticateStaff,
  changeRequestStatus,
  changeStatusInput,
  closeSession,
  type Database,
  findSession,
  getRequestRecord,
  getStoredAttachment,
  listProjects,
  listRequests,
  listRequestsInput,
  listReviewQueue,
  markDuplicate,
  markDuplicateInput,
  openSession,
  pingDatabase,
  reviewRequest,
  reviewRequestInput,
  type StaffMember,
} from "@request-agent/core";
import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import { registerAdministration } from "./admin.ts";
import { createCheckQueue } from "./password-checks.ts";
import {
  type Admission,
  addressLimits,
  createAttemptLimiter,
  emailLimits,
} from "./sign-in-limiter.ts";
import { dateFormatter } from "./views/labels.ts";
import { icon } from "./views/icon.ts";
import type { Fragment, ViewContext } from "./views/layout.ts";
import { type Notice, notices, requestPage } from "./views/request.ts";
import { requestListPage, reviewQueuePage } from "./views/requests.ts";
import { script } from "./views/script.ts";
import { signInPage } from "./views/sign-in.ts";
import { stylesheet } from "./views/style.ts";

export interface WebAppOptions {
  db: Database;
  timeZone: string;
  // Behind a reverse proxy, every request comes from the proxy: the address of the person is the
  // last one the proxy added to X-Forwarded-For. Only set it when such a proxy is in front.
  trustProxy?: boolean;
  // Called when a request fails unexpectedly, so the error is logged without being shown.
  onError?: (error: Error) => void;
  // Called for each sign-in, refused or not, and each sign-out, so an attack on the accounts shows
  // in the logs (OWASP Logging Cheat Sheet). Never with a password.
  onAudit?: (event: string) => void;
  // Origin of the interface as people reach it, such as https://kira.example.com. Behind a reverse
  // proxy, the request the interface sees has another origin, and forms would be refused.
  publicOrigin?: string;
  // Folder where the widget writes the files people attach. Without it, no file is downloaded.
  attachmentsDir?: string;
}

export type WebEnv = {
  Bindings: Partial<HttpBindings>;
  Variables: { staff: StaffMember; sessionToken: string };
};
type Env = WebEnv;

// Sent as __Host-session: the browser then refuses one set by another site of the same domain, or
// for a narrower path, so nobody can make a person work in a session they chose.
const sessionCookie = "session";
const cookiePrefix = "host";
const invalidCredentials = "E-mail ou mot de passe incorrect.";
const busy = "Trop de connexions en cours. Réessayez dans quelques secondes.";
const busyRetryAfterSeconds = 5;

const tooManyAttempts = (retryAfterMs: number) =>
  `Trop de tentatives. Réessayez dans ${Math.ceil(retryAfterMs / 60_000)} minutes.`;

// The address the request comes from, as the limiter of sign-in attempts counts it.
function clientAddress(c: Context<Env>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded !== undefined && forwarded !== "") {
      return forwarded;
    }
  }
  return c.env?.incoming?.socket.remoteAddress ?? "unknown";
}

// The forms of the interface are a few short fields. A larger body is refused before it is read,
// so nobody can fill the memory of the server, even without a session.
const maxFormBytes = 64 * 1024;
// No account can have a longer email (RFC 5321), so a longer one is refused without the cost of
// checking a password, and is not kept by the sign-in limiter.
const maxEmailLength = 254;

const isNotice = (value: string): value is Notice => Object.hasOwn(notices, value);

// The request changed between the moment the person opened it and their action: the page shows it
// again as it is now, so they decide on what they see.
const changedMeanwhile =
  "La demande a changé pendant que vous la consultiez : vérifiez-la ci-dessous, puis recommencez.";

const duplicateErrors = {
  NOT_FOUND: "Demande d'origine introuvable.",
  SAME_REQUEST: "Une demande ne peut pas être le doublon d'elle-même.",
  ORIGINAL_IS_DUPLICATE:
    "Cette demande est elle-même un doublon fermé : indiquez la demande d'origine qu'elle désigne.",
} as const;

// Files are written by the widget under random UUIDs, so a stored name is never a path.
const storageRef = z.uuid();

// A file name for the download, readable by every browser (RFC 6266 and RFC 8187).
function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// The content of a stored file, or undefined when it is missing or files are not kept. Any other
// failure, such as a folder the server cannot read, is an error, not a missing file.
async function readStoredFile(
  folder: string | undefined,
  ref: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (folder === undefined || !storageRef.safeParse(ref).success) {
    return undefined;
  }
  return readFile(join(folder, ref)).then(
    (buffer) => new Uint8Array(buffer),
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    },
  );
}

// The page to go back to after signing in: only a path of this site, never another site.
function safeNext(value: string | undefined): string {
  return value !== undefined && /^\/(?![/\\])/.test(value) ? value : "/";
}

// Empty form fields leave a value unchanged.
function formValue(form: Record<string, unknown>, name: string): string | undefined {
  const value = form[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function createWebApp(options: WebAppOptions) {
  const { db } = options;
  const emailLimiter = createAttemptLimiter(emailLimits);
  const addressLimiter = createAttemptLimiter(addressLimits);
  const passwordChecks = createCheckQueue();
  const trustProxy = options.trustProxy ?? false;
  const formatDate = dateFormatter(options.timeZone);
  const app = new Hono<Env>();
  const view = (c: Context<Env>): ViewContext => ({ staff: c.get("staff"), formatDate });
  const render = (
    c: Context<Env>,
    fragment: Fragment,
    status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 503 = 200,
  ) => c.html(fragment, status);
  const audit = (event: string) => {
    options.onAudit?.(event);
  };
  const refuse = (
    c: Context<Env>,
    admission: Admission & { allowed: false },
    email: string,
    next: string,
  ) => {
    audit(`Sign-in refused for ${email}: too many attempts`);
    c.header("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
    return render(c, signInPage(tooManyAttempts(admission.retryAfterMs), email, next), 429);
  };

  // Only the script and stylesheet of this site: nothing inline and no resource from elsewhere
  // (OWASP Secure Headers Project). The script may only fetch pages of this site.
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    }),
  );
  // Forms are only accepted from pages of this site, checked with the Origin and Sec-Fetch-Site
  // headers that browsers send.
  app.use(csrf(options.publicOrigin === undefined ? {} : { origin: options.publicOrigin }));
  app.use(bodyLimit({ maxSize: maxFormBytes, onError: (c) => c.text("Payload Too Large", 413) }));
  app.use(async (c, next) => {
    await next();
    // Pages show private data: browsers and proxies must not keep them.
    if (c.res.headers.get("content-type")?.startsWith("text/html") === true) {
      c.header("Cache-Control", "no-store");
    }
  });

  app.get("/health", (c) => c.text("ok"));
  // Ready only when the database answers, so an orchestrator sends no one to a broken interface.
  app.get("/ready", async (c) =>
    (await pingDatabase(db)) ? c.text("ready") : c.text("database unreachable", 503),
  );
  app.get("/app.css", (c) =>
    c.body(stylesheet, 200, { "Content-Type": "text/css; charset=utf-8" }),
  );
  app.get("/favicon.svg", (c) => c.body(icon, 200, { "Content-Type": "image/svg+xml" }));
  app.get("/app.js", (c) =>
    c.body(script, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );

  app.get("/login", (c) => render(c, signInPage(undefined, "", safeNext(c.req.query("next")))));
  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const email = formValue(form, "email") ?? "";
    const password = formValue(form, "password") ?? "";
    const next = safeNext(formValue(form, "next"));
    if (email.length > maxEmailLength) {
      return render(c, signInPage(invalidCredentials, "", next), 401);
    }
    // Both an account and a network address get a few attempts: the first stops guessing one
    // password, the second stops trying a few passwords on every account.
    const address = clientAddress(c, trustProxy);
    const byAddress = addressLimiter.begin(address);
    if (!byAddress.allowed) {
      return refuse(c, byAddress, email, next);
    }
    const byEmail = emailLimiter.begin(email);
    if (!byEmail.allowed) {
      return refuse(c, byEmail, email, next);
    }
    const check = await passwordChecks.run(() => authenticateStaff(db, email, password));
    if (!check.ran) {
      // Nothing was checked: the attempt does not count.
      addressLimiter.giveBack(address);
      emailLimiter.giveBack(email);
      c.header("Retry-After", String(busyRetryAfterSeconds));
      return render(c, signInPage(busy, email, next), 503);
    }
    const staff = check.value;
    if (staff === undefined) {
      audit(`Sign-in refused for ${email} from ${address}: wrong email or password`);
      return render(c, signInPage(invalidCredentials, email, next), 401);
    }
    audit(`Signed in: ${email} from ${address}`);
    emailLimiter.clear(email);
    addressLimiter.giveBack(address);
    // A session the browser still held ends: signing in always starts a new one.
    const previous = getCookie(c, sessionCookie, cookiePrefix);
    if (previous !== undefined) {
      await closeSession(db, previous);
    }
    const { token, expiresAt } = await openSession(db, staff.contactId);
    // Browsers keep Secure cookies over https, and on localhost except Safari.
    setCookie(c, sessionCookie, token, {
      prefix: cookiePrefix,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      expires: expiresAt,
    });
    return c.redirect(next, 303);
  });

  // Every other page needs an open session.
  app.use(async (c, next) => {
    const token = getCookie(c, sessionCookie, cookiePrefix);
    const staff = token === undefined ? undefined : await findSession(db, token);
    if (token === undefined || staff === undefined) {
      // After signing in again, the person comes back to the page they asked for. A form sent
      // after the session ended cannot be replayed: they come back to the page it was sent from.
      const back =
        c.req.method === "GET" ? new URL(c.req.url).pathname + new URL(c.req.url).search : "/";
      const query = back === "/" ? "" : `?next=${encodeURIComponent(back)}`;
      return c.redirect(`/login${query}`, 303);
    }
    c.set("staff", staff);
    c.set("sessionToken", token);
    return next();
  });

  app.post("/logout", async (c) => {
    audit(`Signed out: ${c.get("staff").email}`);
    await closeSession(db, c.get("sessionToken"));
    deleteCookie(c, sessionCookie, { prefix: cookiePrefix, path: "/", secure: true });
    return c.redirect("/login", 303);
  });

  app.get("/", async (c) => {
    const filters = listRequestsInput.safeParse(c.req.query());
    if (!filters.success) {
      return c.text("Invalid filters", 400);
    }
    const [result, projects] = await Promise.all([
      listRequests(db, filters.data),
      listProjects(db),
    ]);
    return render(c, requestListPage(view(c), filters.data, result, projects));
  });

  app.get("/review", async (c) => {
    const pageNumber = z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .catch(1)
      .parse(c.req.query("page"));
    return render(c, reviewQueuePage(view(c), await listReviewQueue(db, pageNumber)));
  });

  const showRequest = async (
    c: Context<Env>,
    feedback: { notice?: Notice; error?: string },
    status: 200 | 400 | 409 = 200,
  ) => {
    const reference = c.req.param("reference") ?? "";
    const [record, projects] = await Promise.all([
      getRequestRecord(db, reference),
      listProjects(db),
    ]);
    if (record === undefined) {
      return c.text("Request not found", 404);
    }
    return render(c, requestPage(view(c), record, projects, feedback), status);
  };

  app.get("/requests/:reference", (c) => {
    const notice = c.req.query("done");
    return showRequest(c, {
      notice: notice !== undefined && isNotice(notice) ? notice : undefined,
    });
  });

  // A file attached through the widget. It is always downloaded, never shown in a page of the
  // interface, so a file written by a sender cannot run in it.
  app.get("/attachments/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const file = id.success ? await getStoredAttachment(db, id.data) : undefined;
    const content =
      file === undefined
        ? undefined
        : await readStoredFile(options.attachmentsDir, file.storageRef);
    if (file === undefined || content === undefined) {
      return c.text("File not found", 404);
    }
    return c.body(content, 200, {
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition(file.filename),
      "Cache-Control": "no-store",
    });
  });

  // After an action, the browser is sent back to the request, so reloading does not repeat it.
  const done = (c: Context<Env>, reference: string, notice: Notice) =>
    c.redirect(`/requests/${encodeURIComponent(reference)}?done=${notice}`, 303);

  app.post("/requests/:reference/review", async (c) => {
    const form = await c.req.parseBody();
    const input = reviewRequestInput.safeParse({
      reference: c.req.param("reference"),
      changes: {
        type: formValue(form, "type"),
        priority: formValue(form, "priority"),
        projectKey: formValue(form, "projectKey"),
        status: formValue(form, "status"),
      },
      version: formValue(form, "version"),
    });
    if (!input.success) {
      return showRequest(c, { error: "Valeurs invalides." }, 400);
    }
    const result = await reviewRequest(db, { contactId: c.get("staff").contactId }, input.data);
    if (!result.ok) {
      if (result.error === "NOT_FOUND") {
        return c.text("Request not found", 404);
      }
      return result.error === "CHANGED"
        ? showRequest(c, { error: changedMeanwhile }, 409)
        : showRequest(c, { error: "Projet inconnu." }, 400);
    }
    return done(c, result.value.reference, "reviewed");
  });

  app.post("/requests/:reference/duplicate", async (c) => {
    const form = await c.req.parseBody();
    const input = markDuplicateInput.safeParse({
      reference: c.req.param("reference"),
      duplicateOf: formValue(form, "duplicateOf")?.trim().toUpperCase(),
    });
    if (!input.success) {
      return showRequest(c, { error: "Référence invalide : écrivez par exemple REQ-0042." }, 400);
    }
    const result = await markDuplicate(db, { contactId: c.get("staff").contactId }, input.data);
    if (!result.ok) {
      return showRequest(c, { error: duplicateErrors[result.error] }, 400);
    }
    return done(c, result.value.reference, "duplicate");
  });

  app.post("/requests/:reference/status", async (c) => {
    const form = await c.req.parseBody();
    const input = changeStatusInput.safeParse({
      reference: c.req.param("reference"),
      status: formValue(form, "status"),
      version: formValue(form, "version"),
    });
    if (!input.success) {
      return showRequest(c, { error: "Statut invalide." }, 400);
    }
    const result = await changeRequestStatus(
      db,
      { contactId: c.get("staff").contactId },
      input.data,
    );
    if (!result.ok) {
      return result.error === "CHANGED"
        ? showRequest(c, { error: changedMeanwhile }, 409)
        : c.text("Request not found", 404);
    }
    return done(c, input.data.reference.toUpperCase(), "status");
  });

  registerAdministration(app, { db, view, render });

  app.notFound((c) => c.text("Not found", 404));
  app.onError((error, c) => {
    // Refusals of the middlewares, such as a form from another site, keep their status.
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    options.onError?.(error);
    return c.text("Internal error", 500);
  });

  return app;
}
