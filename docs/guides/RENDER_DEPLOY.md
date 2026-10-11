# Deploying OmniRoute on Render

This guide covers running OmniRoute on [Render](https://render.com) as a web
service and, in particular, **adding OAuth providers (Antigravity, `agy`, …)
from a phone** against a remote host — the case where the OAuth callback must
reach the public origin instead of `localhost`.

> Not a local install? Every credential and setting lives in a SQLite database
> under `DATA_DIR`. On Render the container filesystem is **ephemeral** — a
> redeploy wipes it. See [Persistent disk](#2-persistent-disk-required).

---

## 1. Create the web service

Render builds from a repo branch or a Docker image. OmniRoute ships a
`Dockerfile`, so the simplest path is:

| Setting       | Value                                                                |
| ------------- | -------------------------------------------------------------------- |
| Runtime       | Docker                                                               |
| Branch        | `release/vX.Y.Z` (or your own fork's default branch)                 |
| Instance type | **Starter or higher** — see [Free tier limits](#7-free-tier-caveats) |
| Health check  | `/api/monitoring/health`                                             |

If you prefer a native Node service (no Docker), use:

| Setting   | Value                     |
| --------- | ------------------------- |
| Build cmd | `npm ci && npm run build` |
| Start cmd | `npm start`               |

`PORT` is read from the environment (`bin/cli/api.mjs`), so Render's dynamic
port assignment works without configuration. Do **not** use `npm run
build:release` on Render — it invokes `rm -rf` and `$(git rev-parse)` inline,
which fail in a non-bash shell.

---

## 2. Persistent disk (required)

SQLite holds every provider connection, API key and setting. Without a disk
mounted, **each deploy erases the providers you just added**.

1. Render dashboard → your service → **Disks** → **Add Disk**
2. Mount path: `/var/data`
3. Size: 1 GB is enough to start

Then set:

```bash
DATA_DIR=/var/data
```

Confirm it took effect — the SQLite file must live under the mount:

```bash
# in the Render shell
ls -la /var/data/*.sqlite
```

---

## 3. Environment variables

### Required

```bash
# Generate once and keep — changing these invalidates sessions/encrypted data.
JWT_SECRET=<openssl rand -base64 48>
API_KEY_SECRET=<openssl rand -hex 32>

# First-boot admin password — change after the first login.
INITIAL_PASSWORD=<a strong password>
```

### Public origin

```bash
OMNIROUTE_PUBLIC_BASE_URL=https://<your-service>.onrender.com
```

This is the one that matters for OAuth. It is read at **runtime** by the
server, so you can set it from the dashboard and redeploy — no rebuild.

> **Do not rely on `NEXT_PUBLIC_BASE_URL` for this.** `.env.example` ships it as
> `http://localhost:20128`. OmniRoute now ignores a localhost value there when a
> real public origin is available, but `OMNIROUTE_PUBLIC_BASE_URL` is the
> correct variable for a hosted deployment. `NEXT_PUBLIC_*` variables are also
> inlined at **build** time, so changing them requires a rebuild.

### Optional

```bash
APP_LOG_LEVEL=info
REQUIRE_API_KEY=true   # require an API key on /v1 routes
```

---

## 4. Adding Antigravity (or `agy`) from your phone

The OAuth modal builds a `redirect_uri`. Out of the box it is loopback
(`http://127.0.0.1:<port>/callback`), because the Google credentials embedded in
the binary are registered upstream as a **native/desktop** OAuth app — Google
only accepts loopback redirects for those, and you cannot register a Render URL
against someone else's client.

To authorize from a phone you therefore need **your own** Google OAuth client.

### 4.1 Create the OAuth client

1. [Google Cloud Console](https://console.cloud.google.com) → new project
2. Configure the OAuth consent screen
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. Application type: **Web application**
5. Authorized redirect URI:

   ```bash
   https://<your-service>.onrender.com/callback
   ```

   The `/callback` path is fixed — `src/app/callback/page.tsx` handles it, and a
   regression test (`tests/unit/oauth-callback-path-doc.test.ts`) guards it.

### 4.2 Set them on Render

```bash
ANTIGRAVITY_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
ANTIGRAVITY_OAUTH_CLIENT_SECRET=<your-client-secret>
OMNIROUTE_PUBLIC_BASE_URL=https://<your-service>.onrender.com
```

Redeploy. `ANTIGRAVITY_OAUTH_CLIENT_TYPE` is **not** required — older docs listed
it as a gate, but it never controlled the redirect upgrade.

### 4.3 Connect from the dashboard

1. Open `https://<your-service>.onrender.com` on your phone
2. Providers → Antigravity → Connect
3. Complete the Google consent screen
4. OmniRoute shows a **manual paste** step — the modal intentionally switches to
   it whenever the dashboard is not on true-localhost
   (`src/shared/components/OAuthModal.tsx`). Copy the full URL from the phone's
   address bar and paste it back into the modal.

> **If the consent screen hangs with no redirect:** Google is trying to reach a
> loopback address. Confirm `OMNIROUTE_PUBLIC_BASE_URL` is set to your real
> `https://` origin and that the client ID is genuinely yours (not the embedded
> default). Verify what the server actually resolved:
>
> ```bash
> curl -s "https://<your-service>.onrender.com/api/oauth/antigravity/authorize?redirect_uri=http://127.0.0.1:20128/callback" | jq .authUrl
> ```
>
> The `redirect_uri` inside `authUrl` must contain your Render hostname.

### 4.4 Alternative: no Google Cloud Console work

From a laptop **with a browser**, register the remote host as a context first:

```bash
omniroute connect https://<your-service>.onrender.com
npx omniroute login antigravity
```

The OAuth completes locally against loopback and the finished credential is
pushed to the connected remote instance. Useful flags:

| Flag               | Effect                                                     |
| ------------------ | ---------------------------------------------------------- |
| `--no-browser`     | Print the URL instead of opening a browser                 |
| `--port <n>`       | Fixed loopback port (default: OS-assigned)                 |
| `--timeout <ms>`   | How long to wait for the callback (default: 300000)        |
| `--no-push`        | Always print the credential blob, never contact the server |
| `--context <name>` | Push to a specific context instead of the active one       |

If the push cannot reach the server, `--no-push` prints a single-line credential
blob you paste into the dashboard via **Antigravity → Paste credentials**.

Use this path if the custom Google scopes are rejected — see
[Troubleshooting](#6-troubleshooting).

---

## 5. Which OAuth providers work remotely

| Provider                     | Remote / public origin | Notes                                                                     |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| **antigravity**, **agy**     | ✅ with custom client  | Needs your own Google OAuth client (above)                                |
| Standard auth-code providers | ✅                     | `state` lives in the browser, so it survives replicas                     |
| codex, xai-oauth, grok-cli   | ⚠️ manual              | Fixed loopback ports (1455 / 56121 / 56122) baked into their OAuth apps   |
| Device-code flows            | ⚠️ single replica only | Tickets are held in process memory (`src/lib/oauth/deviceFlowTickets.ts`) |

Keep **one instance** unless you have verified a provider's state is
replica-safe — device-flow and PKCE callback-server state is in-memory.

---

## 6. Troubleshooting

| Symptom                                          | Cause / fix                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Providers vanish after a deploy                  | No persistent disk — mount one at `/var/data` and set `DATA_DIR=/var/data`                               |
| OAuth consent hangs, no redirect                 | `redirect_uri` is loopback → set `OMNIROUTE_PUBLIC_BASE_URL` and use a custom OAuth client               |
| `redirect_uris_mismatch` from Google             | Exact string mismatch — the registered URI must equal the resolved one, including scheme and any subpath |
| Callback page loads but the modal never advances | Paste the callback URL manually — expected on remote hosts                                               |
| Google rejects the requested scopes              | `auth/cclog` / `auth/experimentsandconfigs` are Code Assist scopes → use `npx omniroute login`           |
| Instance sleeps mid-flow (free tier)             | Hibernation kills in-flight OAuth → use a paid instance                                                  |
| Service restarts lose DB writes                  | `DATA_DIR` not on the mounted disk                                                                       |

---

## 7. Free tier caveats

Render's free instance hibernates after ~15 minutes idle and its filesystem is
ephemeral. That breaks OAuth flows (the instance can sleep mid-consent) and
loses data. **Use a paid instance for anything beyond a trial.**

---

## See also

- [`ANTIGRAVITY-ONBOARDING.md`](./ANTIGRAVITY-ONBOARDING.md) — project onboarding and scopes
- [`DOCKER_GUIDE.md`](./DOCKER_GUIDE.md) — image build and runtime options
- [`REMOTE-MODE.md`](./REMOTE-MODE.md) — exposing OmniRoute beyond localhost
- [`../ops/TUNNELS_GUIDE.md`](../ops/TUNNELS_GUIDE.md) — tunnels and reverse proxies
