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

const server = new McpServer({ name: 'ekho-mcp-server', version: '1.0.0' });

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
  'places.view',
  'Show full details of a place by id — name, type, district, coordinates, address, partner status, image URLs.',
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
