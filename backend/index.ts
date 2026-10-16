/**
 * The Bonsai App facet: a Durable Object whose generated RPC methods are
 * Bonsai's App methods. `fetch` serves the App's own UI (a JSON PUT naming a
 * method, as agar's appBackend.request sends it). Native onGitPush receives
 * accepted push facts from the host.
 */
import {
  AppMethodRefusal,
  appBackendActorHeader,
  appBackendComputerHeader,
  appMethodRefusalStatus,
} from "@fungi.computer/agar/backend";
import {
  gitPushQuestionSchema,
  type GitPushQuestion,
  type GitPushVerdict,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import { DurableObject } from "cloudflare:workers";
import * as z from "zod";
import { gitStore, type GitBinding } from "./git.js";
import { appBackend, type BonsaiAppsBinding } from "./methods.js";
import {
  observePush,
  type EventSink,
  type Bonsai as BonsaiRuntime,
} from "./service.js";
import { ensureBonsaiTables, BonsaiState } from "./state.js";
import { mayPush } from "./policy.js";
import type {
  BackgroundSyncRefusal,
  BackgroundBinding,
} from "@fungi.computer/puffball/background-replay";
import { refuseBackground } from "./background.js";

/** The bindings the host grants Bonsai (see the Oyster binding proposal). */
export type BonsaiEnv = Readonly<{
  GIT: GitBinding;
  EVENTS: EventSink;
  BACKGROUND?: BackgroundBinding;
  /** Fork, build and install Apps; present only on a host that supplies it. */
  APPS?: BonsaiAppsBinding;
}>;

const uiRequest = z.strictObject({
  method: z.string().min(1).max(80),
  input: z.json(),
});

function declared(method: string): boolean {
  return Object.hasOwn(appBackend.methods, method);
}

function failure(error: Error): Response {
  if (error instanceof AppMethodRefusal)
    return Response.json(
      { error: error.code, message: error.message },
      { status: appMethodRefusalStatus[error.code] },
    );
  if (error instanceof z.ZodError)
    return Response.json({ error: "Invalid request" }, { status: 400 });
  console.error("bonsai backend error", error);
  return Response.json(
    { error: "Bonsai could not finish that request" },
    { status: 500 },
  );
}

class BonsaiFacet extends DurableObject<BonsaiEnv> {
  declare public readonly env: BonsaiEnv;
  readonly bonsai: BonsaiRuntime;

  constructor(ctx: DurableObjectState, env: BonsaiEnv) {
    super(ctx, env);
    ensureBonsaiTables(ctx.storage.sql);
    this.bonsai = {
      store: gitStore(env.GIT),
      state: new BonsaiState(ctx.storage.sql, (body) =>
        ctx.storage.transactionSync(body),
      ),
      events: env.EVENTS,
    };
  }

  syncRefused(refusal: BackgroundSyncRefusal): Promise<void> {
    return refuseBackground(this.bonsai, refusal);
  }

  async onGitPush(fact: AppGitPushFact): Promise<void> {
    await observePush(this.bonsai, fact);
  }

  authorizeGitPush(raw: GitPushQuestion): Promise<GitPushVerdict> {
    return Promise.resolve().then(() => {
      const question = gitPushQuestionSchema.parse(raw);
      const actor = question.writer.actor;
      const allowed = mayPush(
        actor.kind === "member"
          ? { name: actor.memberId, kind: "human" }
          : {
              name: actor.kind === "team-key" ? actor.keyId : actor.agentId,
              kind: "agent",
            },
        this.bonsai.state.repo(question.repository),
      );
      return allowed
        ? { allowed: true }
        : {
            allowed: false,
            refused: question.updates.map((update) => ({
              ref: update.ref,
              message: "Writer cannot push to this repository",
            })),
          };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "PUT")
        return new Response(null, { status: 405, headers: { Allow: "PUT" } });
      const body = uiRequest.parse(await request.json());
      if (!declared(body.method))
        return Response.json({ error: "No such method" }, { status: 404 });
      const memberId = request.headers.get(appBackendActorHeader);
      if (memberId === null)
        return Response.json(
          { error: "App actor unavailable" },
          { status: 403 },
        );
      const result = await appBackend.call(body.method, body.input, this, {
        computerId: request.headers.get(appBackendComputerHeader),
        actor: { kind: "member", memberId },
      });
      return Response.json(result);
    } catch (error) {
      return failure(
        error instanceof Error ? error : new Error("Non-error thrown"),
      );
    }
  }
}

export const BonsaiApp = appBackend.implement(BonsaiFacet);
