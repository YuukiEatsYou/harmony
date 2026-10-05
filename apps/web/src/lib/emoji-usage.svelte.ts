import { emojis } from './emojis.svelte';
import {
  emojiInContent,
  parseUsage,
  recordUsage,
  resolveUsage,
  scoreMap,
  type UsageEntry,
  type UsedEmoji,
} from './emoji-usage';
import { session } from './session.svelte';

const KEY_PREFIX = 'harmony:emoji-usage:';

/**
 * The emoji this member uses most, kept in this browser. Storage can be
 * unavailable (private windows, blocked site data), so every access is guarded
 * and a copy is held in memory for the session either way.
 */
class EmojiUsageState {
  /** Bumped on every change, so the derived entries re-read. */
  #version = $state(0);
  #memory = new Map<string, UsageEntry[]>();

  constructor() {
    try {
      window.addEventListener('storage', (event) => {
        if (event.key?.startsWith(KEY_PREFIX)) this.#version++;
      });
    } catch {
      // No window to listen on; nothing to sync.
    }
  }

  entries = $derived.by((): UsageEntry[] => {
    void this.#version;
    const userId = session.user?.id;
    if (!userId) return [];
    try {
      const raw = localStorage.getItem(KEY_PREFIX + userId);
      if (raw !== null) return parseUsage(raw);
    } catch {
      // Fall through to the in-memory copy.
    }
    return this.#memory.get(userId) ?? [];
  });

  /** Frequently used emoji, best first, with deleted custom emoji dropped. */
  ranked = $derived(resolveUsage(this.entries, new Map(emojis.picker.map((emoji) => [emoji.id, emoji])), Date.now()));

  /** Score by emoji identity (custom id or unicode character); unused emoji are absent. */
  scores = $derived(scoreMap(this.entries, Date.now()));

  record(used: readonly UsedEmoji[]): void {
    const userId = session.user?.id;
    if (!userId || used.length === 0) return;
    const next = recordUsage(this.entries, used, Date.now());
    this.#memory.set(userId, next);
    try {
      localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(next));
    } catch {
      // Memory still holds it for this session.
    }
    this.#version++;
  }

  /** Records every emoji in a message that was just sent. */
  recordContent(content: string): void {
    this.record(emojiInContent(content, emojis.lookup));
  }
}

export const emojiUsage = new EmojiUsageState();
