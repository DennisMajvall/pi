# pi-coding-agent Architecture Report

**Version analyzed:** 0.83.0  
**Package:** `@earendil-works/pi-coding-agent`  
**Generated:** 2025-08-06

---

## 1. Application Startup Sequence

```
┌─────────────────────────────────────────────────────────────────────┐
│ CLI Entrypoint: src/cli.ts                                          │
│   ├── Sets process.title, process.env.PI_CODING_AGENT              │
│   ├── configureHttpDispatcher() (undici global dispatcher setup)   │
│   └── main(process.argv.slice(2))                                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Main Entry: src/main.ts → main(args)                                │
│   ├── parseArgs() - CLI argument parsing with diagnostics          │
│   ├── handlePackageCommand() - pi update/install/remove            │
│   ├── handleConfigCommand() - pi config                            │
│   ├── runMigrations(cwd) - Auth/setting migrations                 │
│   ├── SettingsManager.create(cwd, agentDir) - Bootstrap settings   │
│   ├── SessionManager creation (persisted/in-memory/fork/resume)    │
│   ├── ProjectTrustStore + trust resolution                         │
│   ├── ResourceLoader creation + reload()                           │
│   │   ├── PackageManager.resolve() - npm/git extensions            │
│   │   ├── loadExtensionsCached() - Load TS/JS extensions via jiti  │
│   │   ├── loadSkills/loadPromptTemplates/loadThemes                │
│   │   └── Extension source info mapping                            │
│   ├── ModelRuntime creation + refresh()                            │
│   │   ├── RuntimeCredentials (auth.json)                           │
│   │   ├── ModelConfig (models.json)                                │
│   │   ├── Builtin providers + remote catalog                       │
│   │   └── Provider composition (config + extensions)               │
│   ├── createAgentSessionRuntime(createRuntime, options)            │
│   │   └── createRuntime() → createAgentSessionServices()           │
│   │       ├── ModelRuntime.create()                                │
│   │       ├── SettingsManager.create()                             │
│   │       ├── DefaultResourceLoader.reload()                       │
│   │       └── modelRuntime.refresh({allowNetwork: false})          │
│   │   └── createAgentSessionFromServices() → createAgentSession()  │
│   │       ├── Agent creation (pi-agent-core)                       │
│   │       ├── Model selection (findInitialModel)                   │
│   │       ├── Thinking level resolution                            │
│   │       ├── Tool registry creation (builtin + extension)         │
│   │       ├── AgentSession instantiation                           │
│   │       │   ├── ExtensionRunner binding                          │
│   │       │   ├── _refreshToolRegistry()                           │
│   │       │   ├── _installAgentToolHooks()                         │
│   │       │   └── _installAgentNextTurnRefresh()                   │
│   │       └── sessionStartEvent emission                           │
│   ├── Mode resolution (interactive/print/json/rpc)                 │
│   ├── stdin handling (piped input → print mode)                    │
│   ├── Theme initialization                                         │
│   └── Mode execution:                                              │
│       ├── InteractiveMode.run() (TUI)                              │
│       ├── runPrintMode() (single-shot)                             │
│       └── runRpcMode() (JSON-RPC over stdin/stdout)                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Dependency Graph

### External Dependencies (package.json)
```
@earendil-works/pi-coding-agent
├── @earendil-works/pi-agent-core    → Core agent loop, state machine, streaming
├── @earendil-works/pi-ai            → Model providers, auth, streaming, compat layer
├── @earendil-works/pi-tui           → Terminal UI components (TUI, ProcessTerminal)
├── @silvia-odwyer/photon-node       → Image processing (WASM)
├── chalk                            → Terminal colors
├── cross-spawn                      → Cross-platform spawn
├── diff                             → Diff algorithm (edit tool)
├── glob                             → File globbing
├── highlight.js                     → Syntax highlighting
├── hosted-git-info                  → Git URL parsing
├── ignore                           → .gitignore parsing
├── jiti                             → TypeScript module loading (extensions)
├── minimatch                        → Glob matching
├── proper-lockfile                  → File locking (settings)
├── semver                           → Version comparison
├── typebox                          → JSON Schema (typebox runtime)
├── undici                           → HTTP client (dispatcher, providers)
├── yaml                             → YAML parsing
└── @mariozechner/clipboard (optional) → Clipboard access
```

### Internal Module Dependencies (src/core/)
```
core/
├── agent-session.ts           ← CENTRAL HUB (depends on most modules)
├── agent-session-runtime.ts   ← Session lifecycle management
├── agent-session-services.ts  ← Service factory
├── sdk.ts                     ← Public SDK API (createAgentSession)
├── model-runtime.ts           ← Provider registry, auth, streaming, remote catalog, composition
├── model-config.ts            → models.json config
├── model-registry.ts          → Provider composition
├── model-resolver.ts          → CLI/model resolution
├── settings-manager.ts        → Settings (global + project, file + memory)
├── resource-loader.ts         → Extensions, skills, prompts, themes, context files
├── session-manager.ts         → Session persistence (JSONL, tree structure)
├── extensions/
│   ├── index.ts               → Public exports
│   ├── loader.ts              → Extension discovery + jiti loading
│   ├── runner.ts              → Extension event dispatch, context API
│   ├── wrapper.ts             → Tool wrapping for extension hooks
│   └── types.ts               → Tool definition types, events, context API
├── tools/
│   ├── index.ts               → Tool definitions (read, bash, edit, write, grep, find, ls)
│   ├── bash.ts                → Bash execution with operations abstraction
│   ├── edit.ts                → File editing (diff-based)
│   ├── edit-diff.ts           → Diff utilities for edit tool
│   ├── read.ts                → File reading
│   ├── write.ts               → File writing
│   ├── grep.ts                → Ripgrep wrapper
│   ├── find.ts                → fd wrapper
│   ├── ls.ts                  → Directory listing
│   ├── file-mutation-queue.ts → File mutation queue for edit tool
│   ├── output-accumulator.ts  → Output accumulation for streaming
│   ├── path-utils.ts          → Path utilities
│   ├── render-utils.ts        → Result rendering utilities
│   ├── tool-definition-wrapper.ts → Agent tool to extension tool adapter
│   └── truncate.ts            → Output truncation
├── compaction/
│   ├── index.ts               → Public exports
│   ├── compaction.ts          → Context compaction (summarization)
│   ├── branch-summarization.ts → Branch summary generation
│   └── utils.ts               → Token estimation, context calculation
├── system-prompt.ts           → System prompt construction
├── prompt-templates.ts        → Prompt template expansion
├── skills.ts                  → Skill file loading
├── package-manager.ts         → npm/git extension/package management
├── http-dispatcher.ts         → undici global dispatcher config
├── bash-executor.ts           → Bash execution implementation
├── export-html/               → Session export
├── auth-storage.ts            → Auth credential storage
├── auth-guidance.ts           → Auth error guidance
├── cache-stats.ts             → Cache statistics
├── diagnostics.ts             → Diagnostic types
├── event-bus.ts               → Event bus implementation
├── exec.ts                    → Command execution utilities
├── experimental.ts            → Experimental feature flags
├── footer-data-provider.ts    → Footer data for TUI
├── keybindings.ts             → Keybinding definitions
├── messages.ts                → Message type definitions
├── models-store.ts            → Model data persistence
├── pi-manifest.ts             → pi manifest parsing
├── project-trust.ts           → Project trust resolution
├── provider-attribution.ts    → Provider attribution headers
├── provider-composer.ts       → Provider composition logic
├── radius.ts                  → Radius provider config
├── remote-catalog-provider.ts → Remote model catalog provider
├── resolve-config-value.ts    → Config value resolution
├── runtime-credentials.ts     → Runtime credential management
├── session-cwd.ts             → Session cwd validation
├── slash-commands.ts          → Slash command definitions
├── source-info.ts             → Source info for autocomplete
├── telemetry.ts               → Telemetry types
├── timings.ts                 → Performance timing utilities
├── trust-manager.ts           → Project trust store
├── usage-totals.ts            → Usage tracking
└── defaults.ts                → Default constants
```

### Mode Dependencies (src/modes/)
```
modes/
├── index.ts                   → Exports: InteractiveMode, runPrintMode, runRpcMode
├── print-mode.ts              → Single-shot text/JSON output
├── rpc/
│   ├── rpc-mode.ts            → JSON-RPC server over stdin/stdout
│   ├── rpc-client.ts          → Client for external RPC
│   ├── rpc-types.ts           → RPC protocol types
│   └── jsonl.ts               → JSONL line reader/serializer
└── interactive/
    ├── interactive-mode.ts    → TUI application (208KB)
    ├── components/            → 32 TUI components
    ├── theme/
    │   ├── theme.ts           → Theme system (JSON + editor themes)
    │   ├── theme-controller.ts → Live theme switching
    │   ├── theme-schema.json  → Theme JSON schema
    │   ├── dark.json          → Dark theme
    │   └── light.json         → Light theme
    └── external-editor.ts     → $EDITOR integration
```

---

## 3. How User Requests Are Processed

### Interactive Mode Flow
```
User Input (Editor submit)
        │
        ▼
InteractiveMode.handleEditorSubmit()
        │
        ├── Extension command? (/cmd) → ExtensionRunner.executeCommand()
        │
        ├── Skill command? (/skill:name) → Expand skill content
        │
        ├── Prompt template? (/template) → Expand template
        │
        └── Regular prompt → AgentSession.prompt()
                │
                ├── Extension input event (can transform/handle)
                │
                ├── Build messages array (user + pending nextTurn)
                │
                ├── Extension before_agent_start (can inject custom messages, modify system prompt)
                │
                ├── _runAgentPrompt(messages)
                │       │
                │       ├── Agent.prompt() → pi-agent-core
                │       │       │
                │       │       ├── Convert to LLM format (convertToLlmWithBlockImages)
                │       │       │
                │       │       ├── ModelRuntime.streamSimple() → Provider streaming
                │       │       │       │
                │       │       │       ├── prepareRequest() → auth, headers, env
                │       │       │       │
                │       │       │       └── Provider.streamSimple() → LLM API
                │       │       │
                │       │       ├── Agent event emission (message_start/update/end, tool_execution_*)
                │       │       │
                │       │       └── Tool execution (Agent calls tool, hooks fire)
                │       │
                │       └── _handlePostAgentRun()
                │               ├── Auto-retry on retryable errors
                │               ├── Auto-compaction on context overflow/threshold
                │               └── Continue if queued messages (steer/followUp/custom)
                │
                └── Event emission to UI (via subscribe())
```

### Print Mode Flow
```
runPrintMode(runtimeHost, options)
        │
        ├── rebindSession() → Session.bindExtensions({mode: "print"})
        │
        ├── initialMessage? → session.prompt()
        │
        ├── For each message in messages[] → session.prompt()
        │
        └── Output last assistant message (text or JSON events)
```

### RPC Mode Flow
```
runRpcMode(runtimeHost)
        │
        ├── rebindSession() → Session.bindExtensions({mode: "rpc"})
        │
        ├── JSON-RPC server on stdin/stdout
        │
        ├── Methods: prompt, steer, followUp, setModel, compact, etc.
        │
        └── Event streaming: agent events → JSON lines on stdout
```

---

## 4. Where Business Logic Currently Lives

### Core Business Logic Locations

| Domain | Primary Location | Description |
|--------|------------------|-------------|
| **Agent orchestration** | `core/agent-session.ts` (3332 lines) | Central hub: prompt handling, tool hooks, compaction, retry, model cycling, session persistence, extension event dispatch |
| **Session lifecycle** | `core/agent-session-runtime.ts` | Session switching, forking, branching, import, new session |
| **Service creation** | `core/agent-session-services.ts` | Factory for cwd-bound services (ModelRuntime, SettingsManager, ResourceLoader) |
| **Model management** | `core/model-runtime.ts` | Provider registry, auth, streaming, remote catalog, composition |
| **Configuration** | `core/settings-manager.ts` | Global/project settings, file locking, migration, overrides |
| **Resource loading** | `core/resource-loader.ts` | Extensions, skills, prompts, themes, context files, package manager |
| **Session persistence** | `core/session-manager.ts` | JSONL storage, tree structure (v3), compaction entries, branch summaries |
| **Compaction** | `core/compaction/` | Context summarization, token estimation, auto/ manual compaction |
| **System prompt** | `core/system-prompt.ts` | Tool-aware prompt construction, project context, skills |
| **Tools** | `core/tools/` | 7 builtin tools with definitions + execution |
| **Extensions** | `core/extensions/` | Loader (jiti), Runner (event dispatch, context API), Tool wrapper |
| **TUI/Interactive** | `modes/interactive/interactive-mode.ts` | Input handling, rendering, keybindings, component composition |
| **Print/RPC modes** | `modes/print-mode.ts`, `modes/rpc/rpc-mode.ts` | Non-interactive execution modes |

### Key Logic Concentration
**`AgentSession` (agent-session.ts, 3332 lines)** is the god class containing:
- Prompt/steer/followUp/sendCustomMessage/sendUserMessage
- Model selection/cycling/thinking level management
- Tool registry + active tool management
- Auto-retry + auto-compaction + branch summarization
- Bash execution
- Extension event emission (54 event types in types.ts, ~25 emitted from AgentSession)
- Session persistence coordination
- Queue management (steering/followUp/nextTurn)

---

## 5. How Tools Are Invoked

### Tool Registration Flow
```
1. createAllToolDefinitions(cwd, options) [tools/index.ts]
   → Creates definitions for: read, bash, edit, write, grep, find, ls

2. AgentSession._buildRuntime() [agent-session.ts]
   → Creates baseToolDefinitions Map
   → Creates ExtensionRunner with extensions
   → _refreshToolRegistry()

3. _refreshToolRegistry() [agent-session.ts]
   → Merges: base tools + extension tools + SDK custom tools
   → Filters by allowed/excluded tool names
   → Wraps all tools via wrapRegisteredTools() [extensions/wrapper.ts]
   → Creates toolRegistry Map (name → wrapped tool)
   → Creates toolPromptSnippets + toolPromptGuidelines Maps
   → Rebuilds system prompt via _rebuildSystemPrompt()
   → Sets agent.state.tools = active tools

4. Extension tool registration [extensions/loader.ts]
   → extension.registerTool(toolDefinition) during factory execution
   → Stored in extension.tools Map
   → ExtensionRunner.getAllRegisteredTools() returns first registration per name
```

### Tool Execution Flow
```
Agent (pi-agent-core) calls tool
        │
        ▼
AgentSession._installAgentToolHooks() [agent-session.ts]
        │
        ├── beforeToolCall hook → ExtensionRunner.emitToolCall()
        │       │
        │       └── Extensions can: inspect, modify args, block execution
        │
        ▼
Wrapped tool execution [extensions/wrapper.ts]
        │
        ├── ExtensionRunner.createContext() for this tool call
        │
        ├── Tool.execute(args, context)
        │       │
        │       └── Builtin tools: read, bash, edit, write, grep, find, ls
        │
        ▼
afterToolCall hook → ExtensionRunner.emitToolResult()
        │
        └── Extensions can: transform result, add details, change isError
        │
        ▼
Result returned to Agent → Agent event emission (tool_execution_end)
```

### Tool Definition Structure
```typescript
// Agent tool (pi-agent-core compatible)
{
  name: string,
  description: string,
  parameters: JSONSchema,        // TypeBox schema
  execute: (args, context) => Promise<ToolResult>,
  promptSnippet?: string,        // One-line for system prompt
  promptGuidelines?: string[],   // Guidelines for system prompt
  renderResult?: (result) => string  // For TUI rendering
}
```

### Bash Operations Abstraction
```
createLocalBashOperations({shellPath}) [tools/bash.ts]
        │
        └── execute(command, cwd, options) → {output, exitCode, cancelled}

Used by: AgentSession.executeBash(), extensions via context.exec()
```

---

## 6. How Prompts Are Generated

### System Prompt Construction (`core/system-prompt.ts`)
```
buildSystemPrompt(options)
        │
        ├── customPrompt? → Use custom + appendSystemPrompt + contextFiles + skills
        │
        └── Default prompt:
                ├── Tool list (filtered by selectedTools with promptSnippets)
                ├── Guidelines (tool-specific + universal + extension)
                ├── Pi documentation references
                ├── appendSystemPrompt
                ├── Project context files (AGENTS.md, CLAUDE.md)
                ├── Skills (if read tool available)
                └── Current working directory
```

### Prompt Assembly Per Turn (`AgentSession._rebuildSystemPrompt`)
```
_rebuildSystemPrompt(toolNames)
        │
        ├── Valid tool names → toolSnippets + promptGuidelines
        │
        ├── ResourceLoader.getSystemPrompt() (customPrompt from extensions/settings)
        │
        ├── ResourceLoader.getAppendSystemPrompt() (extension appends)
        │
        ├── ResourceLoader.getSkills() → formatSkillsForPrompt()
        │
        ├── ResourceLoader.getAgentsFiles() → context files
        │
        └── buildSystemPrompt({
              cwd, skills, contextFiles, customPrompt, appendSystemPrompt,
              selectedTools, toolSnippets, promptGuidelines
          })
```

### User Prompt Processing (`AgentSession.prompt`)
```
prompt(text, options)
        │
        ├── expandPromptTemplates? → /skill:name + /template expansion
        │
        ├── Extension input event → can transform/handle
        │
        ├── Streaming? → steer() or followUp() queue
        │
        ├── Model/API key validation
        │
        ├── Pre-compaction check (last assistant message)
        │
        ├── Build messages: [custom messages from before_agent_start, user message, pending nextTurn]
        │
        ├── Extension before_agent_start → inject custom messages, override systemPrompt
        │
        └── _runAgentPrompt(messages) → Agent loop
```

### Prompt Templates (`core/prompt-templates.ts`)
```
expandPromptTemplate(text, templates)
        │
        ├── Matches: /templateName args
        │
        ├── Template file: frontmatter (name, description, argumentHint) + body
        │
        └── Replaces {args} placeholder in body
```

---

## 7. How Configuration Is Loaded

### Settings Manager (`core/settings-manager.ts`)
```
SettingsManager.create(cwd, agentDir, {projectTrusted})
        │
        ├── FileSettingsStorage
        │   ├── Global: ~/.pi/agent/settings.json
        │   └── Project: <cwd>/.pi/settings.json
        │
        ├── deepMergeSettings(global, project) → effective settings
        │
        ├── Migration (migrateSettings)
        │   ├── queueMode → steeringMode
        │   ├── websockets → transport
        │   ├── skills object → array
        │   └── retry.maxDelayMs → provider.maxRetryDelayMs
        │
        ├── Locking (proper-lockfile) for concurrent writes
        │
        ├── Modified field tracking (session-only persistence)
        │
        └── Error collection (parse errors, trust state changes)
```

### Settings Categories
| Category | Keys | Scope |
|----------|------|-------|
| **Model** | defaultProvider, defaultModel, defaultThinkingLevel | Global |
| **Session** | sessionDir, steeringMode, followUpMode | Global |
| **UI** | theme, showHardwareCursor, clearOnShrink, editorPaddingX, autocompleteMaxVisible, outputPad, hideThinkingBlock | Global |
| **Tools** | shellCommandPrefix, shellPath, imageAutoResize, blockImages | Global |
| **Network** | httpProxy, httpIdleTimeoutMs, websocketConnectTimeoutMs, transport | Global |
| **Compaction** | enabled, thresholdPercent, minTokens, keepTurns | Global |
| **Retry** | enabled, maxRetries, baseDelayMs, provider.* | Global |
| **Extensions** | flags (extension-registered) | Global |
| **Project** | Any above + trust-dependent resources | Project (trusted only) |

### Resource Loader Configuration (`core/resource-loader.ts`)
```
DefaultResourceLoader(options)
        │
        ├── cwd, agentDir, settingsManager
        │
        ├── additional*Paths (CLI --extensions, --skills, --prompt-templates, --themes)
        │
        ├── extensionFactories (SDK inline extensions)
        │
        ├── no* flags (--no-extensions, --no-skills, etc.)
        │
        ├── systemPrompt / appendSystemPrompt (CLI --system-prompt, --append-system-prompt)
        │
        ├── Override functions (extensionsOverride, skillsOverride, etc.)
        │
        └── reload(options)
                ├── resolveProjectTrust callback (for project trust gating)
                ├── PackageManager.resolve() → npm/git packages
                ├── loadExtensionsCached() → jiti + cache
                ├── loadSkills/loadPromptTemplates/loadThemes
                ├── Context files (AGENTS.md, CLAUDE.md) discovery
                └── Source info mapping for autocomplete
```

---

## 8. Existing Abstractions Worth Keeping

| Abstraction | Location | Why Keep |
|-------------|----------|----------|
| **AgentSession** | `core/agent-session.ts` | Central orchestration, event bus, session persistence, extension integration - clean separation from UI |
| **ExtensionRunner** | `core/extensions/runner.ts` | Event dispatch, context API, tool wrapping, command/shortcut/flag registration - stable extension interface |
| **ResourceLoader** | `core/resource-loader.ts` | Unified loading of extensions, skills, prompts, themes, context files with source tracking |
| **ModelRuntime** | `core/model-runtime.ts` | Provider composition (builtin + config + extensions), auth management, streaming abstraction |
| **SettingsManager** | `core/settings-manager.ts` | Global/project merge, file locking, migration, modified tracking - robust config system |
| **SessionManager** | `core/session-manager.ts` | JSONL tree structure (v3), compaction/branch entries, atomic writes, session discovery |
| **Tool Definition Wrapper** | `core/extensions/wrapper.ts` | Adapts extension tools to agent-core interface with context injection |
| **Compaction System** | `core/compaction/` | Token estimation, summarization, auto-threshold, extension hooks |
| **System Prompt Builder** | `core/system-prompt.ts` | Tool-aware, context-aware, extensible prompt construction |
| **Mode Separation** | `modes/` | Interactive/Print/RPC share AgentSession, only differ in I/O layer |
| **SDK (createAgentSession)** | `core/sdk.ts` | Public API for embedding, testing, custom frontends |

---

## 9. Architectural Pain Points

### 1. **God Class: AgentSession (3332 lines)**
- Handles: prompting, tools, models, compaction, retry, bash, extensions, persistence, queues
- Violates Single Responsibility Principle
- Hard to test in isolation
- High coupling between unrelated concerns

### 2. **Tight Coupling: InteractiveMode ↔ AgentSession**
- InteractiveMode directly accesses: `session.agent`, `session.state`, `session.extensionRunner`
- 32 components in `modes/interactive/components/` tightly bound to session internals
- TUI rendering logic mixed with business logic

### 3. **Extension System Complexity**
- Multiple entry points: loader, runner, wrapper, types
- Event types scattered (54 event interfaces in types.ts, ~25 emitted from AgentSession)
- Context API (`createContext`) exposes 30+ methods - large surface area
- Stale context invalidation via string message - fragile

### 4. **Configuration Sprawl**
- SettingsManager: 109 getter/setter methods
- ResourceLoader: 15+ constructor options
- ModelRuntime: provider composition + config + credentials + catalog
- No unified config schema/validation

### 5. **Tool System Fragmentation**
- Builtin tools in `core/tools/`
- Extension tools via `ExtensionRunner.registerTool`
- SDK custom tools via `createAgentSession({customTools})`
- Tool wrapping in `extensions/wrapper.ts`
- Active tool management in `AgentSession._refreshToolRegistry`
- Prompt snippets/guidelines in separate Maps

### 6. **Async Initialization Order Issues**
- Main.ts creates services → session → runtime → mode
- Project trust resolution requires async extension loading
- Model refresh races with session creation
- Theme watcher started before TUI init

### 7. **Event System Inconsistency**
- Agent-core events → AgentSession._handleAgentEvent → ExtensionRunner.emit → UI listeners
- Some events emitted synchronously, others awaited
- No event ordering guarantees
- Extension handlers can mutate agent state mid-event

### 8. **No Capability Framework**
- Tools, commands, prompts, themes, skills all have separate registration
- No unified "capability" abstraction
- Extensions register via multiple APIs (registerTool, registerCommand, registerFlag, etc.)
- Runtime capability discovery requires introspecting multiple registries

---

## 10. Components That Would Conflict With a Future Capability Framework

| Component | Conflict Reason |
|-----------|-----------------|
| **AgentSession._refreshToolRegistry()** | Hardcoded tool merging logic (builtin + extension + SDK), filter by allowed/excluded, wraps with extension hooks - would need capability-based tool resolution |
| **ExtensionRunner.registerTool/registerCommand/registerFlag/registerShortcut** | Separate registration methods per capability type - capability framework needs unified registration |
| **ResourceLoader.loadExtensionsCached + loadSkills/loadPromptTemplates/loadThemes** | Separate loading pipelines per resource type - capability framework needs unified discovery |
| **Tool prompt snippets/guidelines Maps** | `_toolPromptSnippets`, `_toolPromptGuidelines` maintained separately from tool registry - capability metadata should be co-located |
| **ExtensionRunner.getAllRegisteredTools/getCommand/getMessageRenderer** | Per-type lookup methods - capability framework needs generic capability query |
| **System prompt builder (buildSystemPrompt)** | Directly iterates tool snippets/guidelines Maps - should query capability registry |
| **InteractiveMode.createBaseAutocompleteProvider** | Manually combines builtin commands, templates, extension commands, skills - capability framework should provide unified autocomplete |
| **AgentSession.bindExtensions** | Binds 30+ methods to extension context - capability framework needs structured capability exposure |
| **SessionManager entry types** | Hardcoded: message, custom_message, compaction, branch_summary, bashExecution, thinking_level_change, model_change, session_info - capability framework may need extensible entry types |
| **Mode-specific bindExtensions** | Interactive/Print/RPC each pass different context actions - capability framework needs mode-agnostic capability exposure |

---

## Summary

The current architecture is **functional but organically grown**. The `AgentSession` class (3332 lines) has become a central monolith that coordinates all subsystems. The extension system is powerful but fragmented across multiple registration APIs. The mode separation (interactive/print/rpc) is clean at the top level but leaks through `bindExtensions` context differences.

**Key refactoring targets for a capability framework:**
1. Extract `CapabilityRegistry` from tool/command/prompt/theme/skill registrations
2. Decompose `AgentSession` into focused services (PromptService, ToolService, ModelService, CompactionService)
3. Unify extension registration under a single `registerCapability()` API
4. Make `InteractiveMode` a pure consumer of capabilities via well-defined interfaces
5. Replace ad-hoc event emission with a typed event bus per capability domain

The existing abstractions (SettingsManager, ModelRuntime, SessionManager, ResourceLoader, ExtensionRunner) provide a solid foundation but need to be reorganized around a capability-centric model rather than the current type-centric model.