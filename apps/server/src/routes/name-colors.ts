import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  createNameColorSchema,
  updateNameColorSchema,
  type NameColorListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import {
  deleteNameColor,
  findNameColor,
  insertNameColor,
  listNameColors,
  listUserIdsWithNameColor,
  nextNameColorPosition,
  toNameColor,
  updateNameColor,
  type NameColorRow,
} from '../db/name_colors.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface NameColorRouteDeps {
  db: Database;
  hub: GatewayHub;
}

/**
 * The palette members pick their username color from, and the administrator's
 * controls over it. It grants nothing: a member's pick only changes how their
 * name is drawn, and a colored role they hold still wins.
 */
export function registerNameColorRoutes(app: FastifyInstance, deps: NameColorRouteDeps): void {
  const { db, hub } = deps;

  function requireRow(id: string): NameColorRow {
    const row = findNameColor(db.sqlite, id);
    if (!row) throw new HttpError(404, 'name_color_not_found', 'That color does not exist.');
    return row;
  }

  function list(): NameColorListResponse {
    return { nameColors: listNameColors(db.sqlite).map(toNameColor) };
  }

  /**
   * A palette change alters the names of everyone who picked an affected entry,
   * so those members are announced and their clients refetch them.
   */
  function announce(userIds: string[]): void {
    for (const userId of userIds) hub.dispatch(GatewayEvent.MemberUpdate, { userId });
  }

  app.get('/api/v1/name-colors', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    return list();
  });

  app.post('/api/v1/name-colors', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(createNameColorSchema, request.body);
    const id = randomUUID();
    insertNameColor(db.sqlite, {
      id,
      color: input.color,
      label: input.label ? input.label : null,
      position: nextNameColorPosition(db.sqlite),
      createdAt: new Date().toISOString(),
    });
    return toNameColor(requireRow(id));
  });

  app.patch('/api/v1/name-colors/:id', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const { id } = request.params as { id: string };
    requireRow(id);
    const input = parseBody(updateNameColorSchema, request.body);
    updateNameColor(db.sqlite, id, {
      color: input.color,
      // Left undefined nothing changes; empty clears the label, as `null` does.
      label: input.label === undefined ? undefined : input.label ? input.label : null,
    });
    announce(listUserIdsWithNameColor(db.sqlite, id));
    return toNameColor(requireRow(id));
  });

  app.delete('/api/v1/name-colors/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageServer);
    const { id } = request.params as { id: string };
    requireRow(id);
    // Read the members before the delete: the reference is cleared by the foreign
    // key as the row goes, so afterwards there is nothing left to find.
    const affected = listUserIdsWithNameColor(db.sqlite, id);
    deleteNameColor(db.sqlite, id);
    announce(affected);
    return reply.status(204).send();
  });
}
