import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@mowbot/contract';

/** In-process fan-out of server events to WebSocket subscribers. */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
