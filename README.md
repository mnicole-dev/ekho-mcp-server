# `@mnicole-dev/ekho-mcp-server`

MCP server for the [Ekho](https://ekho.ovh) API — manage support tickets and read place data straight from Claude, Cursor, or any other MCP client.

## What's in the box

| Tool                | What it does                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| **Tickets**         |                                                                              |
| `tickets.list`      | List tickets with optional `status`, `priority`, `category` filters + pages. |
| `tickets.view`      | Full ticket detail incl. all comments.                                       |
| `tickets.comment`   | Post a public comment (notifies the original reporter).                      |
| `tickets.setStatus` | Move a ticket to `open` or `in_progress`. Closure is via GitHub (see below). |
| **Places**          |                                                                              |
| `places.list`       | Paginated list — filter by `search`, `quartier`, or `missingCoords`.         |
| `places.search`     | Convenience wrapper around `places.list` with a `query` parameter.           |
| `places.view`       | Full details (incl. `directionsUrl` for the mobile "Itinéraire" button).     |
| `places.updateCoords` | Update a place's GPS coordinates. **Admin role required.**                |
| `places.history`    | Your own visit history, newest first.                                        |
| **Check-in**        |                                                                              |
| `checkin.current`   | Where are *you* currently checked in?                                        |
| `checkin.byUser`    | Where is user `<id>` currently checked in?                                   |

> **Why no `tickets.close` ?** Closing a ticket is delegated to the GitHub webhook (issue #143): closing the linked GH issue auto-closes the Ekho ticket and notifies the creator. The MCP intentionally refuses to compete with that.

> **v1.1 (this version)** added `places.list`, `places.search` and `places.updateCoords` once [mnicole-dev/ekho#153](https://github.com/mnicole-dev/ekho/issues/153) landed.

## Requirements

- Node.js 18+
- An Ekho personal API key — generate one at `/admin/api-tokens` on your Ekho instance ([feature shipped in mnicole-dev/ekho#151](https://github.com/mnicole-dev/ekho/issues/151)). The token inherits your user's permissions.

## Configuration

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "ekho": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mnicole-dev/ekho-mcp-server"],
      "env": {
        "EKHO_API_KEY": "ekho_pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

Same structure as above.

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "ekho": {
      "command": "npx",
      "args": ["-y", "@mnicole-dev/ekho-mcp-server"],
      "env": {
        "EKHO_API_KEY": "ekho_pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Environment variables

| Var            | Default            | Notes                                                    |
| -------------- | ------------------ | -------------------------------------------------------- |
| `EKHO_API_KEY` | **required**       | Personal API key generated in the Ekho admin.            |
| `EKHO_API_URL` | `https://ekho.ovh` | Override for staging or local dev (`http://localhost:8000`). |

## Usage examples

Once configured, from your MCP client:

> *« Liste les tickets ouverts en priorité critique »*

> *« Vue détaillée du ticket #65, puis commente que je suis en train de regarder. »*

> *« Quel est mon dernier lieu visité ? »*

## Development

```bash
git clone https://github.com/mnicole-dev/ekho-mcp-server.git
cd ekho-mcp-server
pnpm install
EKHO_API_KEY=ekho_pk_xxx pnpm dev   # runs the server in stdio mode
pnpm build                          # builds dist/
```

## License

MIT
