/**
 * @earendil-works/pi-platform/kernel
 *
 * Walking-skeleton implementation of the capability platform runtime.
 *
 * This subpath contains runtime behavior — intentionally the first in the
 * platform package. The contract subpaths (/, /capability, /runtime, /service,
 * /event, /error, /identifier, /schema) remain implementation-free.
 *
 * Implemented (minimal):
 * - KernelRuntime (orchestration: initialize / start / shutdown)
 * - KernelCapabilityRegistry (registration, query, exports, contexts)
 * - BuiltinCapabilityDiscovery (static builtin list)
 * - SimpleCapabilityResolver (dependency existence + initialization order)
 * - BuiltinCapabilityLoader (factory loading)
 * - KernelLifecycleManager (dependency-aware init, reverse-order shutdown)
 * - KernelServiceProvider (FileSystemService + ProcessService + not-implemented stubs)
 * - KernelEventBus (emit / subscribe / unsubscribe)
 */

export { type BuiltinCapability, BuiltinCapabilityDiscovery } from "./discovery.ts";
export { KernelEventBus } from "./event-bus.ts";
export {
	EVENT_ERROR,
	EVENT_INITIALIZED,
	EVENT_READY,
	EVENT_REGISTERED,
	EVENT_SHUTDOWN,
	EVENT_UNREGISTERED,
	errorEvent,
	initializedEvent,
	readyEvent,
	registeredEvent,
	shutdownEvent,
	unregisteredEvent,
} from "./events.ts";
export { NodeFileSystemService } from "./fs-service.ts";
export {
	KernelLifecycleManager,
	type KernelLifecycleManagerOptions,
} from "./lifecycle.ts";
export { BuiltinCapabilityLoader } from "./loader.ts";
export { NodeProcessService } from "./process-service.ts";
export {
	KernelCapabilityRegistry,
	type KernelRegistry,
} from "./registry.ts";
export { SimpleCapabilityResolver } from "./resolver.ts";
export { createRuntime, KernelRuntime, type KernelRuntimeOptions } from "./runtime.ts";
export {
	KernelServiceProvider,
	type KernelServiceProviderOptions,
} from "./service-provider.ts";
