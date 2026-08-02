/**
 * Walking-skeleton event bus.
 *
 * Implements only emit / subscribe / unsubscribe with synchronous, ordered
 * delivery. No replay, persistence, history, priorities, queues, async
 * dispatch, or distributed events. The Step 1.2 event model is unchanged;
 * only this implementation is intentionally minimal.
 */

import { PlatformError } from "../error/index.ts";
import type { EventBusStats, PlatformEvent, SubscribeOptions } from "../event/index.ts";
import type { EventBusService, EventHandler } from "../service/index.ts";

/** A registered subscription. `eventType === undefined` matches all events. */
interface Subscription {
	eventType: string | undefined;
	handler: EventHandler<PlatformEvent>;
	filter: ((event: PlatformEvent) => boolean) | undefined;
}

export class KernelEventBus implements EventBusService {
	private subscriptions: Subscription[] = [];
	private emittedCount = 0;

	async emit<T extends PlatformEvent>(event: T): Promise<void> {
		this.emittedCount++;
		for (const subscription of this.subscriptions) {
			if (subscription.eventType !== undefined && subscription.eventType !== event.type) {
				continue;
			}
			if (subscription.filter && !subscription.filter(event)) {
				continue;
			}
			// Synchronous delivery: await each handler in subscription order.
			await subscription.handler(event);
		}
	}

	async emitSync<T extends PlatformEvent>(event: T): Promise<void> {
		return this.emit(event);
	}

	subscribe<T extends PlatformEvent>(
		eventType: T["type"],
		handler: EventHandler<T>,
		options?: SubscribeOptions,
	): () => void {
		return this.addSubscription(eventType, handler as EventHandler<PlatformEvent>, options);
	}

	subscribeAll(handler: EventHandler<PlatformEvent>, options?: SubscribeOptions): () => void {
		return this.addSubscription(undefined, handler, options);
	}

	async getHistory(_eventType?: string, _since?: number): Promise<PlatformEvent[]> {
		return [];
	}

	async clearHistory(): Promise<void> {
		// No history is retained in the walking-skeleton bus.
	}

	async stats(): Promise<EventBusStats> {
		return {
			totalEvents: this.emittedCount,
			eventsByType: {},
			activeSubscriptions: this.subscriptions.length,
			historySize: 0,
		};
	}

	private addSubscription(
		eventType: string | undefined,
		handler: EventHandler<PlatformEvent>,
		options?: SubscribeOptions,
	): () => void {
		if (options?.replay) {
			throw new PlatformError("Event replay is not implemented in the walking-skeleton event bus", {
				code: "NOT_IMPLEMENTED",
			});
		}
		const subscription: Subscription = {
			eventType,
			handler,
			filter: options?.filter,
		};
		this.subscriptions.push(subscription);
		return () => {
			this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription);
		};
	}
}
