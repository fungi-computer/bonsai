/**
 * The Bonsai App facet: a Durable Object whose generated RPC methods are
 * Bonsai's App methods, called through host admission. Native onGitPush receives
 * accepted push facts from the host.
 */
import {
  gitPushQuestionSchema,
  type GitPushQuestion,
  type GitPushVerdict,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import { DurableObject } from "cloudflare:workers";
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
import {
  startBuildWorkflow,
  type BuildWorkflowBindings,
} from "./build-workflow.js";

/** The bindings the host grants Bonsai (see the Oyster binding proposal). */
export type BonsaiEnv = BuildWorkflowBindings &
  Readonly<{
    GIT: GitBinding;
    EVENTS: EventSink;
    BACKGROUND?: BackgroundBinding;
    /** Fork, build and install Apps; present only on a host that supplies it. */
    APPS?: BonsaiAppsBinding;
  }>;

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
    await startBuildWorkflow(this.env, fact);
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
}

export const BonsaiApp = appBackend.implement(BonsaiFacet);
