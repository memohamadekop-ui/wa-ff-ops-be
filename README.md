# wa-ff-ops-be

Read-only WhatsApp history API and worker. The static frontend is maintained separately in `wa-ff-ops`.

## Runtime and setup

Run one instance on a persistent Node.js host with Chrome/Puppeteer support and persistent private storage for the linked WhatsApp session. Firebase Hosting can host the static frontend, but not this worker.

1. Use Node.js 20 or later.
2. Copy `.env.example` to `.env`. Configure the server-only Supabase URL/key, `WA_AUTH_TOKEN_SECRET`, exact frontend origins, and independent OCC/worker secrets. Never commit `.env`.
3. Ensure Supabase `tb_user` is readable with the server-side key and stores Laravel-compatible bcrypt hashes. Login accepts only `role_id = 1`.
4. Set `WA_HISTORY_AUTH_PATH` to persistent private storage.
5. Install with `npm install`; install Chrome if needed with `npx puppeteer browsers install chrome`.
6. Start with `npm run dev`, or build and run with `npm run build` and `npm start`. Keep one worker instance running.

Generate `WA_AUTH_TOKEN_SECRET` with a secure random generator on the backend host. Do not send it to the frontend or chat.

## Environment

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Server-only key; legacy `SUPABASE_SERVICE_ROLE_KEY` is also accepted |
| `WA_AUTH_TOKEN_SECRET` | Independent server-only signing key (minimum 32 bytes) for one-hour login sessions |
| `OCC_BACKEND_SHARED_SECRET` | Optional server-to-server OCC authentication |
| `WA_HISTORY_CALLBACK_SECRET` | Internal worker sync authentication |
| `WA_HISTORY_ALLOWED_ORIGINS` | Exact comma-separated browser origins; no wildcard |
| `WA_HISTORY_AUTH_PATH` | Persistent private WhatsApp session directory |
| `PUPPETEER_EXECUTABLE_PATH` | Optional compatible Chrome executable |
| `WA_SYNC_INTERVAL_MS` | Automatic sync interval |
| `WA_SYNC_MESSAGES_PER_CHAT` | Recent messages read per direct chat |
| `WA_SYNC_MAX_CHATS` | Maximum direct chats scanned per sync |
| `PORT` | HTTP port |

## Authentication

`POST /api/auth/login` accepts email/password over HTTPS. The backend queries `tb_user`, compares the password with bcrypt (including Laravel `$2y$` hashes), and requires `role_id = 1`. It returns a one-hour HMAC-signed bearer token. The frontend keeps this token in session storage; passwords and Supabase keys are never bundled into the frontend. Login attempts are rate-limited.

The WhatsApp API accepts the signed bearer token or the server-side OCC shared secret. The internal sync endpoint still requires `x-wa-worker-secret`. CORS is restricted to `WA_HISTORY_ALLOWED_ORIGINS`.

| Method | Route |
| --- | --- |
| POST | `/api/auth/login` |
| GET | `/api/wa/status` |
| POST | `/api/wa/connect` |
| POST | `/api/wa/disconnect` |
| POST | `/api/wa/sync` |
| GET | `/api/wa/conversations?limit=50&offset=0&q=phone-or-name` |
| GET | `/api/wa/conversations/:id/messages?limit=50&offset=0&q=text` |
| GET | `/api/wa/messages?limit=50&offset=0&q=text` |
| GET | `/api/wa/messages/export?q=text&conversationId=<uuid>` |
| POST | `/api/internal/wa/sync` |

Message search matches body and external ID. Excel exports include up to 10,000 matching rows. The API does not provide send/reply operations.

## Security and operations

- Serve the API only over HTTPS.
- Never expose the Supabase key, OCC secret, worker secret, or session signing key to browser code.
- Keep the WhatsApp auth directory private and persistent.
- Run exactly one worker because the supplied schema has no unique constraint for external message IDs.
- Do not log passwords, login request bodies, WhatsApp QR data, or message contents.
- The WhatsApp Web library is unofficial and may change behavior or be restricted by WhatsApp. Use only accounts you are authorized to link.
