#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env['EKHO_API_URL'] ?? 'https://ekho.ovh';

function getApiKey(): string {
  const key = process.env['EKHO_API_KEY'];
  if (!key) {
    throw new Error(
      'EKHO_API_KEY environment variable is required. Generate one at /admin/api-tokens on your Ekho instance.',
    );
  }
  return key;
}

async function apiFetch(
  path: string,
  options?: RequestInit & { params?: Record<string, string | number | boolean | undefined> },
): Promise<Response> {
  let url = `${API_BASE}${path}`;
  if (options?.params) {
    const qs = new URLSearchParams(
      Object.entries(options.params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    if (qs) url += `?${qs}`;
  }
  const { params: _params, ...fetchOptions } = options ?? {};
  return fetch(url, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(fetchOptions.headers ?? {}),
    },
  });
}

async function assertOk(resp: Response, action: string): Promise<unknown> {
  if (resp.ok) {
    // Some endpoints (DELETE) return 204 No Content.
    if (resp.status === 204) return null;
    return resp.json();
  }
  const body = await resp.text();
  throw new Error(`${action} failed (${resp.status}): ${body.slice(0, 500)}`);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function md(...lines: string[]): string {
  return lines.filter((l) => l !== undefined).join('\n');
}

// API Platform's JSON-LD wraps collections under `hydra:member` / `member`
// and items under regular keys. Smooth over that here.
function unwrapCollection(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.['hydra:member'])) return payload['hydra:member'];
  if (Array.isArray(payload?.member)) return payload.member;
  return [];
}

const server = new McpServer({ name: 'ekho-mcp-server', version: '1.4.0' });

// ── Tickets ─────────────────────────────────────────────────────────────

server.tool(
  'tickets.list',
  'List support tickets (paginated). Filter by status (open, in_progress, resolved, closed), priority, or category.',
  {
    status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
    priority: z.string().optional().describe('e.g. critical, high, medium, low'),
    category: z.string().optional().describe('e.g. bug, improvement, other'),
    page: z.number().int().min(1).default(1).optional(),
    itemsPerPage: z.number().int().min(1).max(100).default(20).optional(),
  },
  async (params) => {
    const resp = await apiFetch('/api/tickets', {
      params: {
        status: params.status,
        priority: params.priority,
        category: params.category,
        page: params.page,
        itemsPerPage: params.itemsPerPage,
      },
    });
    const payload = await assertOk(resp, 'tickets.list');
    const tickets = unwrapCollection(payload);

    if (tickets.length === 0) {
      return textResult('No tickets matched these filters.');
    }
    const lines = [
      `**${tickets.length} ticket(s) returned**`,
      '',
      ...tickets.map((t: any) => {
        const head = `- **#${t.id}** [${t.status}] *${t.priority ?? '—'}* — ${t.title}`;
        const meta = `  github: ${t.githubIssueId ?? '—'} | created: ${t.createdAt ?? '—'}`;
        return `${head}\n${meta}`;
      }),
    ];
    return textResult(lines.join('\n'));
  },
);

server.tool(
  'tickets.view',
  'Show the full content of a ticket — title, description, status, dates, and recent comments.',
  { id: z.number().int().positive() },
  async ({ id }) => {
    const resp = await apiFetch(`/api/tickets/${id}`);
    const t: any = await assertOk(resp, `tickets.view(${id})`);

    const comments = Array.isArray(t.comments) ? t.comments : [];
    const commentLines =
      comments.length === 0
        ? '_no comments_'
        : comments
            .slice()
            .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .map(
              (c: any) =>
                `- **#${c.id}** (${c.createdAt ?? '—'})${c.isAdminComment ? ' [admin]' : ''}: ${c.content}`,
            )
            .join('\n');

    return textResult(
      md(
        `# Ticket #${t.id} — ${t.title}`,
        '',
        `**Status:** ${t.status}   **Priority:** ${t.priority ?? '—'}   **Category:** ${t.category ?? '—'}`,
        `**Created:** ${t.createdAt ?? '—'}   **Updated:** ${t.updatedAt ?? '—'}   **Closed:** ${t.closedAt ?? '—'}`,
        `**GitHub:** issue ${t.githubIssueId ?? '—'} (status: ${t.githubStatus ?? '—'})`,
        '',
        '## Description',
        t.description ?? '_(empty)_',
        '',
        '## Comments',
        commentLines,
      ),
    );
  },
);

server.tool(
  'tickets.comment',
  'Post a comment on a ticket. The original ticket creator is notified through Ekho\'s existing follower-notification handler.',
  {
    id: z.number().int().positive(),
    content: z.string().min(2),
  },
  async ({ id, content }) => {
    const resp = await apiFetch(`/api/tickets/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    const c: any = await assertOk(resp, `tickets.comment(${id})`);
    return textResult(
      md(
        `✓ Comment **#${c.id ?? '?'}** posted on ticket **#${id}** at ${c.createdAt ?? 'now'}.`,
        '',
        '> ' + content.split('\n').join('\n> '),
      ),
    );
  },
);

server.tool(
  'tickets.create',
  'Open a new support ticket. Required: title (5-255 chars) and description (10+ chars). priority defaults to "medium", category to "other". Note: tickets created via this MCP (admin API key) do NOT trigger the GitHub issue webhook — they remain Ekho-internal unless an issue is opened manually.',
  {
    title: z.string().min(5).max(255),
    description: z.string().min(10),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    category: z.enum(['bug', 'improvement', 'question', 'other']).optional(),
  },
  async ({ title, description, priority, category }) => {
    const body: Record<string, unknown> = { title, description };
    if (priority !== undefined) body['priority'] = priority;
    if (category !== undefined) body['category'] = category;
    const resp = await apiFetch('/api/tickets', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const t: any = await assertOk(resp, 'tickets.create');
    return textResult(
      md(
        `✓ Ticket **#${t.id}** créé — **${t.title}**`,
        '',
        `**Status:** ${t.status}   **Priority:** ${t.priority}   **Category:** ${t.category}`,
        `**Created:** ${t.createdAt ?? 'now'}`,
      ),
    );
  },
);

server.tool(
  'tickets.setStatus',
  'Change a ticket workflow status. Only "open" or "in_progress" are accepted — closure goes through the GitHub webhook (closing the linked issue auto-closes the ticket).',
  {
    id: z.number().int().positive(),
    status: z.enum(['open', 'in_progress']),
  },
  async ({ id, status }) => {
    const resp = await apiFetch(`/api/tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    const t: any = await assertOk(resp, `tickets.setStatus(${id})`);
    return textResult(`✓ Ticket **#${id}** is now **${t.status ?? status}** (updated at ${t.updatedAt ?? 'now'}).`);
  },
);

// ── Places ──────────────────────────────────────────────────────────────

server.tool(
  'places.list',
  'List places (compact). Filter by `search` (LIKE on name/address), `quartier` slug, or `missingCoords` (true → only places without GPS coords, useful for data cleanup).',
  {
    search: z.string().optional(),
    quartier: z
      .string()
      .optional()
      .describe(
        'Quartier slug, e.g. vieux_port, la_plaine, cours_julien, endoume, ndm, baille, castellane, baille_castellane, camas',
      ),
    missingCoords: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
    offset: z.number().int().min(0).default(0).optional(),
  },
  async ({ search, quartier, missingCoords, limit, offset }) => {
    const resp = await apiFetch('/api/places', {
      params: { search, quartier, missing_coords: missingCoords, limit, offset },
    });
    const payload: any = await assertOk(resp, 'places.list');
    const places = Array.isArray(payload?.places) ? payload.places : [];
    if (places.length === 0) return textResult('No places matched these filters.');
    return textResult(
      [
        `**${payload.count} place(s)** (limit=${payload.limit}, offset=${payload.offset})`,
        '',
        ...places.map((p: any) => {
          const coords =
            p.latitude === null || p.longitude === null ? '⚠️ no coords' : `${p.latitude}, ${p.longitude}`;
          return `- **#${p.id}** *${p.name}* (${p.quartier ?? '—'}) — ${coords} — ${p.address ?? 'no address'}`;
        }),
      ].join('\n'),
    );
  },
);

server.tool(
  'places.search',
  'Convenience wrapper: search places by name/address. Equivalent to places.list with a search filter.',
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20).optional(),
  },
  async ({ query, limit }) => {
    const resp = await apiFetch('/api/places', { params: { search: query, limit } });
    const payload: any = await assertOk(resp, `places.search("${query}")`);
    const places = Array.isArray(payload?.places) ? payload.places : [];
    if (places.length === 0) return textResult(`No places matching "${query}".`);
    return textResult(
      [
        `**${payload.count} place(s) matching "${query}"**`,
        '',
        ...places.map((p: any) => `- **#${p.id}** *${p.name}* — ${p.address ?? '—'}`),
      ].join('\n'),
    );
  },
);

server.tool(
  'places.create',
  'Create a new place (stub). Required: name (1-255 chars), quartier slug, address. Optional: latitude/longitude (must come together, WGS84 bounds), typeTagId (PlaceTag PK). The admin completes rich data (opening hours, ambiance, activities, etc.) via /admin/places/{id}/edit afterward. Admin role only. Rejects duplicates with the same name in the same quartier (409).',
  {
    name: z.string().min(1).max(255),
    quartier: z
      .enum(['vieux_port', 'endoume', 'cours_julien', 'ndm', 'la_plaine', 'baille', 'castellane', 'baille_castellane', 'camas'])
      .describe('Quartier slug — see Quartier enum on the backend'),
    address: z.string().min(1),
    latitude: z.number().gte(-90).lte(90).optional(),
    longitude: z.number().gte(-180).lte(180).optional(),
    typeTagId: z.number().int().positive().optional(),
  },
  async ({ name, quartier, address, latitude, longitude, typeTagId }) => {
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new Error('places.create: latitude and longitude must be provided together (or both omitted).');
    }
    const body: Record<string, unknown> = { name, quartier, address };
    if (latitude !== undefined) body['latitude'] = latitude;
    if (longitude !== undefined) body['longitude'] = longitude;
    if (typeTagId !== undefined) body['typeTagId'] = typeTagId;

    const resp = await apiFetch('/api/places', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const payload: any = await assertOk(resp, 'places.create');
    const p = payload?.place ?? {};
    const coords =
      p.latitude !== undefined && p.latitude !== null
        ? `\`${p.latitude}, ${p.longitude}\``
        : '⚠️ no coords';
    return textResult(
      md(
        `✓ Place **#${p.id}** créée — **${p.title ?? name}**`,
        '',
        `**Quartier:** ${p.district ?? quartier}   **Address:** ${p.address ?? address}`,
        `**Coords:** ${coords}`,
      ),
    );
  },
);

server.tool(
  'places.updateCoords',
  'Update the GPS coordinates of a place. Both latitude and longitude are required. Admin role only.',
  {
    id: z.number().int().positive(),
    latitude: z.number().gte(-90).lte(90),
    longitude: z.number().gte(-180).lte(180),
  },
  async ({ id, latitude, longitude }) => {
    const resp = await apiFetch(`/api/places/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ latitude, longitude }),
    });
    const payload: any = await assertOk(resp, `places.updateCoords(${id})`);
    const p = payload?.place ?? {};
    return textResult(
      `✓ Place **#${id}** updated — now at \`${p.latitude}, ${p.longitude}\` (${p.title ?? p.name ?? ''}).`,
    );
  },
);

// ── Encounters (admin-only utilities) ──────────────────────────────────

server.tool(
  'resonances.force',
  'Force-create a résonance between two users at a place, bypassing the mutual-discovery requirement. Admin only. Idempotent: returns the existing résonance if one already links the two users. Pushes the Mercure event + FCM notification to both users, useful for QA-testing the notification pipeline without two physical phones present at the same place.',
  {
    userAId: z.number().int().positive(),
    userBId: z.number().int().positive(),
    placeId: z.number().int().positive(),
  },
  async ({ userAId, userBId, placeId }) => {
    if (userAId === userBId) {
      throw new Error('resonances.force: userAId and userBId must differ.');
    }
    const resp = await apiFetch('/api/admin/resonances/force', {
      method: 'POST',
      body: JSON.stringify({ userAId, userBId, placeId }),
    });
    const payload: any = await assertOk(resp, 'resonances.force');
    const r = payload?.resonance ?? {};
    return textResult(
      md(
        `✓ Résonance **#${r.id}** créée — users **#${r.userAId} ↔ #${r.userBId}** au lieu **#${r.placeId}**.`,
        '',
        `**Resonated at:** ${r.resonatedAt ?? 'now'}`,
        '',
        '_Notifications Mercure + FCM envoyées aux 2 users._',
      ),
    );
  },
);

server.tool(
  'places.view',
  'Show full details of a place by id — name, type, district, coordinates, address, partner status, image URLs, and direction links.',
  { id: z.number().int().positive() },
  async ({ id }) => {
    const resp = await apiFetch(`/api/places/${id}`);
    const payload: any = await assertOk(resp, `places.view(${id})`);
    const p = payload?.place ?? payload;
    return textResult(
      md(
        `# Place #${p.id} — ${p.title ?? p.name ?? '(unnamed)'}`,
        '',
        `**Type:** ${p.type ?? '—'}   **District:** ${p.district ?? p.quartier ?? '—'}`,
        `**Coordinates:** ${p.latitude ?? '∅'}, ${p.longitude ?? '∅'}`,
        `**Address:** ${p.address ?? '—'}`,
        `**Partner:** ${p.isPartner ? 'yes' : 'no'}`,
        p.directionsUrl ? `**Directions:** ${p.directionsUrl}` : '',
        p.referenceGoogleMaps ? `**Google Maps ref:** ${p.referenceGoogleMaps}` : '',
        Array.isArray(p.imageUrls) && p.imageUrls.length
          ? '**Images:** ' + p.imageUrls.join(', ')
          : '',
      ),
    );
  },
);

server.tool(
  'places.history',
  'Visit history for the authenticated user (the owner of the API key). Newest first.',
  {
    limit: z.number().int().min(1).max(100).default(20).optional(),
    offset: z.number().int().min(0).default(0).optional(),
  },
  async ({ limit, offset }) => {
    const resp = await apiFetch('/api/places/history', { params: { limit, offset } });
    const payload: any = await assertOk(resp, 'places.history');
    const visits = Array.isArray(payload?.history) ? payload.history : [];
    if (visits.length === 0) {
      return textResult('No visits yet for this user.');
    }
    return textResult(
      [
        `**${payload.count} visit(s)** (limit=${payload.limit}, offset=${payload.offset})`,
        '',
        ...visits.map(
          (v: any) =>
            `- **${v.placeName ?? '(unknown)'}** (place #${v.placeId}) — checked in ${v.checkedInAt}` +
            (v.checkedOutAt ? `, left ${v.checkedOutAt}` : ' *(active)*'),
        ),
      ].join('\n'),
    );
  },
);

// ── Check-in status (issue #134) ────────────────────────────────────────

server.tool(
  'checkin.current',
  'Where is the authenticated user (the API-key owner) currently checked in, if anywhere?',
  {},
  async () => {
    const resp = await apiFetch('/api/checkin/current');
    const s: any = await assertOk(resp, 'checkin.current');
    if (!s.checkedIn) return textResult('Not currently checked in anywhere.');
    return textResult(
      `Checked in at **${s.place?.name ?? '(unknown)'}** (place #${s.place?.id}) since ${s.checkedInAt}.`,
    );
  },
);

server.tool(
  'checkin.byUser',
  'Is user X currently checked in somewhere? Pass the target user id.',
  { userId: z.number().int().positive() },
  async ({ userId }) => {
    const resp = await apiFetch(`/api/checkin/${userId}`);
    const s: any = await assertOk(resp, `checkin.byUser(${userId})`);
    if (!s.checkedIn) return textResult(`User #${userId} is not currently checked in anywhere.`);
    return textResult(
      `User #${userId} is checked in at **${s.place?.name ?? '(unknown)'}** (place #${s.place?.id}) since ${s.checkedInAt}.`,
    );
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
