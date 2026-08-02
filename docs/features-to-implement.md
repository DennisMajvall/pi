Based on our previous Pi discussions and the architecture documents you've already produced, I'd prioritize the next major features like this:

1. **Capability Platform** _(already in progress)_ ✅
   - Contracts
   - Runtime kernel
   - Gradual migration of built-in functionality

2. **Planning** ✅ _(designed)_

3. **Workspaces / Git Worktrees** ✅ _(designed)_

4. **Memory** ✅ _(designed)_
   - Conversation memory
   - Project memory
   - Codebase memory
   - Knowledge extraction
   - Reflection
   - Retrieval
   - Maintenance (merge/forget/summarize)

5. **Event System** ✅ _(designed)_
   - Canonical event model
   - Publish/subscribe
   - Background subscribers
   - Correlation/context propagation
   - Eventually event persistence

6. **Background Jobs / Workers** ✅ _(designed)_
   - Queue
   - Scheduling
   - Long-running tasks
   - Retry/cancellation
   - Used by memory, indexing, reflection, planning, etc.

7. **Task / Execution Engine**
   - Execute approved plans
   - Dependency graph
   - Parallel execution
   - Progress tracking
   - Resume/retry
   - Human approval checkpoints

8. **Subagents**
   - Spawn specialized agents
   - Context slicing
   - Delegation depth
   - Result aggregation
   - Parallel execution

9. **Workspace Context & Indexing**
   - Repository indexing
   - Symbol graph
   - Semantic search
   - File watching
   - Incremental updates

10. **Context Assembly**
    - Automatically gather only relevant context
    - Planning context
    - Execution context
    - Memory retrieval
    - Workspace state
    - Token budgeting

11. **Approval Framework**
    - Human validation
    - Plan approval
    - Step approval
    - Risk-based approvals
    - Permission escalation

12. **Observability**
    - Event viewer
    - Timeline
    - Task graph
    - Agent traces
    - Cost/tokens
    - Performance metrics

13. **Capability Marketplace**
    - Install/update/remove capabilities
    - Versioning
    - Dependency management
    - Trust model

14. **Policies / Rules**
    - User policies
    - Workspace policies
    - Safety constraints
    - Execution permissions
    - Organizational rules

15. **Reflection**
    - Post-task analysis
    - Learn from successes/failures
    - Generate reusable knowledge
    - Feed Memory

16. **Knowledge Management**
    - Long-term knowledge base
    - Structured facts
    - Generated documentation
    - Cross-project knowledge

17. **Automation / Triggers**
    - Scheduled jobs
    - File-change triggers
    - Git hooks
    - Conversation-finished hooks
    - Event-driven automations

18. **Multi-Agent Collaboration**
    - Shared state
    - Shared event bus
    - Shared plans
    - Shared memory
    - Conflict resolution

---

If I compress these into the **foundational roadmap**, I'd reduce it to:

1. Capability Platform
2. Planning
3. Workspaces
4. Event System
5. Background Workers
6. Memory
7. Task Execution Engine
8. Subagents
9. Context Assembly
10. Workspace Indexing
11. Approval Framework
12. Observability

Everything else builds naturally on top of those. This ordering also aligns with the architecture you've been evolving: first establish the execution substrate (capabilities, events, workers), then intelligence (memory, planning, context), then autonomy (execution, subagents), and finally ecosystem and operations.
