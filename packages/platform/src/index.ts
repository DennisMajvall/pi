/**
 * @earendil-works/pi-platform
 *
 * Capability platform contracts for pi.
 *
 * This package contains ONLY shared contracts:
 * - interfaces, types, branded identifiers
 * - enums, TypeBox schemas, constants
 * - documentation comments
 *
 * ZERO RUNTIME BEHAVIOR.
 * No implementations, no dependency injection, no event bus, no registry.
 *
 * Existing code must NOT depend on these contracts yet.
 * They are the foundation for future capability platform refactor.
 */

// Capability contracts
export * from "./capability/index.ts";
// Error contracts
export * from "./error/index.ts";
// Event contracts
export * from "./event/index.ts";
// Identifier contracts
export * from "./identifier/index.ts";
// Plan contracts (planning domain). NOTE: exposed via the `/plan` subpath
// only, not the root — the root would collide with the pre-existing
// orchestration `Plan` ({ steps }) in ./capability/index.ts.
// export * from "./plan/index.ts";
// Runtime contracts
export * from "./runtime/index.ts";
// Schema contracts
export * from "./schema/index.ts";
// Service contracts
export * from "./service/index.ts";
