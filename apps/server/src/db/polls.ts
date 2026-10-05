import type { DatabaseSync } from 'node:sqlite';
import type { Poll, PollSource } from '@harmony/shared';

export interface PollRow {
  id: string;
  message_id: string;
  question: string;
  allow_multiple: number;
  closes_at: string | null;
  closed_at: string | null;
  source: string;
  created_at: string;
}

export interface PollOptionRow {
  id: string;
  poll_id: string;
  position: number;
  text: string;
  emoji: string | null;
  discord_answer_id: number | null;
}

export interface NewPoll {
  id: string;
  messageId: string;
  question: string;
  allowMultiple: boolean;
  closesAt: string | null;
  source: PollSource;
  createdAt: string;
  options: Array<{ id: string; text: string; emoji: string | null; discordAnswerId?: number | null }>;
}

/** Stores a poll and its options. The caller creates the message first. */
export function insertPoll(sqlite: DatabaseSync, input: NewPoll): void {
  sqlite
    .prepare(
      `INSERT INTO polls (id, message_id, question, allow_multiple, closes_at, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.messageId, input.question, input.allowMultiple ? 1 : 0, input.closesAt, input.source, input.createdAt);
  const insertOption = sqlite.prepare(
    `INSERT INTO poll_options (id, poll_id, position, text, emoji, discord_answer_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  input.options.forEach((option, position) => {
    insertOption.run(option.id, input.id, position, option.text, option.emoji, option.discordAnswerId ?? null);
  });
}

export function findPollByMessage(sqlite: DatabaseSync, messageId: string): PollRow | null {
  return (sqlite.prepare('SELECT * FROM polls WHERE message_id = ?').get(messageId) as PollRow | undefined) ?? null;
}

export function listPollOptions(sqlite: DatabaseSync, pollId: string): PollOptionRow[] {
  return sqlite
    .prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position')
    .all(pollId) as unknown as PollOptionRow[];
}

export function setOptionDiscordAnswerId(sqlite: DatabaseSync, optionId: string, answerId: number): void {
  sqlite.prepare('UPDATE poll_options SET discord_answer_id = ? WHERE id = ?').run(answerId, optionId);
}

/**
 * The polls on a page of messages, keyed by message id, as `viewerId` sees them.
 * Three queries however long the page: the polls with their options, the count
 * per option, and the distinct voters per poll.
 */
export function loadPollsForMessages(
  sqlite: DatabaseSync,
  messageIds: string[],
  viewerId: string,
): Map<string, Poll> {
  const result = new Map<string, Poll>();
  if (messageIds.length === 0) return result;

  const marks = messageIds.map(() => '?').join(', ');
  const polls = sqlite
    .prepare(`SELECT * FROM polls WHERE message_id IN (${marks})`)
    .all(...messageIds) as unknown as PollRow[];
  if (polls.length === 0) return result;

  const pollIds = polls.map((poll) => poll.id);
  const pollMarks = pollIds.map(() => '?').join(', ');

  const options = sqlite
    .prepare(`SELECT * FROM poll_options WHERE poll_id IN (${pollMarks}) ORDER BY poll_id, position`)
    .all(...pollIds) as unknown as PollOptionRow[];

  const counts = new Map<string, number>();
  const mine = new Set<string>();
  const votes = sqlite
    .prepare(
      `SELECT option_id, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
         FROM poll_votes WHERE poll_id IN (${pollMarks}) GROUP BY option_id`,
    )
    .all(viewerId, ...pollIds) as unknown as Array<{ option_id: string; count: number; me: number }>;
  for (const vote of votes) {
    counts.set(vote.option_id, vote.count);
    if (vote.me === 1) mine.add(vote.option_id);
  }

  const voters = new Map<string, number>();
  const totals = sqlite
    .prepare(`SELECT poll_id, COUNT(DISTINCT user_id) AS count FROM poll_votes WHERE poll_id IN (${pollMarks}) GROUP BY poll_id`)
    .all(...pollIds) as unknown as Array<{ poll_id: string; count: number }>;
  for (const total of totals) voters.set(total.poll_id, total.count);

  const optionsByPoll = new Map<string, PollOptionRow[]>();
  for (const option of options) {
    const list = optionsByPoll.get(option.poll_id) ?? [];
    list.push(option);
    optionsByPoll.set(option.poll_id, list);
  }

  for (const poll of polls) {
    const rows = optionsByPoll.get(poll.id) ?? [];
    result.set(poll.message_id, {
      messageId: poll.message_id,
      question: poll.question,
      allowMultiple: poll.allow_multiple === 1,
      closesAt: poll.closes_at,
      closedAt: poll.closed_at,
      source: poll.source === 'discord' ? 'discord' : 'harmony',
      options: rows.map((row) => ({
        id: row.id,
        text: row.text,
        emoji: row.emoji,
        count: counts.get(row.id) ?? 0,
      })),
      totalVoters: voters.get(poll.id) ?? 0,
      myVotes: rows.filter((row) => mine.has(row.id)).map((row) => row.id),
    });
  }
  return result;
}

/** The option ids one member has chosen in a poll. */
export function listVotesOf(sqlite: DatabaseSync, pollId: string, userId: string): string[] {
  const rows = sqlite
    .prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?')
    .all(pollId, userId) as unknown as Array<{ option_id: string }>;
  return rows.map((row) => row.option_id);
}

/**
 * Replaces a member's whole choice in one poll. The rows they no longer hold
 * go, the new ones arrive, and one they keep stays as it was (so its time does).
 */
export function replaceVotes(
  sqlite: DatabaseSync,
  pollId: string,
  userId: string,
  optionIds: string[],
  votedAt: string,
): void {
  sqlite.exec('BEGIN');
  try {
    const keep = new Set(optionIds);
    for (const held of listVotesOf(sqlite, pollId, userId)) {
      if (!keep.has(held)) sqlite.prepare('DELETE FROM poll_votes WHERE option_id = ? AND user_id = ?').run(held, userId);
    }
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO poll_votes (poll_id, option_id, user_id, voted_at) VALUES (?, ?, ?, ?)',
    );
    for (const optionId of optionIds) insert.run(pollId, optionId, userId, votedAt);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Adds one vote, ignoring a repeat. True when a row was added. */
export function insertVote(sqlite: DatabaseSync, pollId: string, optionId: string, userId: string, votedAt: string): boolean {
  const result = sqlite
    .prepare('INSERT OR IGNORE INTO poll_votes (poll_id, option_id, user_id, voted_at) VALUES (?, ?, ?, ?)')
    .run(pollId, optionId, userId, votedAt);
  return Number(result.changes) > 0;
}

/** Removes one vote. True when a row was removed. */
export function deleteVote(sqlite: DatabaseSync, optionId: string, userId: string): boolean {
  const result = sqlite.prepare('DELETE FROM poll_votes WHERE option_id = ? AND user_id = ?').run(optionId, userId);
  return Number(result.changes) > 0;
}

/** Everyone who chose one option, earliest vote first. */
export function listVoters(
  sqlite: DatabaseSync,
  optionId: string,
  limit: number,
): Array<{ userId: string; votedAt: string }> {
  const rows = sqlite
    .prepare('SELECT user_id, voted_at FROM poll_votes WHERE option_id = ? ORDER BY voted_at, user_id LIMIT ?')
    .all(optionId, limit) as unknown as Array<{ user_id: string; voted_at: string }>;
  return rows.map((row) => ({ userId: row.user_id, votedAt: row.voted_at }));
}

/** Closes a poll. False when it was already closed. */
export function closePoll(sqlite: DatabaseSync, pollId: string, closedAt: string): boolean {
  const result = sqlite.prepare('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(closedAt, pollId);
  return Number(result.changes) > 0;
}

/** Polls still open whose time is up, for the sweep that closes them. */
export function listExpiredOpenPolls(sqlite: DatabaseSync, now: string): PollRow[] {
  return sqlite
    .prepare('SELECT * FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= ?')
    .all(now) as unknown as PollRow[];
}
