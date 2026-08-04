# Pi Event Platform — Architecture

**Status:** Architecture design (pre-implementation; increments on the Step 1.3 kernel)
**Scope:** Design only. No implementation yet.
**Related:** `docs/CAPABILITY_PLATFORM_CONTRACTS.md` (Step 1.2), `docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` / `docs/capability-platform/RUNTIME_KERNEL_REPORT.md` (Step 1.3), `docs/PLANNING_ARCHITECTURE.md`, `docs/WORKSPACE_ARCHITECTURE.md`, `docs/KNOWLEDGE_MEMORY_ARCHITECTURE.md`

---

## 1. Foundation: What Already Exists

The platform contracts (Step 1.2) already define the event envelope and the bus contract; the kernel (Step 1.3) provides a minimal bus implementation. This design builds on them — nothing below redefines existing infrastructure.

| Concern | Already defined (Step 1.2 contracts) | Already implemented (Step 1.3 kernel) |
|---------|--------------------------------------|----------------------------------------|
| Event envelope | `PlatformEvent` (id, `EventType`, `metadata`, payload), `createEvent()`, `EventId` | — |
| Event metadata | `EventMetadata` (timestamp, source, priority, scope, correlationId, causationId, tags), `EventSource`, `EventPriority` (0/50/100/200), `EventScope` (global/capability/session/workspace/runtime/directed) | — |
| Canonical types | `PlatformEventType` const (`capability.*`, `tool.*`, `command.*`, `session.*`, `model.*`, `prompt.*`, `context.*`, `compaction.*`, `settings.*`, `permission.*`, `extension.*`, `host.*`, `system.*`) + per-domain payload interfaces | — |
| Bus contract | `EventBusService` (emit, emitSync, subscribe, subscribeAll, getHistory, clearHistory, stats), `SubscribeOptions` (filter, priority, replay) | `KernelEventBus` — emit/subscribe/unsubscribe only; synchronous subscription-order delivery; filters honored; replay throws "not implemented"; no history |
| Validation schema | `PlatformEventSchema` (TypeBox) | — |
| Registry | — | `KernelCapabilityRegistry` + per-capability `CapabilityContext` (long-lived, includes the bus) |

**What this document adds** (not in the contracts, not in the kernel):

- `SubscriberRegistry` (typed subscriber registration with execution class)
- `ExecutionContextFactory` + `ContextProviderRegistry` (per-dispatch shared context)
- `EventScheduler` (ordering, priorities, concurrency, timeouts)
- `BackgroundDispatcher` (durable queue, retries, idempotency)
- `EventLog` (tracing/history; the contracts' `getHistory`/`stats` surface)
- Loop guardrails, per-subscriber error isolation, per-event-type payload schemas

The bus described here **is** the `EventBusService` contract, and events use the contract envelope verbatim — `PlatformEvent` (id, type, metadata, payload) with typed per-event payloads.

---

## 2. Objective

Introduce a platform-wide event architecture that evolves Pi from a predominantly request-driven system into an event-driven runtime while preserving deterministic execution, local-first operation, and minimal complexity. The Event Platform is a lightweight coordination layer that eliminates orchestration coupling: subsystems publish immutable facts describing completed work (e.g. `ConversationFinished`), and interested components subscribe independently and do their own processing. No subsystem owns the workflow.

## 3. User Intent

- **3.1 Local-first:** one process, one machine, one user, one local workspace. No external infrastructure (Redis, Kafka, etc.).
- **3.2 Independent systems:** Planning, Memory, Reflection, Workspaces evolve independently and react only to relevant events.
- **3.3 Incremental extensibility:** adding functionality = adding a subscriber (Open/Closed).
- **3.4 Event-driven background work:** non-latency-sensitive work (reflection, embedding, indexing) runs independently of interactive requests.
- **3.5 Deterministic execution:** ordering is explicitly modeled where it matters; otherwise components execute concurrently.

## 4. Scope

**Responsibilities:** event publication, subscriber registration, dispatch, scheduling, execution-context creation, subscriber isolation, background dispatch, event persistence, execution diagnostics.

**Out of scope:** memory extraction, planning, reflection, workspace indexing, embedding generation — all of these become *subscribers* on top of this platform.

---

## 5. Design Principles

1. **Events describe facts, never commands.** `ConversationFinished`, `WorkspaceMerged` — not `StoreMemory`, `RunReflection`. Subscribers decide the actions. (A corollary: no command/request events. Requests remain direct calls.)
2. **Events are immutable.** A published event never changes; all subscribers observe the identical object.
3. **Events are lightweight.** Payloads carry only identifiers and small metadata. Large state (messages, memories, diffs) is resolved through the per-dispatch Execution Context (§11). Payload size is enforced by per-event-type schemas (§8).
4. **The platform coordinates; it never decides.** No business logic inside the bus, scheduler, or dispatcher.
5. **Independence over orchestration.** Complex workflows emerge as event chains (`ConversationFinished → MemoryExtractor → MemoryStored → ReflectionWorker`), kept locally understandable — but chains are bounded and instrumented (§14).
6. **Build on the platform model.** New event types extend `PlatformEventType`; the bus implements the `EventBusService` contract; the implementation evolves `KernelEventBus`.

---

## 6. High-Level Architecture

```
Runtime (kernel)
  │  owns
  ├─ EventBusService          ← existing contract; KernelEventBus (minimal) today
  ├─ SubscriberRegistry       ← new: EventType → typed Subscriber[]
  ├─ EventScheduler           ← new: dispatch classes, ordering, timeouts
  ├─ ExecutionContextFactory  ← new: per-dispatch shared context
  │    └─ ContextProviderRegistry (Conversation, Workspace, Git, Session…)
  ├─ BackgroundDispatcher     ← new: durable queue, retries, idempotency
  └─ EventLog                 ← new: tracing/history; wires getHistory/stats
        │
        ▼
  Higher-level systems (Planning, Memory, Reflection, Workspaces)
  └─ subscribe only — one-directional integration, no cycles
```

---

## 7. The Event Model

```ts
// @earendil-works/pi-platform/event — existing contract, used verbatim
interface PlatformEvent {
  id: EventId;                  // branded
  type: EventType;              // branded, namespaced "domain.action"
  metadata: EventMetadata;      // timestamp(ms), source, priority, scope,
                                // correlationId, causationId, tags
  payload: unknown;             // typed per event type via payload interfaces
}
```

- **correlationId** groups events from one higher-level activity; **causationId** links an event to the one that directly produced it — both already in `EventMetadata`.
- **source** (runtime/capability/service/host/user/system) and **scope** (global/capability/session/workspace/runtime/directed) are first-class: scope gates delivery, source gates attribution.
- Build new events with `createEvent(type, payload, options)`; validate with `PlatformEventSchema` + per-type payload schemas (§8).

---

## 8. Event Taxonomy & Governance

- **Domains:** logical groupings (`Conversation.*`, `Workspace.*`, `Memory.*`, `Planning.*`, `Capability.*`, …). The `capability.*` set already exists in `PlatformEventType`; `Conversation.*`, `Workspace.*`, `Memory.*`, `Planning.*` are added when their owning systems ship (agent-loop bridging, §17).
- **Single publisher per event type** — the owning subsystem publishes `Conversation.*`; memory publishes `Memory.*`. Prevents write conflicts and ambiguous semantics.
- **Every event type has a TypeBox payload schema** (extending the contracts' per-domain payload interfaces). Validation runs at publish time; oversized or non-schema payloads are rejected deterministically — payloads stay lightweight by construction.
- **Additive evolution only:** `ConversationFinished` → `ConversationFinishedV2` when semantics must change; existing subscribers keep working. This matches the contracts' `schemaVersion` discipline.

---

## 9. Subscriber Model

```ts
interface Subscriber<TEvent extends PlatformEvent = PlatformEvent> {
  id: string;                       // unique subscriber id (audit/logging)
  eventType: EventType;
  handler: (event: TEvent, ctx: EventExecutionContext) => Promise<void>;
  execution: "inline" | "background" | "deferred";   // §12
  priority?: number;                // ordering within a dispatch (higher first)
  timeoutMs?: number;               // declared, enforced by the scheduler
  idempotent?: boolean;             // required true for background (§15)
  filter?: (event: TEvent) => boolean;
}
```

- **One concern per subscriber; independently testable.** Subscribers may load context, compute, publish events, or schedule background work — but never coordinate other subscribers or assume their order.
- **Long-lived, registered at runtime/capability initialization.** A capability registers its subscribers from its `init()` (Step 1.3 lifecycle).
- **Ordering independence:** a subscriber must not depend on another subscriber having run. Ordering dependencies are expressed as new events (a chain), never as implicit order.
- Registration validates `eventType` against the type registry and payload schemas.

---

## 10. SubscriberRegistry

Owns the `EventType → Subscriber[]` mapping.

- Register/unregister with lifecycle (`start`/`stop` per subscriber, so tests and hot reload can detach cleanly).
- One subscriber per (id, eventType); duplicate registration is an error.
- Snapshot semantics for dispatch: the scheduler iterates a frozen copy, so a subscriber registering/unregistering during a dispatch never mutates the in-flight set.

---

## 11. Execution Context (per dispatch)

One shared context per event dispatch, across all of that dispatch's subscribers.

- **Lifetime:** exactly the dispatch; discarded afterwards — bounded memory, no stale caches.
- **Lazy resolution:** `await ctx.messages()` loads only when requested. Unused providers cost nothing.
- **Promise deduplication:** concurrent subscribers requesting the same context share one in-flight promise — the provider runs once.
- **Distinct from `CapabilityContext`:** the capability context is long-lived and per capability (Step 1.2 contract); the execution context is ephemeral and per dispatch. Subscribers receive the dispatch context; it may *expose* capability/service access underneath.

```ts
interface EventExecutionContext {
  event: PlatformEvent;
  signal: AbortSignal;                 // cooperative cancellation (§13.4)
  // Lazy, promise-deduplicated providers:
  conversation?: ConversationProvider;
  workspace?: WorkspaceProvider;
  session?: SessionProvider;
  git?: GitProvider;
  // … registered via ContextProviderRegistry
}
```

**ContextProviderRegistry** binds provider names to resolution functions, isolating subscribers from storage (SQLite, filesystem, vector store). Providers are deterministic code; they resolve platform state the lightweight event deliberately omitted.

---

## 12. EventScheduler

Determines dispatch class, ordering, concurrency, timeouts, and error isolation.

- **Dispatch classes (from `subscriber.execution`):**
  - *inline* — awaited in order before the publisher's `emit()` resolves; deterministic (priority, then registration order). Default for short, required work (telemetry, sync bookkeeping).
  - *background* — handed to the `BackgroundDispatcher`; `emit()` returns immediately.
  - *deferred* — scheduled for later (nightly maintenance, stale cleanup); governed by the dispatcher.
- **Ordering rules (explicit, documented):**
  - Inline subscribers: `priority` desc, then registration order — deterministic.
  - Events published by one publisher: publication order.
  - Background/concurrent subscribers: unordered by design.
- **Timeouts:** per-subscriber `timeoutMs` enforced by the scheduler (inline) or the dispatcher (background); expiry produces an observable `*TimedOut` fact and never cancels unrelated work.

## 13. Error Isolation, Cancellation, Retry

- **13.1 Per-subscriber containment (required; a known kernel gap):** the current `KernelEventBus` awaits handlers in subscription order and propagates a throw — one failing subscriber aborts the rest of the dispatch. The scheduler-level dispatch **must** catch per subscriber, record the failure in the `EventLog`, and continue. This is the first increment (§18).
- **13.2 Domain error facts:** recoverable failures surface as domain events published by *business logic* (`ReflectionFailed`) — the platform only records; it never invents business semantics.
- **13.3 Retries are the BackgroundDispatcher's job, not business logic.** Retry policy (max attempts, backoff) is governance config. Subscribers must be idempotent to make retries safe.
- **13.4 Cancellation is cooperative:** an `AbortSignal` on the execution context; long-running subscribers check it and unwind.

---

## 14. Event Chains & Loop Guardrails

Chains are the mechanism for "dependencies expressed through events," and they need deterministic guards:

- **Causation depth cap:** per correlationId, a maximum chain depth (governance, default 32). Exceeding it drops the event, logs `chain.depth_exceeded`, and emits a diagnostics event — an infinite `A→B→A` loop cannot run forever.
- **Self-trigger rule:** a subscriber must not publish, synchronously within its own handler, an event type it also subscribes to for the same correlationId (detected; dropped + logged).
- **Background idempotency keys:** background jobs carry a stable job id (eventId + subscriberId) so retries and duplicates collapse deterministically.
- **Tooling:** the EventLog + correlationId reconstruct any chain for debugging — this replaces "hidden orchestrator state" with inspectable causality.

---

## 15. BackgroundDispatcher

- Owns the durable job queue, retries, backoff, concurrency bounds, and priority for `background`/`deferred` subscribers.
- **Local-first:** in-memory queue for v1; a durable (SQLite) queue is an incremental addition — the interface is a narrow `JobQueue` port, not a framework.
- Jobs reference (eventId, subscriberId); the dispatcher re-resolves the event/context.
- **Idempotency:** subscribers with `execution: "background"` must declare `idempotent: true`; the dispatcher dedups by job id.
- **Retry:** bounded attempts with exponential backoff (governance); permanent failure → recorded + domain error fact.
- **Concurrency:** bounded worker pool (default 1–4) — deterministic enough for local-first, extensible to worker threads later.

---

## 16. Event Persistence (EventLog) & Replay

- **EventLog:** append-only tracing record — event id, type, timestamp, source, correlation/causation ids, per-subscriber results (success/error/timeout/duration). In-memory bounded ring for v1; durable append (SQLite) later.
- **Wiring:** the contracts' `EventBusService.getHistory`/`clearHistory`/`stats` are currently no-ops in `KernelEventBus`; the EventLog is the increment that makes them real.
- **Replay:** the contracts' `SubscribeOptions.replay` already exists (kernel throws today). Replay is the *last* increment, behind the EventLog, for diagnostics and subscriber backfill. Not for general-purpose "replay everything" — the local-first model does not need it.

---

## 17. Integration with the Platform Features

- **Kernel (Step 1.3):** already emits `capability.registered/initialized/ready/error/shutdown`. The EventScheduler + Registry + Context layer on top of `KernelEventBus`; the kernel's lifecycle events flow through unchanged.
- **Planning:** reacts to `ConversationFinished`; publishes `PlanApproved`, `PlanReplanned` (per `docs/PLANNING_ARCHITECTURE.md`).
- **Memory:** `MemoryExtractor` is a background subscriber on conversation/tool events (per `docs/KNOWLEDGE_MEMORY_ARCHITECTURE.md` §8).
- **Reflection:** a background subscriber chained after `MemoryStored`, with its own `ReflectionTimedOut`/`ReflectionFailed` facts.
- **Workspaces:** `WorkspaceMerged` triggers independent code indexing (per `docs/WORKSPACE_ARCHITECTURE.md` §12).
- **Agent-loop bridging:** today's extension events (`turn_end`, `tool_execution_end`) become the `Conversation.*` platform domain when hosts decouple; until then the memory/planning subscribers consume the extension event surface. This is explicit in the migration phase, not a frozen vocabulary.

---

## 18. Roadmap (increments on the kernel, no rewrites)

1. **Scheduler + SubscriberRegistry + ExecutionContext** on the existing bus; per-subscriber error isolation (fixes the propagate-on-throw gap).
2. **Timeouts + cooperative cancellation**; inline ordering/priority semantics.
3. **BackgroundDispatcher** (queue, bounded concurrency, retries, idempotency keys).
4. **EventLog** (ring → durable) wiring `getHistory`/`stats`.
5. **Agent-loop bridging** → `Conversation.*` domain; then `Workspace.*`, `Memory.*`, `Planning.*` event types + payload schemas.
6. **Replay** (last, diagnostics-only, behind `SubscribeOptions.replay`).

## 19. Non-Goals

Not a workflow engine, not an enterprise message broker, not CQRS/Event Sourcing, not a distributed actor system, not a plugin framework, not a command bus, and — until Phase 6 — not replay.

---

## 20. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Infinite event loops (`A→B→A`) | Hangs, log flooding | Causation depth cap + self-trigger rule (§14) |
| Subscriber failure aborts dispatch | Silent work loss | Per-subscriber containment (first increment; known kernel gap) |
| Ordering assumptions | Nondeterministic behavior | Explicit rules: inline ordered, background unordered, documented per subscriber |
| Chain debugging | Opaque causality | correlationId + EventLog chain reconstruction |
| Payload bloat | Coupling, serialization cost | Per-event-type TypeBox schema + publish-time validation |
| Retry storms | Duplicate work | Backoff + idempotency keys + bounded attempts |
| Sync/async confusion | Blocked inference | `execution` class declared on every subscriber; enforced by the scheduler |

---

## 21. Open Questions

- **Inline failure policy:** default `continue` (record + log) — confirm whether any dispatch class should fail fast.
- **EventLog retention:** ring size / durable retention window; whether logs should be user-inspectable in interactive mode.
- **Background concurrency default:** 1 (max determinism) vs 4 (throughput) for single-user local-first.
- **Chain depth default:** 32 reasonable, or should depth be per-domain (memory chains deeper than workspace chains)?
- **Replay scope:** per-subscriber backfill vs whole-log; whether it ever runs automatically after a crash.
- **Command-vs-fact edge cases:** some subsystems need request/response semantics (e.g., "reindex now") — confirm those stay direct calls and never become events.

---

## 22. Validation Checklist

- [ ] Inline subscribers run in `priority` then registration order; `emit()` resolves only after all inline handlers complete.
- [ ] A throwing inline subscriber is recorded in the EventLog and does **not** prevent later subscribers from running.
- [ ] Execution context is single per dispatch, lazy, promise-deduplicated (two subscribers requesting `conversation` trigger one provider call), discarded at dispatch end.
- [ ] Causation depth cap halts an `A→B→A` loop deterministically (logged, diagnostic event emitted).
- [ ] Background jobs retry with backoff and dedup by (eventId, subscriberId); non-idempotent background subscribers are rejected at registration.
- [ ] Timeout produces a `*TimedOut` fact; unrelated subscribers complete normally.
- [ ] Publish-time payload schema validation rejects oversized/non-schema payloads.
- [ ] EventLog reconstructs a full chain from one correlationId (inline + background).
- [ ] SubscriberRegistry snapshot semantics: a subscriber registering mid-dispatch does not affect the in-flight set.
- [ ] Capability-init registration: a capability's subscribers register during `init()` and unregister on shutdown (Step 1.3 lifecycle).
