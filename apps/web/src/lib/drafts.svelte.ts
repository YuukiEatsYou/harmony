import type { Attachment } from '@harmony/shared';

/** What a member has started writing in one channel and not sent yet. */
export interface Draft {
  text: string;
  attachments: Attachment[];
}

const storageKey = 'harmony.drafts';
const empty: Draft = Object.freeze({ text: '', attachments: [] }) as Draft;

/**
 * Draft texts saved earlier in this tab. Storage can be missing or refuse access
 * (private windows, blocked site data), in which case drafts simply live in memory.
 */
function readStored(): Record<string, Draft> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const drafts: Record<string, Draft> = {};
    for (const [key, text] of Object.entries(parsed)) {
      if (typeof text === 'string' && text.length > 0) drafts[key] = { text, attachments: [] };
    }
    return drafts;
  } catch {
    return {};
  }
}

/**
 * Unsent messages, one per channel, so switching channels never carries what was
 * being written into the wrong one. Keys are chosen by the caller; the composer
 * uses the member and the channel together, so two accounts sharing a tab do not
 * see each other's drafts.
 *
 * Only the text survives a reload. Attachments are uploads that were never sent,
 * which the server may prune at any time, so they stay in memory.
 */
class Drafts {
  #byKey = $state<Record<string, Draft>>(readStored());

  get(key: string | null): Draft {
    return (key !== null ? this.#byKey[key] : undefined) ?? empty;
  }

  set(key: string | null, draft: Draft): void {
    if (key === null) return;
    if (draft.text.length === 0 && draft.attachments.length === 0) {
      delete this.#byKey[key];
    } else {
      this.#byKey[key] = draft;
    }
    this.#persist();
  }

  setText(key: string | null, text: string): void {
    this.set(key, { ...this.get(key), text });
  }

  setAttachments(key: string | null, attachments: Attachment[]): void {
    this.set(key, { ...this.get(key), attachments });
  }

  clear(key: string | null): void {
    this.set(key, empty);
  }

  #persist(): void {
    const texts: Record<string, string> = {};
    for (const [key, draft] of Object.entries(this.#byKey)) {
      if (draft.text.length > 0) texts[key] = draft.text;
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(texts));
    } catch {
      // Full or blocked storage only costs the draft surviving a reload.
    }
  }
}

export const drafts = new Drafts();
