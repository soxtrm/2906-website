'use strict'
// ============================================================================
// services/facebookPages/settings.js — configuration for the agent Facebook
// Business Page integration (Claude, 2026-11-14).
//
// Everything comes from the environment (the backend's existing .env /
// docker env_file). Nothing is hard-coded: no app id, no secret, no token.
// This module never touches config.facebook / FB_PAGE_* — those belong to
// Kevin's own company-page tooling (services/fbPost.js) and stay separate.
//
//   META_APP_ID                 Meta app id (public)
//   META_APP_SECRET             Meta app secret (server only)
//   META_LOGIN_CONFIG_ID        optional Facebook Login for Business configuration id;
//                               when set, the dialog uses config_id instead of scope
//   META_GRAPH_VERSION          default v27.0 (latest on 2026-11-14)
//   META_OAUTH_REDIRECT_URI     default https://crm.2906.estate/integrations/facebook/callback
//   ARGUS_FB_TOKEN_KEY          32-byte key (base64 or hex) for AES-256-GCM at rest
//   ARGUS_FB_DELETION_STATUS_URL default https://crm.2906.estate/integrations/facebook/deletion
//   ARGUS_FB_AUTOPUBLISH_SCAN   '1' to run the opt-in auto-publish scanner (default off)
// ============================================================================

const DEFAULT_GRAPH_VERSION = 'v27.0'
const DEFAULT_REDIRECT = 'https://crm.2906.estate/integrations/facebook/callback'
const DEFAULT_DELETION_STATUS = 'https://crm.2906.estate/integrations/facebook/deletion'

// Minimum permissions for: list Pages, read back the post, publish posts.
// business_management is requested because Pages owned through a business
// portfolio are otherwise missing from /me/accounts (Meta's Pages use case
// adds it automatically; see docs/facebook-pages/META_SETUP.md).
const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']
const OPTIONAL_SCOPES = ['business_management']

function env(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function graphVersion() {
  const v = env('META_GRAPH_VERSION') || DEFAULT_GRAPH_VERSION
  if (!/^v\d{2}\.\d$/.test(v)) throw new Error('META_GRAPH_VERSION must look like v27.0')
  return v
}

function read() {
  return {
    appId: env('META_APP_ID'),
    appSecret: env('META_APP_SECRET'),
    loginConfigId: env('META_LOGIN_CONFIG_ID'),
    graphVersion: graphVersion(),
    redirectUri: env('META_OAUTH_REDIRECT_URI') || DEFAULT_REDIRECT,
    tokenKey: env('ARGUS_FB_TOKEN_KEY'),
    deletionStatusUrl: env('ARGUS_FB_DELETION_STATUS_URL') || DEFAULT_DELETION_STATUS,
    autoPublishScan: env('ARGUS_FB_AUTOPUBLISH_SCAN') === '1',
  }
}

// What is missing for the integration to work at all. Names only, never values.
function missing() {
  const s = read()
  const out = []
  if (!s.appId) out.push('META_APP_ID')
  if (!s.appSecret) out.push('META_APP_SECRET')
  if (!s.tokenKey) out.push('ARGUS_FB_TOKEN_KEY')
  return out
}

function isConfigured() { return missing().length === 0 }

module.exports = { read, missing, isConfigured, graphVersion, REQUIRED_SCOPES, OPTIONAL_SCOPES, DEFAULT_GRAPH_VERSION }
