# wa-ff-ops-be

Read-only WhatsApp history API and worker. The frontend is maintained separately in `wa-ff-ops`.

## Runtime

Run this service on one persistent Node.js instance with Chrome/Puppeteer support and persistent storage for the linked WhatsApp session. Do not use Firebase Hosting static hosting or a scale-to-zero/serverless deployment for the worker. The OCC/PHP proxy must validate the user's session and superadmin role before forwarding requests to this API.

## Local setup

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and set the server-side Supabase URL/key, OCC shared secret, and worker callback secret. Never commit `.env` or expose secrets in browser code.
3. Set `WA_HISTORY_AUTH_PATH` to private persistent storage. It contains the linked WhatsApp session.
4. Install dependencies: `npm install`. Puppeteer may need its compatible Chrome installed: `npx puppeteer browsers install chrome`.
5. Start development: `npm run dev`. For production, run `npm run build` then `npm start`.
6. Connect an authorized WhatsApp account via `POST /api/wa/connect`. Retrieve and scan the QR through the protected status API. Only run one worker instance.

## Environment variables

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Server-only Supabase key; `SUPABASE_SERVICE_ROLE_KEY` is accepted as a legacy alternative |
| `OCC_BACKEND_SHARED_SECRET` | Shared secret between the authenticated OCC proxy and this backend |
| `WA_HISTORY_CALLBACK_SECRET` | Secret used by the internal worker sync endpoint |
| `WA_HISTORY_AUTH_PATH` | Persistent private directory for WhatsApp session files |
| `PUPPETEER_EXECUTABLE_PATH` | Optional path to a compatible installed Chrome |
| `WA_SYNC_INTERVAL_MS` | Automatic sync interval |
| `WA_SYNC_MESSAGES_PER_CHAT` | Maximum recent messages read from each direct chat per sync |
| `WA_SYNC_MAX_CHATS` | Maximum direct chats scanned per sync |
| `PORT` | HTTP port |

Do not configure `NEXT_PUBLIC_*` secrets. Do not copy `.env` contents into Firebase Hosting or commit them to GitHub.

## Protected API

All OCC routes require `x-occ-backend-secret`. The internal sync route requires `x-wa-worker-secret`.

| Method | Route |
| --- | --- |
| GET | `/api/wa/status` |
| POST | `/api/wa/connect` |
| POST | `/api/wa/disconnect` |
| POST | `/api/wa/sync` |
| GET | `/api/wa/conversations?limit=50&offset=0&q=phone-or-name` |
| GET | `/api/wa/conversations/:id/messages?limit=50&offset=0&q=text` |
| GET | `/api/wa/messages?limit=50&offset=0&q=text` |
| GET | `/api/wa/messages/export?q=text&conversationId=<uuid>` |
| POST | `/api/internal/wa/sync` |

Message search matches body and external ID. Excel exports include all matches up to 10,000 rows. This service does not include send/reply routes. Group chats and media files are not imported; non-text messages have a metadata/body placeholder.

## Security and deployment

- Keep this API on a private server network or behind a TLS reverse proxy with strict access controls.
- The browser must never receive the Supabase key, OCC shared secret, or worker callback secret.
- Put a same-origin authenticated PHP proxy in front of this API. Validate the OCC session and `role_id = 1`; do not trust browser-supplied role IDs.
- Persist and protect the WhatsApp auth directory. Ensure only one worker runs because the supplied schema has no unique external-message constraint.
- Firebase Hosting in the `wa-ff-ops` repository serves the separate static frontend only. It does not run this API or the WhatsApp worker.

The WhatsApp Web library is unofficial and may change behavior or be restricted by WhatsApp. Use only accounts you are authorized to link.
