# Pi Knowledge & Memory Engine — Architecture

**Status:** Architecture design (pre-implementation)
**Scope:** Design only. No implementation yet.
**Related:** `docs/PLANNING_ARCHITECTURE.md`, `docs/WORKSPACE_ARCHITECTURE.md`, `docs/CAPABILITY_PLATFORM_CONTRACTS.md`, `docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` (Steps 1.2/1.3)

---

## 1. Executive Summary & User Intent

Pi evolves from a stateless responder into a continuous-learning collaborator governed by strict contextual boundaries.

Memory is tri-tiered — **Session, Project, Global** — to prevent cross-contamination between disparate topics (a cooking discussion must never retrieve video game strategies). Session memory is isolated working memory for an active chat; Project memory is a deep, domain-specific base for themed session groupings (a codebase, a hobby); Global memory is a persistent user-wide layer for preferences and cross-project best practices.

The tiers interact through a **dynamic weighted scoring system during retrieval**, not boolean inclusion/exclusion:

- A session tagged with a `projectId` biases retrieval heavily toward that project's memories (project weight 1.5x) for deep domain focus.
- An unassigned session still accesses Global memory, but intentionally deprioritized (0.6x) so past contexts cannot distract from the current task.

The agent relies primarily on immediate session context, pulling in stored knowledge as a subtle background guide — a balance between long-term personalization and short-term task isolation.

---

## 2. Principles & Non-Goals

### Principles

- **Memory is a Knowledge Engine, not a vector database.** The primary unit is a structured, metadata-rich object; embeddings are a secondary index.
- **Deterministic over LLM, everywhere it is possible.** Only ~10–20% of operations may invoke an LLM; the rest is pure TypeScript (this is an enforced budget, see §5.7).
- **Strict scope isolation.** Retrieval never crosses project boundaries; global knowledge is always deprioritized.
- **Local-first.** All storage is on-device; no cloud sync, no remote memory service.
- **Event-driven.** Every write path is triggered by events (`turn_end`, `tool_execution_end`, `workspace.merged`, `session.closed`); the inference path is never blocked.
- **A platform capability, not core-file surgery.** Memory is a capability on the Pi platform (Steps 1.2/1.3); no agent-loop or extension-runner core files are mutated.
- **Explicit and inspectable.** Users can see, edit, and delete their memories.

### Non-Goals

- No cloud sync or multi-user memory.
- No general RAG over arbitrary documents (that is a separate feature; this engine indexes *what Pi did and learned*).
- No real-time semantic memory — extraction/classification/storage run in the background.
- No vector-DB service dependency for v1 (SQLite + in-process cosine is sufficient at local scale; see §5.3).
- No environment/dependency isolation (see `docs/WORKSPACE_ARCHITECTURE.md`).

---

## 3. Conceptual Model

### 3.1 Memory tiers

| Tier | Lifetime | Content | Retrieval weight |
|------|----------|---------|------------------|
| **Session** | Ephemeral (dies with the session, unless promoted) | Working memory of the active chat | 1.0 |
| **Project** | Long (project lifetime) | Domain knowledge for a tagged session group | 1.5 when the session is tagged to that project; **excluded** for other projects |
| **Global** | Permanent | User preferences, cross-project best practices | 0.6 (always deprioritized) |

### 3.2 The knowledge unit: `MemoryEntry`

Structured metadata is the primary unit; embeddings are optional.

```ts
interface MemoryEntry {
  id: string;
  text: string;
  /** Canonical key for exact-match facts ("prefers Celsius").
   *  Present exactly when `embedding === null`. */
  factKey?: string;
  /** Null for exact-match facts: no vector, no embedding cost. */
  embedding: number[] | null;
  metadata: MemoryMetadata;
  version: number;          // bumped on content/importance updates and dedup merges
  createdAt: number;
  updatedAt: number;
  lastRetrievedAt: number;  // maintenance/eviction input (see §5.5)
}

interface MemoryMetadata {
  scope: "global" | "project" | "session";
  projectId?: string;       // required when scope === "project"
  sessionId: string;        // originating session (audit)
  type: "preference" | "fact" | "procedure" | "code" | "temporary";
  lifetime: "ephemeral" | "long" | "permanent"; // retention class (see §9)
  ttl?: number;             // ms; ephemeral/long only
  importance: number;       // 0.0–1.0
  confidence: "provisional" | "stable";  // promoted by repeated evidence
  source: {
    eventType: "turn_end" | "tool_execution_end" | "workspace_merged" | "reflection" | "user";
    sessionId: string;
    turnIndex?: number;
  };
}
```

Rules:

- **Scope × lifetime consistency:** `session ⇒ ephemeral/long`, `project ⇒ long`, `global ⇒ permanent`. Violations are rejected at write time (deterministic).
- **`factKey` vs `embedding`:** exact-match facts store no vector and are matched by canonical key (and participate in keyword search). Everything else is embedded. This is the "prefers Celsius" optimization.
- **Versioning:** content updates, importance changes, and dedup merges bump `version`; the history of a promoted memory is a new entry referencing the old id via `source` metadata.

---

## 4. Retrieval Scoring (The Weight Matrix, Complete)

The weight matrix must cover every session-type × scope combination. **Weights are governance parameters** (§5.7), not literals in code.

| Memory scope | Unassigned session | Project-tagged session |
|--------------|-------------------|------------------------|
| `session`    | 1.0               | 1.0                    |
| `project` (same project) | — (none exists) | **1.5** |
| `project` (other) | **excluded** | **excluded** |
| `global`     | **0.6**           | **0.6**                |

**Scoring formula** (all terms deterministic):

```
FinalScore = (SemanticScore × ScopeWeight + RecencyBonus) × ImportanceFactor

SemanticScore   = max(vectorCosine, bm25, 1.0 if exact factKey match)
RecencyBonus    = k × exp(−ageHours / halfLifeHours)
ImportanceFactor= 0.6 + 0.4 × importance        // bounded: can never zero a match
```

- `SemanticScore` ∈ [0,1]; hybrid = max of vector + keyword + exact-match.
- `RecencyBonus`: `k` (default 0.2) and `halfLifeHours` (default 24) are governance parameters.
- `ImportanceFactor` keeps importance as a multiplier, bounded so low-importance memories can still surface when the semantic match is strong.

Retrieval is **purely deterministic — never an LLM call.**

---

## 5. Subsystems

Seven modules. The deterministic/LLM split is enforced per module and globally audited against the 10–20% budget (§5.7).

### 5.1 Knowledge Extraction (Gatekeeper)

- **Triggers:** `turn_end`, `tool_execution_end` (durable artifacts only), `workspace.merged` (code), `session.closed` (finalize).
- **Logic (deterministic heuristics first):** extract candidates when e.g. turn length ≥ 3, explicit preference signals, architecture decisions, stable tool results. Transient states ("Today I am making pasta") are filtered by the `temporary`/TTL classification, not by the LLM.
- **LLM usage:** *minimal* — a local model is invoked only when heuristics flag high-value ambiguity. Output: strict JSON candidate (same schema discipline as `docs/PLANNING_ARCHITECTURE.md` §11).
- **Output:** `MemoryCandidate[]` → classification.

### 5.2 Knowledge Classification (Metadata Assignment)

- **Logic:** algorithmic rule engine mapping candidates to the `MemoryMetadata` schema (type, scope, lifetime, importance, confidence, TTL).
- **Rule examples:** preference verbs → `preference`; multi-step instructions → `procedure`; code entities → `code`; dated/one-off facts → `temporary` + short TTL; repeated mention → higher importance; project-tagged session + domain content → `project` scope.
- **LLM usage:** *rarely* — ambiguous edge cases only.
- **Output:** fully-populated `MemoryEntry` records ready for storage.

### 5.3 Knowledge Storage (Persistence)

- **Logic:** pure TypeScript. Local-first.
- **Store:** SQLite via the existing `packages/storage/sqlite-node` workspace package. Tables:
  - `memories(id, text, fact_key, embedding BLOB, metadata JSON, version, created_at, updated_at, last_retrieved_at)`
  - FTS5 index over `text` for deterministic BM25/keyword search.
  - Metadata filtering (scope/projectId/sessionId/type) via indexed JSON columns.
- **Vector search:** in-process cosine over loaded rows — deterministic, dependency-light, and bounded by `MaxProjectMemorySize`/`MaxGlobalMemorySize` (governance). No ChromaDB/LanceDB dependency for v1.
- **Embedding provider (narrow port, justified by re-indexing):**
  ```ts
  interface EmbeddingProvider { embed(text: string): Promise<number[]>; }
  ```
  Default: Ollama `nomic-embed-text`. Swappable because re-indexing (§5.5) must work across model changes without touching stored text.
- **Confidence gate:** first occurrence stores `provisional`; repeated evidence promotes to `stable` (§9).

### 5.4 Knowledge Retrieval (Context Assembly)

Deterministic pipeline, **never an LLM**:

1. **Pre-filter:** `sessionId` always; `projectId` when the session is tagged (excludes all other projects); `type`/`lifetime` filters.
2. **Hybrid search:** vector cosine over embedded rows + BM25/FTS5 over text + exact `factKey` match for null-embedding entries. Merge candidates, dedupe by id.
3. **Re-rank & weight:** the formula in §4.
4. **Context compression:** take top-K by score within a token budget; group into typed blocks before injection:
   ```
   [Relevant Preferences]
   [Relevant Facts]
   [Relevant Procedures]
   [Relevant Code]
   ```
   Budgets are governance parameters (per-block caps, total cap — default ≤ 15% of the context window), applied deterministically.

### 5.5 Knowledge Maintenance (Hygiene)

- **Trigger:** periodic background queue + `session.closed` + `project.closed`.
- **Operations (deterministic):**
  - *Deduplication:* cosine > 0.99 (or identical `factKey`) → merge (bump version, union sources).
  - *Eviction:* TTL expiry; unretrieved archival (`lastRetrievedAt > 180 days` → archived, excluded from retrieval).
  - *Session-end hygiene:* ephemeral session memories deleted; `provisional` project candidates discarded or kept per governance.
  - *Re-indexing:* swap the embedding model and recompute `embedding` for stored rows without altering text.
- **LLM usage:** *occasionally* — condensing 100+ session memories into one synthesized Project Summary (which enters the store as a new `reflection`-sourced entry).

### 5.6 Knowledge Reflection (Synthesis)

- **Trigger:** periodic queue, or `project.closed` / threshold reached (e.g., 100 new memories).
- **Logic:** semantic analysis of accumulated memories produces higher-order insights: four food memories ⇒ new global memory "User enjoys Japanese cuisine."
- **LLM usage:** *heavy* — the primary LLM sink by design (single-user local setup: latency irrelevant, quality paramount). May route to a high-capability model.
- **Safeguards:** reflection output is *provisional* until user-confirmed or corroborated; reflection never deletes source memories (sources are referenced in `metadata.source`).

### 5.7 Knowledge Governance (Policy Engine)

Static, validated configuration consumed by all six other modules — including the **weight matrix** (§4), **LLM budget**, and **privacy filters**:

```ts
interface MemoryGovernance {
  weights: { session: 1.0; projectMatch: 1.5; globalUnassigned: 0.6; globalProjectSession: 0.6 };
  recency: { bonus: 0.2; halfLifeHours: 24 };
  importance: { minFactor: 0.6; maxFactor: 1.0 };
  budgets: { maxSessionMemories: 200; maxProjectMemorySize: 10_000;
             maxGlobalMemorySize: 20_000; retrievalTokenCap: 2_000; blockCaps: {...} };
  confidence: { promotionEvidenceCount: 2; promotionDistinctSessions: 2 };
  llmBudget: { maxPercent: 20; extraction: "minimal"; classification: "rare"; reflection: "heavy" };
  privacy: { secretPatterns: [...]; redact: true; codeExcludesCredentials: true };
  retention: { ephemeralSessionTtlMs: 0 /* session end */; longUnretrievedDays: 180 };
}
```

- **LLM budget enforcement:** instrumentation counts LLM calls per module; governance reports and can hard-stop over-budget modules.
- **Privacy filters:** secret detection (API-key patterns, high-entropy strings) → redact or skip persistence; code indexing never stores credential-looking literals (§10).

---

## 6. Code Knowledge Subsystem

Code knowledge is strictly isolated from chat knowledge (separate store namespace, `type: "code"`).

- **Trigger:** `workspace.merged` (from `docs/WORKSPACE_ARCHITECTURE.md` §12) — code changes enter the code index when a task's workspace merges, not by watching raw git commits. This keeps indexing aligned with the isolation layer.
- **Pipeline:** parse changed files → extract functions, classes, exports, dependencies → embed **only changed nodes** (incremental, bounded).
- **Parsing:** deterministic lightweight extraction (exports/imports/structure) for v1; Tree-sitter (WASM) as a Phase-2 refinement for precise AST coverage. No LLM in the indexing path.
- **Storage object (rich, not raw chunks):**
  ```ts
  interface CodeMemory {
    entity: string;          // "Authentication System"
    files: string[];
    exports: string[];
    architectureSummary: string;
    dependencies: string[];
    embedding: number[];
  }
  ```
- **Retrieval:** code memories answer "where is X / how does this system work" in project-tagged sessions; chat memories never mix into code blocks and vice versa.

---

## 7. Platform Integration (Steps 1.2/1.3)

Memory is implemented as a platform capability with zero core-file mutation:

- **Memory capability** — category `memory`, implementing the platform's `MemoryCapabilityExport` contract (`store`/`retrieve`/`query`/`delete`), backed by the seven subsystems. `MemoryKey` is the entry id; `MemoryContext.scope` maps session/project/global onto the contract scopes.
- **Retrieval as a context provider** — category `context`, implementing `ContextCapabilityExport.provide()` → `ContextData` containing the typed blocks (§5.4). Injection rides the **existing context-transform surface** (`transformContext` / `emitContext` + `before_agent_start`), so no agent-loop change is needed.
- **Events consumed:** agent-loop events (`turn_end`, `tool_execution_end`) and platform events (`workspace.merged`, `session.closed`) trigger the write path. New canonical events published: `memory.stored`, `memory.promoted`, `memory.evicted`, `memory.reflected` (additions to the platform event constants when implemented).
- **Workers:** an in-process FIFO queue inside the memory capability (deterministic ordering, inference never blocked). Node worker threads are a later optimization; the kernel has no worker service yet (Step 1.3 report §6).
- **Governance as configuration:** the policy object is validated TypeBox configuration served through the platform's `ConfigurationService`.
- **LLM calls** (extraction/classification/reflection) use the platform `ModelRuntime` through the provider abstraction — never a hardcoded Ollama dependency at the call site (the embedding provider port defaults to Ollama; generation goes through pi's model stack).

---

## 8. Execution & Event Flow

**Immediate path (sub-second, never blocks on memory):**

```
User input → Agent → retrieval context provider (sync, deterministic) →
             LLM inference → response → emit turn_end
```

**Background path (seconds to hours):**

```
turn_end ─► Extraction worker (deterministic gate) ─► MemoryCandidateCreated
         ─► Classification worker (rules) ─► embed + store ─► MemoryStored
         ─► (periodic) Maintenance queue ─► dedup/TTL/eviction
         ─► (periodic/threshold) Reflection ─► synthesized memory (provisional)
```

**Feedback loop (Phase 4 of the roadmap):** retrieval analytics — which memories were retrieved, injected, and acted upon — adjusts governance weights/importance within bounded steps, never abruptly (§12).

---

## 9. Lifecycle & Promotion Rules

| Event | Effect |
|-------|--------|
| Session created | Fresh session scope; project tag optional |
| First mention of a fact | Stored `provisional` (session or project scope) |
| Same fact in ≥2 distinct sessions | Promoted to `stable`; may migrate `session → project` if the sessions share a project tag |
| Project repeated across sessions | Reflection may synthesize a `global` memory (provisional until confirmed) |
| Session closed | Ephemeral session memories evicted; stable project/global candidates kept |
| TTL expiry | Evicted (ephemeral/long) |
| Unretrieved > 180 days (long) | Archived, excluded from retrieval |
| User edits/deletes | Immediate, versioned; governance logged |

Migration is always **upward** (`session → project → global`) and only via promotion rules or explicit user action — never silently downward or sideways.

---

## 10. Privacy & Safety

- **Secret detection:** API-key patterns + entropy heuristics run on every candidate before persistence; matches are redacted or skipped per governance. Secrets are never embedded.
- **Code indexing excludes credentials** by default (credential-looking literals filtered before embedding).
- **Session isolation at rest:** project memories are only retrievable from that project's sessions; global memories are the only cross-project surface and are always deprioritized.
- **User visibility:** memories are inspectable and deletable (the capability's `query`/`delete`); reflection output is provisional until user-confirmed.
- Honest framing: this is a local-first knowledge store, not a security boundary. Encryption-at-rest is out of scope for v1 (single-user local).

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Cross-contamination via global memories | Wrong context injected | Deprioritized global (0.6x), project exclusion is hard, type-block separation |
| Weight tuning drift | Poor retrieval ranking | Governance-owned weights, analytics feedback with bounded steps, user-inspectable scores |
| LLM budget creep | Latency, cost, nondeterminism | Instrumented budget with hard stop per module (§5.7) |
| Vector/DB growth | Disk, slow retrieval | Governance size caps, TTL/eviction, archival of unretrieved entries |
| Reflection hallucination | Wrong synthesized "facts" | Provisional confidence + user confirmation; sources referenced; never deletes sources |
| Code index staleness | Stale architecture answers | Index on `workspace.merged` only; incremental changed-node embedding |
| Embedding model change | Broken vectors | Re-indexing job (§5.5) without touching stored text |
| Privacy leak (secret persisted) | Credential exposure | Pre-persist secret scan + redaction; code credential filter; user-deletable |
| Analytics feedback oscillation | Unstable weights | Bounded step size + minimum evidence threshold before any weight change |

---

## 12. Open Questions

- **Platform `user` scope vs `global`:** the platform contracts define four memory scopes (session/project/user/global); decide whether "global" maps to the platform `user` scope or stays a third tier.
- **Automatic `session → project` migration:** promote on repeated evidence automatically, or only via reflection/user confirmation?
- **Retrieval visibility:** should the user see which memories were injected (debug view), and can they pin/block specific entries?
- **Embedding model default and re-index policy:** which model; how often to re-index; what to do with cosine-distance incompatibility across models.
- **Reflection cadence and thresholds:** 100 memories is a guess; validate with real usage.
- **"Was the memory useful" signal:** how to measure usage in the final output (LLM-judge vs user signal vs injected-and-retrieved heuristic) before the analytics feedback loop is trustworthy.

---

## 13. Roadmap

- **Phase 1 — Foundation:** Session/Project/Global scoping, SQLite storage + FTS5 + in-process cosine, deterministic metadata pre-filtering, the full weight matrix and scoring formula (§4), retrieval as a context provider. No LLM in the loop.
- **Phase 2 — Gatekeepers:** Extraction and Classification workers (deterministic heuristics + bounded LLM), confidence gate, privacy filters, LLM budget instrumentation.
- **Phase 3 — Hygiene & Synthesis:** Maintenance (dedup, TTL, eviction, session-end hygiene, re-indexing) and Reflection (LLM-heavy synthesis with provisional confidence).
- **Phase 4 — Learning loop:** Retrieval analytics (retrieved/injected/used) feeding governance weights/importance with bounded, evidence-gated adjustments.

---

## 14. Validation Checklist

- [ ] Cross-contamination test: a cooking session never retrieves game-strategy memories (project exclusion hard; global deprioritized).
- [ ] Weight matrix test: every session-type × scope cell produces the documented weight; unassigned-session retrieval contains zero project memories.
- [ ] Scoring formula test: `RecencyBonus` decays deterministically; `ImportanceFactor` is bounded; exact `factKey` match beats vector-only matches for null-embedding facts.
- [ ] Retrieval is LLM-free: instrumented test asserting zero model calls on the retrieval path.
- [ ] Promotion test: fact seen in ≥2 distinct sessions becomes `stable`; `session → project` migration only under project tag.
- [ ] Eviction/TTL test: ephemeral memories deleted at session close; unretrieved `long` memories archived after 180 days.
- [ ] Dedup test: cosine > 0.99 (or same `factKey`) merges with version bump.
- [ ] Privacy test: secret-pattern candidates are redacted/skipped; code literals matching credential patterns are never stored.
- [ ] Code isolation test: chat and code namespaces never mix in retrieval blocks.
- [ ] LLM budget test: per-module call counts stay within governance limits; over-budget module hard-stops.
- [ ] Platform integration test: memory capability registers and initializes on the Step 1.3 kernel; context provider injects blocks through `emitContext` without touching the agent loop.
