import type { RegisteredCommand, RegisteredCommandListResponse } from '@harmony/shared';
import { api } from './api';

/**
 * The slash commands bots offer, as the server sees them for the signed-in member:
 * both permission gates are already applied server-side, so this is exactly what
 * this member may invoke. Liveness is not here — the composer overlays the live
 * roster, so a command whose bot has gone offline drops out without a refetch.
 */
class Commands {
  list = $state<RegisteredCommand[]>([]);

  async load(): Promise<void> {
    try {
      this.list = (await api<RegisteredCommandListResponse>('/commands')).commands;
    } catch {
      // Signed out or offline: keep whatever we already have.
    }
  }

  reset(): void {
    this.list = [];
  }

  /** The registered commands a typed name matches, in registry order. */
  named(name: string): RegisteredCommand[] {
    return this.list.filter((command) => command.name === name);
  }
}

export const commands = new Commands();
