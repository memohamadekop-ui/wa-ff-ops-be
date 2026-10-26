# wa-ff-ops-be

Read-only WhatsApp history API and worker. The static frontend is maintained separately in `wa-ff-ops`.

## Runtime and setup

Run one instance on Cloud Run or another Node.js host with Chrome/Puppeteer support. Firebase Hosting serves the static frontend and rewrites `/api/**` to this service; it cannot run this worker. Cloud Run's local filesystem is ephemeral, so use Filestore/NFS for the linked WhatsApp session in production.

1. Use Node.js 20 or later.
2. Copy `.env.example` to `.env`. Configure the server-only Supabase URL/key, `WA_AUTH_TOKEN_SECRET`, exact frontend origins, and independent OCC/worker secrets. Never commit `.env`.
3. Ensure Supabase `tb_user` is readable with the server-side key and stores Laravel-compatible bcrypt hashes. Login accepts only `role_id = 1`.
4. Set `WA_HISTORY_AUTH_PATH` to persistent private storage.
5. Install with `npm install`; install Chrome if needed with `npx puppeteer browsers install chrome`.
6. Start with `npm run dev`, or build and run with `npm run build` and `npm start`. Keep one worker instance running.

Generate `WA_AUTH_TOKEN_SECRET` with a secure random generator on the backend host. Do not send it to the frontend or chat.

## Deploy to Cloud Run with Firebase Hosting

The Firebase Hosting rewrite in the separate frontend repository targets service `wa-ff-ops-be` in `asia-southeast1`. Enable billing for the Google Cloud/Firebase project and deploy the service before deploying Hosting.

1. Create a Cloud Run service account and grant it access to the required Secret Manager secrets. Create these secrets before deployment: `supabase-key`, `wa-auth-token-secret`, `occ-backend-secret`, and `wa-history-callback-secret`. Store the same values you use in the corresponding `.env` variables; never put secret values in the Docker image or frontend.
2. From this repository in Cloud Shell, deploy with:

   ```sh
   gcloud run deploy wa-ff-ops-be \
     --source . \
     --region asia-southeast1 \
     --allow-unauthenticated \
     --min 1 \
     --max 1 \
     --cpu 2 \
     --memory 4Gi \
     --no-cpu-throttling \
     --set-env-vars="^@^SUPABASE_URL=https://YOUR_PROJECT.supabase.co@WA_HISTORY_ALLOWED_ORIGINS=https://ff-ops-wa-be.web.app,https://ff-ops-wa-be.firebaseapp.com@WA_HISTORY_AUTH_PATH=/mnt/whatsapp-auth@WA_SYNC_INTERVAL_MS=300000@WA_SYNC_MESSAGES_PER_CHAT=100@WA_SYNC_MAX_CHATS=500" \
     --set-secrets="SUPABASE_KEY=supabase-key:latest,WA_AUTH_TOKEN_SECRET=wa-auth-token-secret:latest,OCC_BACKEND_SHARED_SECRET=occ-backend-secret:latest,WA_HISTORY_CALLBACK_SECRET=wa-history-callback-secret:latest"
   ```

   Replace `YOUR_PROJECT` with the Supabase project ID and use the actual Firebase Hosting origins. Set the active Google Cloud project to your Firebase project's ID before deploying. If the Cloud Run service name or region differs, update the `serviceId`/`region` in the frontend repository's `firebase.json`. The service must allow unauthenticated invocation for Firebase Hosting's server-side rewrite; API routes still enforce application authentication.
3. For persistent WhatsApp login, create a Filestore NFS share reachable from Cloud Run through a configured VPC. Mount it at `/mnt/whatsapp-auth`; Cloud Run supports NFS volumes with `--add-volume=name=whatsapp-auth,type=nfs,location=FILESTORE_IP:/SHARE_PATH` and `--add-volume-mount=volume=whatsapp-auth,mount-path=/mnt/whatsapp-auth`. Configure the service VPC/network according to the Filestore setup and ensure the share is writable by the container's `node` user (UID 1000). Do not rely on the container's writable filesystem to preserve the QR session.
4. In Firebase Console, find the project ID under **Project settings → General**. Deploy Firebase Hosting from the separate frontend repository, selecting that project with `firebase use FIREBASE_PROJECT_ID`, then run its production build and `firebase deploy --only hosting`. Confirm that repository's `firebase.json` rewrites `/api/**` to `wa-ff-ops-be` in `asia-southeast1`. The frontend defaults to same-origin `/api` requests, which use the rewrite.

The initial deployment command does not configure a Filestore network; complete step 3 before treating the WhatsApp session as persistent. `--min 1` and `--no-cpu-throttling` keep the worker alive and incur ongoing Cloud Run charges. Keep Cloud Run at one instance because the schema does not enforce uniqueness for external message IDs.

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
