---
type: technical-rfc
status: ready-for-implementation
version: 0.5
updated: 2026-08-30
implementation_repository: "MyAgents"
repository_mirror: ../../../MyAgents-dsh/specs/prd/tech_rfc_0.3_myagents_host_integration.md
product_prd: ../../../MyAgents-dsh/specs/prd/prd_0.3_myagents_integration.md
runtime_rfc: ../../../MyAgents-dsh/specs/prd/tech_rfc_0.3_myagents_dsh_integration.md
audit_baseline:
  version: 0.4.12
  original_commit: c39d7387a6122f9ebed5f4ec94583aebd1da93f6
  revalidated_commit: 61a81af384a2333dd8f4fc5f14436ab6e360c820
runtime_handoff:
  status: current-protocol-2.0.0-ready-for-ingestion
  reviewed_repository_head: 2464cf684e755c3b749aba273e0639ec17a108b3
  source_commit: e9fbd6e7f1669fd776bda44d707f5fb7227bc5df
  protocol: 2.0.0
  manifest_sha256: 437dd66cbdfa224d225dffa0aafe485c08a6da8663c1c2a61279aee6d6a74e66
  runtime_manifest_sha256: d9d8c5706365dc5b3443f278779225e22115202af752dfe986112957825a8036
  compatibility_sha256: 21a482048dd8ddd84288391a7a632d0c5f4191df4a6787585acca14c730a5a5f
  protocol_schema_sha256: 5610b423694e364c01ade64391893275c8a4a71734b865b8992d0a02247e3a60
  generated_client_sha256: a571c919d1daa4ee410e53823eb64dc61dc0580b827ba87036c954955a5e6626
---

# Batch 3 Technical RFC — MyAgents integration of MyAgents-dsh

## 1. Decision summary

MyAgents will add DSH as a first-party **Integrated Runtime**, not as an External CLI and not as a Managed Provider Runtime.

The implementation reuses the existing product architecture:

```text
Desktop / IM / Task / Cron / Goal / Heartbeat / Inbox
                         |
                         v
              SessionEngine facade
                         |
                         v
              ExecutionResolver
        _________|___________
       |         |           |
 Claude SDK   DSH adapter   existing external/managed adapters
                 |
          RuntimeProcessHost
        generated protocol client
                 |
          DSH runtime-server
```

There is no new conversation product, no DSH-specific Renderer, no global Runtime daemon, and no reuse of a native Session across different runtimes.

MyAgents continues to own:

- Product Session identity, transcript and UI projection;
- Agent defaults, distribution policy and runtime resolution;
- Sidecar ownership and process lifecycle;
- Provider configuration and credentials;
- permission/AskUser/plan interaction UI;
- Host tools, Hooks, attachment storage and product automation;
- Task, Goal, Cron, Heartbeat, Inbox, IM and notification semantics.

MyAgents-dsh continues to own:

- the DSH AgentLoop and durable native conversation;
- its single `ctx.tools` execution pipeline;
- native Runtime Session, Turn, work and mutation truth;
- the generated bidirectional protocol contract;
- provider-profile execution and exact compatibility manifest;
- the verified Runtime artifact.

## 2. Audited current state

This RFC was originally audited against MyAgents `0.4.12` at commit `c39d7387a6122f9ebed5f4ec94583aebd1da93f6` and was revalidated against committed HEAD `61a81af384a2333dd8f4fc5f14436ab6e360c820` after the formal DSH `2.0.0` handoff was produced. Since the previous audit at `d6ba358f…`, committed changes touching `Launcher.tsx` and `specs/ARCHITECTURE.md` are limited to the Record/AI-discussion flow; they do not alter `src/server/session-engine/`, Runtime identity types, Provider execution policy, or the Rust Runtime identity owner. The architectural findings therefore remain valid.

The live MyAgents worktree also contains unrelated uncommitted Record/AI-discussion and UI work. It was inspected for boundary overlap and does not implement DSH integration. It is not design authority for Batch 3 and must be preserved during implementation; an implementation branch or worktree must not absorb, overwrite, or reinterpret it.

### 2.1 Reusable product owners

| Existing owner | Current fact | Batch 3 decision |
| --- | --- | --- |
| `src/server/session-engine/` | One facade already covers Desktop, IM, background, Inbox, scheduled/injected turns, queue, stop, config, interactions and history operations | Keep as the only product entry seam |
| Session Sidecar | Architecture guarantees at most one Sidecar per Product Session; multiple owners share it | Sidecar hosts one DSH Runtime process for a DSH-bound Session |
| `SessionStore` | Owns transcript and Session metadata | Remains Product transcript authority |
| `src/server/runtimes/types.ts` | `UnifiedEvent` already represents text, thinking, tools, permission, usage, plan and terminal events | Extend only where DSH semantics cannot be represented losslessly |
| Chat Renderer | Already provides the complete AI conversation, tool blocks, inline interactions, queue/stop and mutations | Reuse; no DSH debug cards |
| `providerSwitchSessionBirth.ts` and Chat transitions | Existing incompatible Provider/Runtime flow confirms, preserves old Session and opens a new Tab | Reuse for DSH, `anthropic-sub` and managed-provider boundaries |
| Rust Sidecar manager | Owns generation, process tree, owner tokens and replacement | Remains the process owner; does not parse DSH RPC |
| IM runtime rotation | Existing Agent config change freezes old binding, creates a fresh Session and notifies the user | Generalize identity input, preserve behavior |

### 2.2 Current binary assumptions that must change

The current model is too narrow:

- `RuntimeType` is `builtin | claude-code | codex | gemini`;
- `RuntimeSource` is `system-cli | managed-provider`;
- `SessionEngineKind` is `builtin | external`;
- `getSessionEngine()` selects only Builtin or External;
- the Labs gate collapses the Agent's effective Runtime to historical `builtin`;
- provider execution has a Codex-specific runtime-backed variant;
- Rust runtime identity normalizes nearly every non-builtin source toward `system-cli`.

Simply adding `dsh` to `RuntimeType` would classify it through External Runtime assumptions, permit illegal runtime/source combinations, and make future Pi integration repeat the same migration. Batch 3 therefore introduces an explicit product identity model instead of growing two independent string unions.

### 2.3 Existing change behavior is already correct

The audited product behavior matches the accepted PRD and must be retained:

- Agent Settings and Launcher update the Agent template only; future Sessions use the new selection.
- In a live Chat, an incompatible Runtime or Provider change uses the existing confirmation and new-Tab birth flow.
- The old Session retains its frozen identity and transcript.
- An explicit External Runtime wins over a dormant `codex-sub` Agent field.
- IM/Agent Channel effective-identity drift freezes the old Session and rotates to a new binding; admission and Heartbeat checks are recovery fences.

Batch 3 generalizes the compatibility inputs to these flows. It does not redesign them.

### 2.4 Exact-handoff revalidation and required amendments

The formal repository-external handoff validates successfully without a sibling source checkout and freezes:

- handoff manifest `437dd66cbdfa224d225dffa0aafe485c08a6da8663c1c2a61279aee6d6a74e66`;
- Runtime manifest `d9d8c5706365dc5b3443f278779225e22115202af752dfe986112957825a8036`, built from clean MyAgents-dsh source commit `e9fbd6e7f1669fd776bda44d707f5fb7227bc5df`;
- compatibility manifest `21a482048dd8ddd84288391a7a632d0c5f4191df4a6787585acca14c730a5a5f`;
- formal protocol `2.0.0`, schema `5610b423694e364c01ade64391893275c8a4a71734b865b8992d0a02247e3a60`, and generated Host client `a571c919d1daa4ee410e53823eb64dc61dc0580b827ba87036c954955a5e6626`;
- DSH artifact `9c5ed754341bae0f82bbb118188c5c45a97f640133cc3e91d22b9a2bee1b3f7c` at upstream commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`;
- macOS arm64, Linux x64 and Windows x64 all labeled `implementation-complete_pending-native-validation` for these bytes.

Formal `2.0.0` is wire-identical to draft.3 and contains 40 Host requests, seven reverse requests and four notifications, including `plan/apply`, `permission/rules/list`, `permission/rules/add`, and `permission/rules/revoke`. H0 must ingest and verify this complete immutable handoff; all draft handoffs remain historical evidence and are a hard compatibility failure for the first implementation lock. No pending-native-validation platform claim may be surfaced as verified product support.

The current MyAgents-dsh repository HEAD reviewed for this RFC is `2464cf684e755c3b749aba273e0639ec17a108b3`. It adds only the final handoff documentation after source commit `e9fbd6e…`; it does not create newer executable Runtime bytes. The integration identity therefore remains the content-addressed handoff above rather than the repository HEAD. The handoff's public verifier succeeds against the trusted outer digest and reports the same Runtime and compatibility manifests.

The Node integration blocker found by version 0.1 is now resolved at the artifact source: the accepted Runtime requires exact Node `24.14.0`, which matches MyAgents' bundled Runtime Node. MyAgents must still cross-check every Node version authority, including `scripts/download_nodejs.sh`, `setup_windows.ps1`, and the fallback in `build_windows.ps1`, plus resource/version assertions and executable architecture examples. A user-installed Node or a semver assumption must fail readiness before process spawn. A later Node upgrade requires a newly accepted Runtime artifact and native evidence rather than a Host-side bypass.

npm has a different boundary. The installed DSH Runtime never invokes npm; its recorded npm `11.8.0` is build provenance, not a Host compatibility requirement. MyAgents currently declares development package manager `npm@11.13.0`, ships npm `11.15.0` beside its bundled Node, and resolves `npm/latest` in resource setup. H0 must remove the floating resource download and record an explicit product-owned bundled-npm version. The development npm and bundled npm may remain distinct authorities when their roles are explicit, exact, and independently verified; neither is copied from or constrained by the DSH handoff.

The revalidation also sharpens two existing rules:

1. MyAgents ingests the immutable handoff through a deterministic build-time verifier and committed lock; it never imports from a sibling MyAgents-dsh checkout or edits files inside the Runtime directory.
2. `apiFamilies` proves transport-family support, not arbitrary Provider/model support. MyAgents owns an exact allowlisted Provider/model cell table. The native `deepseek-official` route is read from the included candidate profile; the three pi-ai families are read from the compatibility manifest. No other cell becomes visible without joint evidence.

## 3. Target product identity model

### 3.1 Agent preference

Agent configuration stores user intent, not the final engine process:

```ts
type AgentRuntimePreference =
  | { family: 'integrated'; id: 'claude-agent-sdk' | 'dsh' }
  | { family: 'external'; id: 'claude-code' | 'codex' | 'gemini' };
```

The type may reserve an internal future identifier for Pi in schema evolution, but Batch 3 must not show or accept Pi as a selectable value.

### 3.2 Provider execution constraint

Provider execution is generalized from the current Codex-only special case:

```ts
type ProviderExecutionConstraint =
  | { kind: 'portable'; apiFamily: ApiFamily }
  | {
      kind: 'requires-integrated-runtime';
      runtimeId: 'claude-agent-sdk';
      providerId: 'anthropic-sub';
    }
  | {
      kind: 'requires-managed-runtime';
      runtimeId: 'managed-codex';
      providerId: 'codex-sub';
    };
```

An ordinary Anthropic API-key Provider is portable when the selected Integrated Runtime supports `anthropic-messages`. It is not the same thing as `anthropic-sub`.

### 3.3 Effective Session binding

Every new Product Session freezes a legal discriminated binding:

```ts
type EffectiveRuntimeBinding =
  | {
      family: 'integrated';
      id: 'claude-agent-sdk';
      implementationVersion: string;
    }
  | {
      family: 'integrated';
      id: 'dsh';
      implementationVersion: string;
      protocolVersion: string;
      protocolSchemaSha256: string;
      runtimeArtifactSha256: string;
      compatibilityManifestSha256: string;
      sessionFormat: string;
      platformTarget: string;
    }
  | {
      family: 'managed-provider';
      id: 'managed-codex';
      providerId: 'codex-sub';
      implementationVersion: string;
    }
  | {
      family: 'external';
      id: 'claude-code' | 'codex' | 'gemini';
      implementationVersion?: string;
    };
```

Provider route/model, effective configuration revisions and native `runtimeSessionId` remain Session metadata associated with this binding. No free-form combination of runtime and source is accepted at a new write boundary.

### 3.4 Legacy projection

During migration MyAgents reads existing flat `runtime` / `runtimeSource` fields into the new discriminated value and may continue writing a legacy projection for old consumers. The new `runtimeBinding` is authoritative when present.

Legacy mapping:

| Legacy values | New binding |
| --- | --- |
| `builtin` with no managed Provider | integrated / Claude Agent SDK |
| `builtin` + `codex-sub` | managed-provider / managed Codex |
| `codex + managed-provider` | managed-provider / managed Codex |
| `claude-code`, `codex` or `gemini` + missing/system source | matching external binding |

Unknown or illegal combinations are quarantined as read-only compatibility errors. They do not silently become Claude SDK.

## 4. Distribution policy and selection

### 4.1 Policy

Introduce a validated distribution policy:

```ts
interface AgentRuntimeDistributionPolicy {
  schemaVersion: 1;
  allowedIntegratedRuntimes: Array<'claude-agent-sdk' | 'dsh'>;
  allowedExternalRuntimes: Array<'claude-code' | 'codex' | 'gemini'>;
  defaultIntegratedRuntime: 'claude-agent-sdk' | 'dsh';
  selectorAvailability: 'always' | 'labs' | 'hidden';
}
```

The general development/release baseline is:

- allowed Integrated Runtimes: Claude Agent SDK and DSH;
- default Integrated Runtime: Claude Agent SDK;
- DSH exposed only through the controlled rollout/Labs policy;
- Pi absent.

A DSH-only edition sets DSH as the sole allowed/default Integrated Runtime and hides the selector. Invalid policy fails during build or application startup.

### 4.2 Labs semantics

`multiAgentRuntime` becomes a selection-availability gate, not a runtime kill switch:

- when unavailable, normal UI does not let the user change Runtime;
- new ordinary-provider Sessions use the Default Integrated Runtime;
- saved Agent preferences remain stored;
- existing frozen Sessions remain executable if their exact Runtime is allowed and available;
- a distribution that excludes the frozen Runtime leaves transcript readable and blocks execution explicitly.

### 4.3 Central resolution algorithm

For an existing Session, return its frozen binding after policy/artifact validation.

For a new Session:

1. load and validate distribution policy;
2. resolve the Agent preference, using the Default Integrated Runtime when selection is unavailable;
3. resolve Provider/model execution intent;
4. if an explicit allowed External Runtime is selected, choose it and treat Integrated/managed Provider template fields as dormant;
5. otherwise apply a Runtime-constrained Provider:
   - `anthropic-sub` -> Claude Agent SDK;
   - `codex-sub` -> managed Codex;
6. otherwise choose the resolved Integrated Runtime;
7. validate Runtime readiness and exact Provider/model compatibility;
8. atomically persist the binding before first turn admission.

The resolver returns either one complete binding plus configuration plan or one structured failure. No caller retries with a different Runtime.

## 5. SessionEngine architecture

### 5.1 One product facade

Keep `SessionEngine` as the product-facing contract. Replace the binary selector with a registry keyed by `EffectiveRuntimeBinding`:

```text
SessionEngine
  |- ClaudeSdkSessionEngineAdapter
  |- DshSessionEngineAdapter
  |- ManagedCodexSessionEngineAdapter / existing external core
  '- ExternalCliSessionEngineAdapter / existing runtimes
```

Physical code reuse does not define product taxonomy. Managed Codex may continue sharing external-session machinery while remaining a Managed Provider Runtime in the resolver and UI.

### 5.2 Capability extensions

The common facade keeps currently universal product operations. Runtime-specific rich operations are exposed through negotiated, narrow capabilities instead of fake success:

```ts
interface NativeRuntimeCapabilities {
  configuration?: RuntimeConfigurationCapability;
  extensions?: RuntimeExtensionCapability;
  durableTurnTruth?: RuntimeTurnTruthCapability;
  mutations?: RuntimeMutationCapability;
  nativeHistory?: RuntimeHistoryCapability;
}
```

If a control is unsupported, the resolver/UI disables it before use or SessionEngine returns a structured `unsupported_capability`. It must not return `success + skipped` for a visible action.

### 5.3 Product entry points

The following must continue to call only SessionEngine and the central resolver:

- Desktop Chat and Launcher;
- Agent Settings and workspace defaults;
- IM/Agent Channel and Heartbeat;
- Task/Cron and Goal;
- Inbox and registered Agent;
- injected/system turns and background completion;
- title/utility operations where their current owner applies.

Implementation must re-run `rg` over direct Builtin/External calls before promotion; newly discovered bypasses are blockers.

## 6. DSH RuntimeProcessHost

### 6.1 Process topology

For a DSH-bound Product Session:

- Rust creates/owns the existing Session Sidecar and its process-tree control handle;
- Rust injects verified DSH artifact paths and a session-scoped Runtime home;
- the Sidecar and DSH child use MyAgents' one bundled Node, which must exactly match the Runtime lock (`24.14.0` for this candidate);
- the Node Sidecar creates one `RuntimeProcessHost`;
- `RuntimeProcessHost` starts one DSH runtime-server with bundled Node;
- communication is bidirectional JSON-RPC over stdin/stdout;
- stderr enters the existing redacted unified logger;
- the Renderer communicates only through existing Rust proxy and Sidecar APIs.

Rust does not parse DSH frames. DSH does not open TCP/HTTP. A Product Session does not share one DSH root process with another Product Session.

### 6.2 Handshake and admission

Process readiness requires:

1. handoff, artifact inventory, lock, platform evidence and exact Node validation;
2. process spawn with explicit generation;
3. protocol `initialize`;
4. exact protocol/schema/profile/session-format verification;
5. Runtime capability verification;
6. registration of all reverse Host handlers;
7. `initialized` notification;
8. `session/create` or exact `session/resume`;
9. atomic persistence of the native binding.

No user turn is admitted before all applicable steps succeed.

### 6.3 Generation fencing and shutdown

Every pending request, reverse call, event and terminal is scoped by Product Session, Sidecar generation, Runtime generation and operation identity.

On shutdown:

1. stop new admission;
2. cancel or drain reverse requests according to protocol;
3. reconcile admitted turns and mutations;
4. call `runtime/shutdown`;
5. wait for quiescence;
6. use existing process-tree termination only after grace expiry.

Crash recovery is bounded. Process exit is not a turn terminal; `turn/get` and durable Session truth decide the outcome.

## 7. Generated protocol and artifact consumption

MyAgents consumes only a pinned DSH handoff containing:

- Runtime artifact and complete file inventory;
- artifact, source and lock digests;
- protocol version and schema digest;
- generated Host client and wire types;
- Runtime/profile/session-format identity;
- capability and canonical tool fixtures;
- Provider/API-family compatibility manifest;
- supported-platform claims and evidence;
- license and notice inventory.

The following block is the exact formal `2.0.0` seed for the first implementation lock:

```text
sourceCommit                 e9fbd6e7f1669fd776bda44d707f5fb7227bc5df
protocolVersion              2.0.0
handoffManifestSha256        437dd66cbdfa224d225dffa0aafe485c08a6da8663c1c2a61279aee6d6a74e66
runtimeManifestSha256        d9d8c5706365dc5b3443f278779225e22115202af752dfe986112957825a8036
compatibilitySha256          21a482048dd8ddd84288391a7a632d0c5f4191df4a6787585acca14c730a5a5f
protocolSchemaSha256         5610b423694e364c01ade64391893275c8a4a71734b865b8992d0a02247e3a60
generatedClientSha256        a571c919d1daa4ee410e53823eb64dc61dc0580b827ba87036c954955a5e6626
dshArtifactManifestSha256    9c5ed754341bae0f82bbb118188c5c45a97f640133cc3e91d22b9a2bee1b3f7c
requiredNodeVersion          24.14.0
```

An ingestion script accepts one explicit external `--handoff <absolute-directory>` input, first executes that directory's public `verify.mjs` entrypoint with the expected handoff digest, validates the compatibility/platform facts, copies the complete Runtime directory byte-for-byte into build resources, and copies the generated client/contracts through a generated-diff gate. MyAgents code may wrap the generated client but may not hand-edit it or import verifier/package-private `src/*` paths. Installed application startup verifies the committed lock again before marking DSH ready.

The first implementation lock must be populated from these exact handoff values after running the package's public `verify.mjs` against the trusted outer digest. Its generated client contains 40 Host methods and all four permission/Plan control-plane methods; any draft or independently reconstructed client is a hard compatibility failure.

For local Batch 3 development, that input may be a content-addressed artifact cache produced by the pinned MyAgents-dsh build. Release CI must obtain the same immutable bytes from its approved distribution asset/channel before resource staging; application startup does not fetch a floating Runtime from the network. The exact asset transport may vary by distribution policy without changing Host architecture, but every channel terminates in the same digest verifier before admission.

Create a committed MyAgents lock file, for example `src/shared/integrated-runtimes/dsh-lock.json`. Release builds reject:

- floating versions or sibling source checkout;
- missing/extra artifact files;
- hash, protocol, profile or platform drift;
- an unaccepted native-platform claim;
- development path overrides.

Development override is allowed only through an explicit developer setting and must be visibly marked `unverified-dev-runtime` in diagnostics.

## 8. Provider, credentials and configuration

### 8.1 Execution profile compiler

MyAgents compiles the selected ordinary Provider/model into the DSH `ModelExecutionProfile`:

- stable profile revision;
- Provider route and API family;
- exact model ID;
- approved base URL;
- opaque `credentialRef`;
- context window and max output;
- reasoning/effort;
- typed compatibility options;
- pricing where MyAgents has authoritative data.

The compiler consumes both the exact DSH compatibility manifest and the included native DeepSeek candidate profile. It does not infer compatibility merely from an OpenAI-shaped URL, a pi-ai catalog entry, or a Provider name.

The selected MyAgents-dsh design reuses the official DSH `dsh-llm-pi-ai` adapter for ordinary Anthropic Messages, OpenAI Chat Completions and OpenAI Responses routes, while retaining the native DSH DeepSeek adapter for `deepseek-official`. This does not weaken Host authority: MyAgents still compiles the frozen profile and owns credentials; the Runtime's thin control layer translates that profile into the official adapter's public settings seam and activates the Host credential port for each model request. MyAgents treats only manifest-listed Provider/model cells as portable. Its existing Claude-SDK `authType` and Bridge quirks are inputs to that mapping, not proof that the DSH adapter supports the same wire behavior.

The exact cell table also carries candidate limitations: pi-ai routes do not support Host stop-sequence projection; reasoning content is available but provider reasoning-token counts are not; the bundled pi-ai catalog is advisory; AWS, Vertex, Azure and subscription/OAuth routes are not advertised. The same-release public `dsh-authorization` package is present only because `dsh-llm-pi-ai` requires it as a public peer. MyAgents must not mount its login/OAuth service or expose it as a capability.

### 8.2 Subscription providers

- `anthropic-sub` requires the Claude Agent SDK path.
- `codex-sub` requires managed Codex.
- Settings/Launcher only save the template.
- A live incompatible Session uses the existing confirm/new-Tab flow.
- Explicit External Runtime selection continues to win over dormant subscription fields.

No DSH request is attempted for either unsupported subscription route.

### 8.3 Secret ownership

Provider and MCP secrets remain in MyAgents authorities. DSH receives only opaque references in configuration. Runtime material requests use `host/credential/resolve` and receive request- or connection-scoped values.

Secret material is never:

- persisted in Session metadata or Runtime declarative snapshots;
- written to logs, diagnostics, fixtures or support bundles;
- inherited through broad process environment;
- returned to the Renderer.

`RuntimeProcessHost` therefore constructs an explicit child environment allowlist and removes Provider/MCP/API-key variables even if the current Sidecar inherited them for another Runtime. Credential material crosses only `host/credential/resolve` and is discarded when that request/connection scope settles.

## 9. Host reverse ports

`RuntimeProcessHost` registers these generated handlers before readiness:

| Port | MyAgents implementation |
| --- | --- |
| `host/credential/resolve` | Provider/MCP credential owner with revision and authority checks |
| `host/interaction/request` | Existing permission, AskUser and plan interaction store/UI |
| `host/tool/execute` | Runtime-neutral Host tool dispatcher |
| `host/hook/execute` | Existing Hook policy and lifecycle |
| `host/attachment/put` | Product attachment store publication |
| `host/attachment/acquire` | Scoped read-only attachment lease |
| `host/attachment/release` | Exact lease settlement |

The current managed-Codex Host dispatcher is useful implementation evidence, but it must be extracted into a runtime-neutral domain module before DSH consumes it. DSH calls still pass through DSH's one model-visible tool pipeline; the Host port is an executor boundary, not a second tool runtime.

For non-DeepSeek model routes, MyAgents also supplies the approved Host-backed executor for the canonical `WebSearch`/`WebFetch` definitions when the DSH compatibility manifest requires it. DSH performs catalog registration, schema validation, visibility, permission, Hook, origin and terminal handling; MyAgents executes the governed web capability through `host/tool/execute`. A Session is not advertised with the complete 20-tool profile unless this backend is ready and has passed the joint contract campaign.

Reverse calls are bounded, cancellable and generation-fenced. Host disconnect or timeout returns one protocol-defined failure and cannot leave a turn appearing idle.

### 9.1 Permission and Plan ownership

MyAgents keeps its product vocabulary and translates it at the DSH adapter boundary:

| MyAgents product choice | DSH base permission mode | DSH Plan state |
| --- | --- | --- |
| `auto` | `acceptEdits` | normal |
| `plan` | `acceptEdits` | enter/retain with `plan/apply` |
| `fullAgency` | `bypassPermissions` | normal |

Plan is not encoded as a DSH permission string. At Session birth, `plan` compiles the deterministic `acceptEdits` base and enters Plan before the first turn. When the user changes to or from `plan`, the SessionEngine adapter applies the corresponding base configuration plus `plan/apply` with current revision facts, waits for Runtime acknowledgement, and only then updates effective UI state. Stale revisions and mismatched Plan artifacts fail closed; desired/effective drift remains visible and retryable.

Inline permission requests continue through `host/interaction/request`. One-shot allow/deny settles only that request. `always_allow` creates an exact durable Runtime rule. The adapter also exposes the generated `permission/rules/list`, `permission/rules/add`, and `permission/rules/revoke` operations so settings, diagnostics, or later policy UI can inspect and revoke authoritative Runtime state without scraping transcript events. Batch 3 need not add `default` or `dontAsk` to the ordinary desktop selector, but it must preserve them as valid protocol values and must not coerce them silently.

Visibility and permission remain independent: hiding a tool is configuration; allowing it is execution policy. `fullAgency` removes interactive permission prompts but is not an OS sandbox and does not contain arbitrary Bash subprocess effects. Its UI copy must say this explicitly. Hard policy, origin/workspace/revision constraints and Hooks remain enforceable even in `fullAgency`.

## 10. Events, transcript and conversation UI

### 10.1 Serialized event inbox

DSH `runtime/event` notifications enter one serialized inbox. The durable identity is:

```text
(productSessionId, runtimeSessionId, stable item/operation identity)
```

`(runtimeGeneration, sequence)` orders one generation but is not sufficient for cross-generation product-effect deduplication.

### 10.2 Projection

Project canonical DSH events into existing MyAgents domains:

| DSH event | MyAgents projection |
| --- | --- |
| `assistant_delta` | assistant streaming text |
| `thinking_delta` | reasoning block |
| `tool start/update/end` | one existing tool block lifecycle |
| `interaction` + reverse request | inline permission/question/plan block |
| `queued_message` | existing queue item |
| `usage/context` | usage and context UI |
| `plan/task_graph/work/component` | existing Agent status/background projections |
| `checkpoint/compaction/retry/warning` | existing status/error surfaces |
| `turn_terminal` | the only authoritative turn terminal |

If an event cannot be represented without losing user-visible semantics, extend `UnifiedEvent` and all exhaustive consumers. Do not serialize raw DSH protocol cards into the chat.

### 10.3 Dual authorities without dual transcript

DSH native history is the durable model-conversation authority for DSH resume. MyAgents `SessionStore` is the Product transcript authority for product UI, search and cross-feature linkage.

This is a projection relationship, not two competing model transcripts:

- MyAgents never reconstructs DSH native state from rendered transcript;
- DSH never becomes the Product transcript store;
- restore uses `session/resume` and `session/read` to reconcile native truth with idempotent Product projection;
- success is not published upward until Runtime terminal truth and required Product persistence have both settled.

### 10.4 Runtime-owned automatic and explicit compaction

The accepted Runtime composition installs the official DSH `TokenMeter`, official `ToolResultPruner`, and official `BasicCompactionEngine` in that order, with `auto: true`; the locked DSH patch series strengthens capacity safety without moving ownership into MyAgents. DSH remains the only owner of pressure measurement, range selection, summary generation, durable surface replacement, overflow retry and compaction recovery.

Automatic pressure is model-aware at each admitted request. The Runtime resolves the exact routed model profile, derives the current pressure threshold and verbatim-tail target from that model's context window, and handles provider-confirmed overflow through the same durable compaction authority. MyAgents supplies the admitted Provider/model capacity facts once through the exact execution profile; it must not maintain a second compaction threshold table, generate summaries, rewrite native history, or infer compaction success from reduced Product transcript length.

MyAgents projects canonical compaction events and context metrics into its existing status/context surfaces. A user-initiated compact action calls `session/compact` only through the DSH SessionEngine capability at an idle/quiescent boundary and correlates its `clientOperationId` with durable Runtime settlement. Automatic and explicit compaction share the same DSH engine; the Host does not create a second memory subsystem or transcript. Repeated-compaction, restart continuity, provider-overflow and explicit-operation recovery are joint acceptance requirements for the exact staged artifact.

## 11. Queue, steering and stop

- Use the existing SessionEngine queue owner for Product admission.
- Active DSH turns use protocol `turn/steer` only when current product policy selects steering.
- Follow-ups use `turn/followUp` with stable message IDs.
- Queue cancellation uses `turn/message/cancel`.
- Stop uses the exact admitted `clientOperationId` with `turn/interrupt`; no global “current operation” guess is allowed.
- The returned queue settlement and later terminal event are reconciled before the UI becomes idle.

The current historical fallback that tries an External stop and then Builtin interrupt must not apply to a DSH-bound Session.

## 12. Configuration and extension updates

MyAgents maintains desired and effective revisions for:

- Provider/model and reasoning;
- permission mode and interaction scenario;
- system prompt;
- execution environment;
- MCP, Skills, agents, commands, Hooks and Host tools.

Apply according to negotiated DSH modes:

- next-turn changes wait for or apply at a stable turn boundary;
- restart-when-idle changes schedule a bounded Runtime replacement;
- unsupported changes are rejected before updating effective UI;
- failed apply leaves desired/effective drift visible and recoverable.

Declarative extension snapshots contain only validated descriptors and references. Arbitrary Plugin JavaScript is never sent into DSH; trusted runtime plugins remain build-time DSH composition.

## 13. Mutations and native history

Fork, rewind and delete/purge use the DSH prepare/commit/status protocols plus existing Product owners.

General transaction rule:

1. MyAgents records Product intent and stable mutation ID;
2. DSH prepares and returns its durable receipt/postconditions;
3. MyAgents stages Product transcript/metadata/workspace changes;
4. DSH and Product commits are coordinated in the method-specific order;
5. crash recovery queries mutation status and resumes or rolls back;
6. UI reports complete only after both authorities satisfy postconditions.

Rewind's file rollback claim remains limited to governed root-origin Write/Edit. The UI and documentation must not imply shell, child or external modifications are rolled back.

No operation ever resumes DSH native history using Claude SDK, Pi, managed Codex or an External CLI.

## 14. Desktop and settings UX

### 14.1 Runtime selector

Reuse the current selector placement, grouped as:

- Integrated: MyAgents (Claude Agent SDK), MyAgents (DSH);
- External CLI: Claude Code, Codex, Gemini.

Managed Codex is not listed. Pi is not listed until integrated.

Each item uses the readiness result from the resolver/artifact verifier: ready, setup required, update required, unavailable, incompatible or experimental.

### 14.2 Change behavior

- Settings/Launcher: save Agent template; toast that a new Tab uses it.
- Live compatible model change: preserve existing policy.
- Live incompatible Provider/Runtime change: existing confirm dialog, preserve current Session, create a new Session and open its Tab.
- Cancel: no template/session mutation.
- Failed new birth: keep old Tab intact and show actionable error.

### 14.3 Conversation

DSH uses existing MessageList, composer, queue, stop, inline tool/permission/question/plan cards, attachment pipeline, history actions and status panel. Every visible control must call a real SessionEngine capability. Permission/AskUser cards settle through the reverse request exactly once; switching the product to Plan uses `plan/apply`, not a decorative local state; any exact always-allow rule shown by product UI is read from Runtime and is revocable through the generated rule API.

## 15. IM, Agent Channel and automation

### 15.1 IM/Agent Channel

Generalize the current full runtime identity comparison to `EffectiveRuntimeBinding` compatibility:

- compatible live config continues through the same Session;
- incompatible identity change freezes the old Session;
- a new UUID/binding is created;
- the existing user notification is sent;
- old owner is released only through current lifecycle authority;
- message-time and Heartbeat checks remain fallback repair.

### 15.2 Tasks, Cron, Goal and injected work

Birth snapshots freeze the exact effective binding selected by the central resolver. Runtime changes do not rewrite already-running operations.

All queues, cancellation, terminal reporting and owner release continue through SessionEngine. A DSH adapter cannot require the Renderer to be mounted.

## 16. Persistence and migration

Implementation introduces versioned schema migration for:

- distribution policy/default;
- Agent runtime preference;
- Session effective binding;
- Provider execution constraint/identity;
- DSH native runtime metadata and projection cursor;
- pending DSH operations and mutations.

Migration requirements:

- idempotent and restart-safe;
- preserves old fields until all supported readers migrate;
- never changes an existing Session's runtime semantics;
- unknown binding becomes an explicit compatibility state;
- legacy `builtin` remains Claude Agent SDK unless an existing managed-Codex projection proves otherwise;
- backup/export/import retains frozen binding facts.

## 17. Packaging, update and platform policy

The MyAgents build stages the exact DSH Runtime directory; it does not bundle it as one guessed esbuild file. Tauri resources include its full verified inventory and notices. Resource staging is content-addressed by the committed handoff/Runtime digests and rejects symlinks, missing files, extra files and post-copy mutation.

Supported claims:

- macOS arm64, Windows x64 and Linux x64 are all `implementation-complete_pending-native-validation` in the supplied formal `2.0.0` handoff;
- MyAgents may mark a platform path verified only after an updated exact handoff carries passing native Runtime evidence and MyAgents' own packaged smoke passes against that nested manifest;
- the UI must not turn “implementation complete” into “verified”.

Updates are atomic and side-by-side by artifact identity. Existing Sessions may require their compatible artifact to remain available. Garbage collection cannot remove an artifact referenced by a retained executable Session.

## 18. Security and observability

Structured logs include:

- Product Session and Sidecar/Runtime generation;
- resolver decision codes;
- artifact/protocol/profile identities;
- request method, operation/item/interaction identity and duration;
- queue/stop/config/mutation state;
- process exit and reconciliation result.

Logs exclude:

- credentials and authorization material;
- prompt, assistant, thinking and tool payload text;
- raw attachment bytes and user file contents;
- private system prompts and arbitrary Provider error bodies.

The support surface exposes redacted readiness and lifecycle facts plus recovery actions. A DSH failure must be diagnosable without opening the Runtime's durable conversation files.

## 19. Proposed code ownership map

Suggested paths; exact names may change without changing owners:

```text
src/shared/integrated-runtimes/
  identity.ts
  distribution-policy.ts
  resolver.ts
  provider-constraints.ts
  dsh-compatibility.ts
  dsh-lock.json

scripts/integrated-runtimes/
  ingest-dsh-handoff.mjs
  verify-dsh-resources.mjs

src/server/integrated-runtimes/dsh/
  adapter.ts
  process-host.ts
  generated-client.ts
  host-ports.ts
  event-projector.ts
  profile-compiler.ts
  extension-compiler.ts
  lifecycle.ts
  mutations.ts

src/server/session-engine/
  selector.ts
  types.ts

src-tauri/src/sidecar/
  runtime_identity.rs
  session_lifecycle.rs
  types.rs
```

Likely shared refactors:

- generalize `src/shared/providerExecution.ts` from Codex-only execution intent;
- replace binary `shouldUseExternalRuntime` decisions at product seams;
- extract the Host tool dispatcher from managed-Codex-specific placement;
- extend `UnifiedEvent` only for proven projection gaps;
- preserve current Chat/Launcher/Agent Settings transition components;
- update build-resource staging and Tauri resource manifests;
- verify the single bundled Node against the exact Runtime requirement and pin MyAgents' bundled npm distribution independently before DSH process work begins.

## 20. Verification and release gates

### 20.1 Deterministic tests

- distribution policy and resolver matrix;
- all legal/illegal legacy identity conversions;
- explicit External versus dormant subscription precedence;
- `anthropic-sub` and `codex-sub` required-runtime behavior;
- Settings/Launcher versus active Chat transition behavior;
- frozen Session behavior with selector hidden and with distribution exclusion;
- DSH handshake/artifact/schema/capability mismatch;
- exact handoff ingestion, generated-diff, complete-inventory, bundled-Node mismatch rejection, and deterministic bundled-npm resource validation;
- native DeepSeek plus every explicitly allowlisted pi-ai Provider/model cell, including rejection of catalog-only and OAuth/cloud cells;
- generated RPC client, reverse ports and cancellation;
- event ordering, reconnect replay and cross-generation dedupe;
- queue/follow-up/steer/stop races;
- configuration desired/effective transitions;
- all four DSH base permission modes, accepted `auto/plan/fullAgency` mappings, Plan enter/exit/retry/stale revision, exact rule add/list/revoke/restart, interaction settlement and timeout;
- `fullAgency` still obeys hard policy, origin/workspace/revision constraints and Host Hook deny;
- automatic model-aware compaction, explicit `session/compact`, repeated-compaction/restart continuity, provider-overflow recovery, and rejection of any Host-owned summary or pressure policy;
- transcript terminal/persistence failure reconciliation;
- fork/rewind/delete crash points;
- IM rotation and Heartbeat fallback;
- artifact staging/path/symlink/tamper rejection;
- credential canaries and log redaction.

Default tests use fake model and Host adapters, temporary homes/workspaces and no real network or credentials.

### 20.2 Product integration campaigns

Against the exact staged DSH artifact:

- J1–J18 from the accepted PRD;
- Desktop, IM, Task/Cron, Goal, Inbox and injected entry points;
- ordinary Provider routes for every advertised API-family cell;
- permission and AskUser inline, Host Plan transitions, exact always-allow rule creation/revocation, and no inert permission controls;
- tools, MCP, Skills, Host tools, Hooks, attachment/image;
- restart/resume, operation uncertainty and mutation recovery;
- packaged macOS arm64 smoke and native Windows/Linux campaigns before verified claims;
- bounded soak with process/memory/file-descriptor checks.

### 20.3 Repository gates

At promotion:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Also run MyAgents packaging/resource verification, Rust tests, DSH/MyAgents cross-contract conformance, generated-diff checks and native platform smoke required by the release candidate.

## 21. Implementation sequence

1. Preserve the current dirty worktree, verify every single-bundled-Node version authority at `24.14.0`, pin the separately owned bundled-npm resource, and land explicit-path exact handoff ingestion/resource verification.
2. Land identity, distribution policy, resolver and legal/illegal legacy fixtures.
3. Generalize Provider execution constraints and preserve existing transition behavior.
4. Land the exact Provider/model cell compiler plus the formal `2.0.0` generated protocol client.
5. Build `RuntimeProcessHost`, reverse ports, sanitized child environment and handshake.
6. Build the DSH SessionEngine adapter, serialized event inbox, projection and transcript reconciliation.
7. Connect queue/steer/follow-up/stop, configuration, interactions, Host Plan, exact permission-rule management, extensions and Host canonical web.
8. Connect mutation and recovery protocols.
9. Migrate every non-Desktop entry point through the same resolver/adapter.
10. Expose grouped selector/readiness and existing new-Tab behavior.
11. Run deterministic, packaged and cross-repository J1–J18 acceptance; only then allow controlled rollout.

Each step updates an implementation ledger in this document or a linked dev plan. Partial code does not make DSH selectable.

### 21.1 Implementation ledger

| ID | Action | Status |
| --- | --- | --- |
| MA-B3-RFC | Current-code and exact-handoff technical review | `complete` |
| MA-B3-H0 | Node/npm resource authority, formal `2.0.0` handoff ingest, lock and resource verifier | `not_started` |
| MA-B3-H1 | Runtime identity, policy, resolver and persistence migration | `not_started` |
| MA-B3-H2 | Provider constraints and exact DSH profile compiler | `not_started` |
| MA-B3-H3 | RuntimeProcessHost, 40-method formal `2.0.0` generated client and seven reverse ports | `not_started` |
| MA-B3-H4 | SessionEngine adapter, projection, queue/config/interaction/mutation/recovery | `not_started` |
| MA-B3-H4P | `auto/plan/fullAgency` translation, Host Plan and exact permission-rule adapter | `not_started` |
| MA-B3-H5 | Desktop/IM/Task/Goal/Inbox UI and entrypoint integration | `not_started` |
| MA-B3-H6 | Packaged cross-repository J1–J18 acceptance | `not_started` |

## 22. PRD traceability

| PRD requirement | This RFC |
| --- | --- |
| P0-01 taxonomy | Sections 3, 5 |
| P0-02 policy/default | Section 4 |
| P0-03 preference/binding | Sections 3, 16 |
| P0-04 central resolution | Sections 4.3, 5.3 |
| P0-05 DSH adapter | Sections 5–6 |
| P0-06 Host ports | Section 9 |
| P0-07 product UI | Sections 10, 14 |
| P0-08 compatibility/readiness | Sections 7–8, 17 |
| P0-09 lifecycle/recovery | Sections 6, 11 |
| P0-10 mutations/history | Sections 13, 16 |
| P0-11 security/provenance | Sections 7, 8.3, 17–18 |
| P0-12 observability | Section 18 |
| P0-13 permission/Plan control plane | Sections 9.1, 12, 14.3 and 20 |
| P1-01 future Pi | Sections 3.1, 5.1; no Batch 3 UI |

## 23. Definition of done

The MyAgents side is complete only when:

- DSH is resolved as an Integrated Runtime through one central policy;
- old Session and Agent data migrate without semantic reclassification;
- all product entry points execute through the DSH SessionEngine adapter;
- standard conversation UI exposes only real, working capabilities;
- Provider subscriptions follow the confirmed required-runtime/new-Session behavior;
- exact DSH artifact/protocol/compatibility facts are verified before admission;
- the application uses the Runtime's accepted exact Node version and contains no second bundled Node or unverified version bypass;
- MyAgents' bundled npm resource is independently pinned and verified; it is never inferred from DSH build provenance or a floating registry tag;
- lifecycle, queue/stop, interactions, configuration, projection and mutations pass fault-injected tests;
- `auto/plan/fullAgency` are mapped to real Runtime behavior; Plan and exact rules use generated formal `2.0.0` methods; the UI makes no OS-sandbox claim;
- automatic and explicit compaction remain DSH-owned, while MyAgents exposes real status/control projection without a second memory or summary engine;
- J1–J18 pass against pinned MyAgents and DSH commits;
- release/platform claims match native evidence;
- DSH remains controlled rollout and Claude Agent SDK remains the general default for this development release.

## 24. References

- `../../../MyAgents-dsh/specs/prd/prd_0.3_myagents_integration.md`
- `../../../MyAgents-dsh/specs/prd/tech_rfc_0.3_myagents_dsh_integration.md`
- `../../../MyAgents-dsh/specs/tech_docs/permissions-and-interactions.md`
- `../../../MyAgents-dsh/specs/tech_docs/compaction-architecture.md`
- `../../../MyAgents-dsh/specs/tech_docs/runtime-protocol.md`
- `../../../MyAgents-dsh/specs/tech_docs/artifact-verification-and-handoff.md`
- `../ARCHITECTURE.md`
- `./multi_agent_runtime.md`
- `../prd/prd_0.1_pi_native_agent_runtime_myagents_integration.md`
- `../prd/prd_0.1_pi_native_agent_runtime_myagents_integration_technical_rfc.md`
