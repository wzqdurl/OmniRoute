/**
 * Regression tests: remote (Render / proxy / tunnel) OAuth callback resolution.
 *
 * Two real defects made `OMNIROUTE_PUBLIC_BASE_URL` unusable on remote
 * deployments, which broke the Google OAuth providers (antigravity/agy) from
 * any host that is not localhost:
 *
 * 1. PRECEDENCE — `resolveBrowserOAuthRedirectUri()` picked the public base URL
 *    with `NEXT_PUBLIC_BASE_URL || OMNIROUTE_PUBLIC_BASE_URL`. `.env.example`
 *    ships `NEXT_PUBLIC_BASE_URL=http://localhost:20128`, so on a remote host
 *    that value is truthy and short-circuits the `||`: the server-side override
 *    is never read and the redirect stays on `http://localhost:20128/callback`,
 *    which is unreachable from a phone. The browser already guards against this
 *    exact placeholder (`OAuthModal.tsx` ignores a `localhost` publicUrl); the
 *    server resolver must do the same and fall back to
 *    `OMNIROUTE_PUBLIC_BASE_URL`.
 *
 * 2. `ANTIGRAVITY_OAUTH_CLIENT_TYPE=web` was documented as required for the
 *    loopback -> public upgrade, but the branch that read it performed exactly
 *    the same work as the code that follows it, so setting it changed nothing.
 *    The upgrade must work for ANY custom Google client type. These tests pin
 *    that contract so a future refactor cannot silently reintroduce the gate.
 *
 * All tests run fully offline — no network calls, no database.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { resolveBrowserOAuthRedirectUri } = await import("../../src/lib/oauth/providers.ts");
const { resolvePublicCred } = await import("../../open-sse/utils/publicCreds.ts");

/** Custom (non-embedded) Google OAuth credentials — the remote-deploy case. */
const CUSTOM_CREDS = {
  ANTIGRAVITY_OAUTH_CLIENT_ID: "custom-id.apps.googleusercontent.com",
  ANTIGRAVITY_OAUTH_CLIENT_SECRET: "custom-secret",
};

/** The placeholder shipped in `.env.example` that must NOT win precedence. */
const LOCALHOST_PLACEHOLDER = "http://localhost:20128";

// ---------------------------------------------------------------------------
// Defect 1 — localhost placeholder must not shadow the server-side override
// ---------------------------------------------------------------------------

test("localhost NEXT_PUBLIC_BASE_URL placeholder does not shadow OMNIROUTE_PUBLIC_BASE_URL", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      // Copied verbatim from .env.example — present but meaningless remotely.
      NEXT_PUBLIC_BASE_URL: LOCALHOST_PLACEHOLDER,
      // The variable the operator actually set on Render.
      OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(
    redirectUri,
    "https://omniroute.onrender.com/callback",
    "the localhost placeholder must not win over the real public origin"
  );
});

test("127.0.0.1 NEXT_PUBLIC_BASE_URL placeholder also defers to OMNIROUTE_PUBLIC_BASE_URL", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      NEXT_PUBLIC_BASE_URL: "http://127.0.0.1:20128",
      OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(redirectUri, "https://omniroute.onrender.com/callback");
});

test("an explicit public NEXT_PUBLIC_BASE_URL still takes precedence over the server-side one", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      NEXT_PUBLIC_BASE_URL: "https://explicit.example.com",
      OMNIROUTE_PUBLIC_BASE_URL: "https://fallback.example.com",
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(
    redirectUri,
    "https://explicit.example.com/callback",
    "a genuinely configured public URL must keep winning"
  );
});

test("a localhost NEXT_PUBLIC_BASE_URL alone never leaks a public origin", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      NEXT_PUBLIC_BASE_URL: LOCALHOST_PLACEHOLDER,
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(
    redirectUri,
    "http://localhost:20128/callback",
    "with no public origin anywhere the result must stay on loopback (127.0.0.1 " +
      "normalizes to the equivalent localhost) — never a public host"
  );
  assert.match(redirectUri, /^http:\/\/(localhost|127\.0\.0\.1):/, "must remain a loopback URL");
});

test("agy inherits the localhost-placeholder fallback", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri("agy", "http://localhost:20128/callback", {
    NEXT_PUBLIC_BASE_URL: LOCALHOST_PLACEHOLDER,
    OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
    ANTIGRAVITY_OAUTH_CLIENT_ID: "custom-agy.apps.googleusercontent.com",
    ANTIGRAVITY_OAUTH_CLIENT_SECRET: "custom-agy-secret",
  });

  assert.equal(redirectUri, "https://omniroute.onrender.com/callback");
});

// ---------------------------------------------------------------------------
// Defect 2 — the upgrade must not be gated on ANTIGRAVITY_OAUTH_CLIENT_TYPE
// ---------------------------------------------------------------------------

test("loopback upgrade works without ANTIGRAVITY_OAUTH_CLIENT_TYPE set", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(redirectUri, "https://omniroute.onrender.com/callback");
});

test("loopback upgrade is identical for web, cli and desktop client types", () => {
  const resolve = (clientType: string) =>
    resolveBrowserOAuthRedirectUri("antigravity", "http://127.0.0.1:20128/callback", {
      OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
      ANTIGRAVITY_OAUTH_CLIENT_TYPE: clientType,
      ...CUSTOM_CREDS,
    });

  const expected = "https://omniroute.onrender.com/callback";
  assert.equal(resolve("web"), expected);
  assert.equal(resolve("cli"), expected);
  assert.equal(resolve("desktop"), expected);
  assert.equal(resolve(""), expected, "an empty client type must not disable the upgrade");
});

// ---------------------------------------------------------------------------
// Trailing-slash / normalization robustness on the resolved origin
// ---------------------------------------------------------------------------

test("trailing slash on the public base URL does not produce a doubled separator", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com/",
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(redirectUri, "https://omniroute.onrender.com/callback");
});

test("a subpath deployment keeps its base path in the public callback", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      NEXT_PUBLIC_BASE_URL: LOCALHOST_PLACEHOLDER,
      OMNIROUTE_PUBLIC_BASE_URL: "https://example.com/omniroute",
      ...CUSTOM_CREDS,
    }
  );

  assert.equal(
    redirectUri,
    "https://example.com/omniroute/callback",
    "the callback path is appended to the base path, not the bare origin"
  );
});

// ---------------------------------------------------------------------------
// Guards: the fix must not weaken the existing safety rules
// ---------------------------------------------------------------------------

test("built-in credentials still keep loopback even with a public base URL configured", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri(
    "antigravity",
    "http://127.0.0.1:20128/callback",
    {
      NEXT_PUBLIC_BASE_URL: LOCALHOST_PLACEHOLDER,
      OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
      ANTIGRAVITY_OAUTH_CLIENT_ID: resolvePublicCred("antigravity_id"),
      ANTIGRAVITY_OAUTH_CLIENT_SECRET: "GOCSPX-SomeDefaultSecret",
    }
  );

  assert.equal(
    redirectUri,
    "http://127.0.0.1:20128/callback",
    "the embedded native-app credentials only accept loopback redirects"
  );
});

test("non-Google providers are never affected by the public base URL fallback", () => {
  const redirectUri = resolveBrowserOAuthRedirectUri("claude", "http://localhost:20128/callback", {
    NEXT_PUBLIC_BASE_URL: LOCALHOST_PLACEHOLDER,
    OMNIROUTE_PUBLIC_BASE_URL: "https://omniroute.onrender.com",
    ...CUSTOM_CREDS,
  });

  assert.equal(redirectUri, "http://localhost:20128/callback");
});
