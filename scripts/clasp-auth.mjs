// clasp girişi, uzun süre açık kalan bir terminal gerektirmeden (iki adımda):
//   node clasp-auth.mjs url            → izin linkini yazdırır (PKCE doğrulayıcısı ~/.clasp-pkce.json'a kaydedilir)
//   node clasp-auth.mjs code "<URL>"   → kullanıcının yapıştırdığı http://localhost:8888/?code=... linkini
//                                         token'a çevirir ve clasp'in ~/.clasprc.json dosyasına yazar.
// CLASP_DIR: clasp'in kurulu olduğu npm prefix'i (varsayılan ~/clasp).
import fs from 'fs'; import os from 'os'; import path from 'path'; import { pathToFileURL } from 'url';
const dir = process.env.CLASP_DIR || path.join(os.homedir(), 'clasp');
const nm = path.join(dir, 'node_modules');
const { DEFAULT_CLASP_OAUTH_CLIENT_ID: ID, DEFAULT_CLASP_OAUTH_CLIENT_SECRET: SECRET } =
  await import(pathToFileURL(path.join(nm, '@google/clasp/build/src/auth/oauth_client.js')).href);
const { OAuth2Client } = (await import(pathToFileURL(path.join(nm, 'google-auth-library/build/src/index.js')).href)).default
  ?? await import(pathToFileURL(path.join(nm, 'google-auth-library/build/src/index.js')).href);
const REDIRECT = 'http://localhost:8888';
const SCOPES = ['script.deployments', 'script.projects', 'script.webapp.deploy', 'drive.metadata.readonly', 'drive.file',
  'service.management', 'logging.read', 'userinfo.email', 'userinfo.profile', 'cloud-platform']
  .map(s => 'https://www.googleapis.com/auth/' + s);
const PKCE = path.join(os.homedir(), '.clasp-pkce.json');
const client = new OAuth2Client({ clientId: ID, clientSecret: SECRET, redirectUri: REDIRECT });
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'url') {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  fs.writeFileSync(PKCE, JSON.stringify({ codeVerifier }), { mode: 0o600 });
  console.log(client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: codeChallenge }));
} else if (cmd === 'code') {
  const code = new URL(String(arg).trim()).searchParams.get('code') || String(arg).trim();
  const { codeVerifier } = JSON.parse(fs.readFileSync(PKCE, 'utf8'));
  const { tokens } = await client.getToken({ code, redirect_uri: REDIRECT, codeVerifier });
  const rc = path.join(os.homedir(), '.clasprc.json');
  const store = fs.existsSync(rc) ? JSON.parse(fs.readFileSync(rc, 'utf8')) : {};
  store.tokens = store.tokens || {};
  store.tokens.default = { client_id: ID, client_secret: SECRET, type: 'authorized_user',
    refresh_token: tokens.refresh_token, access_token: tokens.access_token, expiry_date: tokens.expiry_date };
  fs.writeFileSync(rc, JSON.stringify(store, null, 2), { mode: 0o600 }); fs.unlinkSync(PKCE);
  console.log('clasp girişi tamam');
} else { console.log('kullanım: node clasp-auth.mjs url | code "<yapıştırılan URL>"'); process.exit(1); }
