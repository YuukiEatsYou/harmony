import type { AccountType } from './types.ts';

/**
 * The file formats a channel export comes in. JSON is for other tools to read;
 * HTML is a standalone page for a person to read, with no scripts in it.
 */
export type ChannelExportFormat = 'json' | 'html';

export const CHANNEL_EXPORT_FORMATS: readonly ChannelExportFormat[] = ['json', 'html'];

/**
 * Who wrote an exported message. Names are copied in rather than referenced, so
 * the file still reads correctly once it has left the server.
 */
export interface ChannelExportAuthor {
  id: string;
  username: string;
  displayName: string | null;
  accountType: AccountType;
}

export interface ChannelExportAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Where the file can be fetched from this server; it still needs a session. */
  url: string;
  /** The link it was copied from, when it came from one rather than an upload. */
  sourceUrl: string | null;
}

export interface ChannelExportMessage {
  id: string;
  /** Null once the author's account is gone. */
  author: ChannelExportAuthor | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  /** The message this one replies to, with just enough to recognise it. */
  replyTo: { id: string; authorName: string | null; deleted: boolean } | null;
  attachments: ChannelExportAttachment[];
  stickers: Array<{ id: string; name: string }>;
  reactions: Array<{ emoji: string; emojiId: string | null; count: number }>;
}

/**
 * The whole JSON export. Messages are oldest first, and deleted messages are
 * left out, matching what the channel itself shows.
 */
export interface ChannelExport {
  format: 1;
  exportedAt: string;
  serverName: string;
  channel: { id: string; name: string; topic: string | null };
  messages: ChannelExportMessage[];
}
