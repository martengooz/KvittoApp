import type { FastifyInstance, FastifyReply } from 'fastify';

const securityHeaders = {
  'cache-control': 'no-cache',
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

export function registerDashboard(app: FastifyInstance): void {
  app.get('/server', async (_request, reply) => send(reply, 'text/html; charset=utf-8', page));
  app.get('/server/styles.css', async (_request, reply) => send(reply, 'text/css; charset=utf-8', styles));
  app.get('/server/app.js', async (_request, reply) => send(reply, 'text/javascript; charset=utf-8', script));
}

function send(reply: FastifyReply, contentType: string, body: string): FastifyReply {
  for (const [name, value] of Object.entries(securityHeaders)) reply.header(name, value);
  return reply.type(contentType).send(body);
}

const page = `<!doctype html>
<html lang="sv">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f2f2f7">
    <title>KvittoApp server</title>
    <link rel="stylesheet" href="/server/styles.css">
  </head>
  <body>
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header__bar">
          <div class="app-header__leading">
            <span class="connection" id="connection"><i class="status-dot"></i><span>Kontrollerar</span></span>
          </div>
          <h1 class="app-header__title">Server</h1>
          <div class="app-header__actions">
            <button class="bar-button bar-button--icon" id="refresh" type="button" title="Uppdatera" aria-label="Uppdatera">↻</button>
            <a class="bar-button" href="/">App</a>
          </div>
        </div>
      </header>

      <main class="app-main">
        <p class="page-message" id="updated" role="status">Hämtar status…</p>

        <div id="dashboard" hidden>
          <section class="list-group" aria-label="Serverstatus">
            <h2 class="list-group__title">Status</h2>
            <div class="inset-list">
              <div class="row">
                <span class="row__label">Tjänst</span>
                <span class="status-line"><i class="status-dot status-dot--ok"></i><span id="health-value">–</span></span>
                <span class="row__value" id="health-detail">–</span>
              </div>
              <div class="row"><span class="row__label">Revision</span><span class="row__value" id="revision-value">–</span></div>
              <div class="row"><span class="row__label">Kvitton</span><span class="row__value" id="receipts-value">–</span></div>
              <div class="row">
                <span class="row__label">Lokal modell</span>
                <span class="row__value" id="llm-value">–</span>
              </div>
              <div class="row">
                <span class="row__label">AI-proxy</span>
                <span class="row__value" id="ai-proxy-value">–</span>
              </div>
            </div>
          </section>

          <section class="list-group">
            <h2 class="list-group__title">Parkoppling</h2>
            <div class="inset-list">
              <label class="row">
                <span class="row__label">Serveradress</span>
                <input id="pair-server-url" type="url" inputmode="url" autocomplete="url" required>
              </label>
              <div class="row">
                <span class="row__label">Kod</span>
                <strong class="pairing-code" id="pairing-code">–</strong>
                <button class="btn btn--plain btn--sm" id="create-pairing-code" type="button">Skapa kod</button>
              </div>
              <div class="pairing-qr" id="pairing-qr" hidden>
                <img id="pairing-qr-image" alt="QR-kod för parkoppling" width="320" height="320">
              </div>
            </div>
            <p class="list-group__footer" id="pair-message" role="status">Skapa en kod och skanna den i appen.</p>
          </section>

          <section class="list-group">
            <h2 class="list-group__title">AI-tolkning</h2>
            <form class="inset-list" id="server-ai-form">
              <label class="row">
                <span class="row__label">Leverantör</span>
                <select id="ai-provider" aria-label="AI-leverantör">
                  <option value="none">Ingen</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="openai-compatible">OpenAI-kompatibel</option>
                </select>
              </label>
              <label class="row">
                <span class="row__label">Adress</span>
                <input id="ai-base-url" type="url" inputmode="url" autocomplete="url" placeholder="Standard">
              </label>
              <label class="row">
                <span class="row__label">Modell</span>
                <input id="ai-model" type="text" autocapitalize="none" autocomplete="off" required>
              </label>
              <label class="row">
                <span class="row__label">Max tokens</span>
                <input id="ai-max-output-tokens" type="number" inputmode="numeric" min="1000" max="128000" step="1000" required>
              </label>
              <label class="row">
                <span class="row__label">Tankedjup</span>
                <select id="ai-effort" aria-label="Tankedjup">
                  <option value="auto">Standard</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
              </label>
              <label class="row">
                <span class="row__label">Tvinga JSON-schema</span>
                <input class="toggle" id="ai-structured-output" type="checkbox">
              </label>
              <label class="row row--stacked">
                <span class="row__label">Extra instruktioner</span>
                <textarea id="ai-extra-instructions" rows="2" maxlength="2000" placeholder="Instruktioner för alla enheter"></textarea>
              </label>
              <div class="row row--actions">
                <button class="btn btn--primary" type="submit">Spara</button>
              </div>
            </form>
            <p class="list-group__footer action-message" id="config-message" role="status"></p>
          </section>

          <section class="list-group">
            <h2 class="list-group__title">API-nycklar</h2>
            <div class="inset-list">
              <form class="secret-row" data-secret="aiApiKey">
                <div class="row secret-field">
                  <label class="row__label" for="ai-api-key">AI</label>
                  <input id="ai-api-key" type="password" autocomplete="off" aria-label="AI-nyckel" placeholder="Inte sparad">
                  <button class="btn btn--plain btn--sm" type="submit">Spara</button>
                  <button class="btn btn--plain btn--danger-plain btn--sm secret-clear" type="button">Rensa</button>
                </div>
              </form>
              <form class="secret-row" data-secret="companyApiKey">
                <div class="row secret-field">
                  <label class="row__label" for="company-api-key">Apiverket</label>
                  <input id="company-api-key" type="password" autocomplete="off" aria-label="Apiverket-nyckel" placeholder="Inte sparad">
                  <button class="btn btn--plain btn--sm" type="submit">Spara</button>
                  <button class="btn btn--plain btn--danger-plain btn--sm secret-clear" type="button">Rensa</button>
                </div>
              </form>
            </div>
            <p class="list-group__footer action-message" id="secret-message" role="status"></p>
          </section>

          <section class="list-group">
            <h2 class="list-group__title">Enheter <span id="device-count">0</span></h2>
            <div class="inset-list" id="devices"></div>
          </section>

          <section class="list-group">
            <h2 class="list-group__title">Lokal modell</h2>
            <div class="inset-list">
              <div class="row">
                <span class="row__label">Status</span>
                <span class="row__value" id="model-state">–</span>
              </div>
              <div class="row model-stats">
                <span>Väntar <strong id="queue-pending">–</strong></span>
                <span>Bearbetar <strong id="queue-running">–</strong></span>
                <span>Misslyckade <strong id="queue-failed">–</strong></span>
              </div>
              <div class="row row--actions model-actions">
                <button class="btn btn--plain" id="model-start" type="button">Starta</button>
                <button class="btn btn--primary" id="model-scan" type="button">Kör kön nu</button>
                <button class="btn btn--plain" id="model-pull" type="button">Hämta modell</button>
              </div>
            </div>
            <p class="list-group__footer action-message" id="model-message" role="status"></p>
          </section>

          <section class="list-group">
            <div class="inset-list">
              <div class="row">
                <span class="row__value identity" id="identity">–</span>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
    <script src="/server/app.js" defer></script>
  </body>
</html>`;

const styles = `
:root {
  color-scheme: light dark;
  --ios-blue: #007aff;
  --ios-green: #34c759;
  --ios-orange: #ff9500;
  --ios-red: #ff3b30;
  --bg-grouped: #f2f2f7;
  --bg-grouped-secondary: #ffffff;
  --label: #000000;
  --label-secondary: rgb(60 60 67 / 60%);
  --label-tertiary: rgb(60 60 67 / 30%);
  --fill: rgb(120 120 128 / 20%);
  --fill-tertiary: rgb(118 118 128 / 12%);
  --fill-quaternary: rgb(116 116 128 / 8%);
  --separator: rgb(60 60 67 / 29%);
  --tint: var(--ios-blue);
  --on-tint: #ffffff;
  --danger: var(--ios-red);
  --success: var(--ios-green);
  --warning: var(--ios-orange);
  --material-bar: rgb(249 249 249 / 82%);
  --radius-card: 10px;
  --radius-control: 10px;
  --radius-field: 10px;
  --nav-bar-height: 44px;
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --gutter: 16px;
  --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ios-blue: #0a84ff;
    --ios-green: #30d158;
    --ios-orange: #ff9f0a;
    --ios-red: #ff453a;
    --bg-grouped: #000000;
    --bg-grouped-secondary: #1c1c1e;
    --label: #ffffff;
    --label-secondary: rgb(235 235 245 / 60%);
    --label-tertiary: rgb(235 235 245 / 30%);
    --fill: rgb(120 120 128 / 36%);
    --fill-tertiary: rgb(118 118 128 / 24%);
    --fill-quaternary: rgb(118 118 128 / 18%);
    --separator: rgb(84 84 88 / 60%);
    --material-bar: rgb(30 30 30 / 80%);
  }
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: var(--bg-grouped); color: var(--label); font-family: var(--font); font-size: 17px; line-height: 1.29412; letter-spacing: -0.022em; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; }
.app-shell { max-width: 640px; min-height: 100dvh; margin-inline: auto; background: var(--bg-grouped); }
.app-header { position: sticky; top: 0; z-index: 20; padding-top: var(--safe-top); background: var(--material-bar); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); box-shadow: inset 0 -0.5px 0 var(--separator); }
.app-header__bar { display: flex; align-items: center; gap: 8px; min-height: var(--nav-bar-height); padding-inline: max(var(--gutter), var(--safe-left)) max(var(--gutter), var(--safe-right)); }
.app-header__title { flex: 1; min-width: 0; margin: 0; font-size: 17px; font-weight: 600; text-align: center; }
.app-header__leading, .app-header__actions { display: flex; align-items: center; min-width: 86px; }
.app-header__actions { justify-content: flex-end; }
.connection, .status-line { display: inline-flex; align-items: center; gap: 7px; color: var(--label-secondary); font-size: 13px; white-space: nowrap; }
.status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--warning); }
.connection[data-state='ok'] .status-dot, .status-dot--ok { background: var(--success); }
.connection[data-state='error'] .status-dot, .status-dot--error { background: var(--danger); }
.bar-button { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 0 4px; border: 0; background: none; color: var(--tint); font: inherit; font-size: 17px; text-decoration: none; cursor: pointer; }
.bar-button--icon { font-size: 22px; }
.app-main { padding: 12px 0 24px; }
.page-message { min-height: 18px; margin: 0 0 7px; padding-inline: max(calc(var(--gutter) + 16px), var(--safe-left)); color: var(--label-secondary); font-size: 13px; }
.list-group { margin: 0 0 24px; padding: 0; }
.list-group__title { display: flex; justify-content: space-between; margin: 0 0 7px; padding-inline: max(calc(var(--gutter) + 16px), var(--safe-left)); color: var(--label-secondary); font-size: 13px; font-weight: 400; text-transform: uppercase; }
.list-group__footer { margin: 7px 0 0; padding-inline: max(calc(var(--gutter) + 16px), var(--safe-left)); color: var(--label-secondary); font-size: 13px; line-height: 1.35; }
.inset-list { margin-inline: max(var(--gutter), var(--safe-left)) max(var(--gutter), var(--safe-right)); border-radius: var(--radius-card); background: var(--bg-grouped-secondary); overflow: hidden; }
.row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 11px 16px; border: 0; background: none; color: inherit; font: inherit; font-size: 17px; text-align: left; text-decoration: none; }
.row + .row::before, .secret-row + .secret-row .row::before { content: ''; position: absolute; top: 0; left: 16px; right: 0; height: 0.5px; background: var(--separator); }
button.row { cursor: pointer; }
button.row:active { background: var(--fill-quaternary); }
.row__label { flex: 1; min-width: 0; }
.row__value { max-width: 60%; overflow: hidden; color: var(--label-secondary); font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 11px 18px; border: 0; border-radius: var(--radius-control); background: var(--fill-tertiary); color: var(--tint); font: inherit; font-size: 17px; font-weight: 600; cursor: pointer; }
.btn:active:not(:disabled), .bar-button:active { opacity: .45; }
.btn:disabled { color: var(--label-tertiary); cursor: not-allowed; }
.btn--primary { background: var(--tint); color: var(--on-tint); }
.btn--plain { background: none; padding-inline: 8px; font-weight: 400; }
.btn--danger-plain { background: none; color: var(--danger); }
.btn--sm { min-height: 34px; padding: 6px 8px; font-size: 15px; }
.btn--block { width: 100%; }
input[type='text'], input[type='password'], input[type='url'], input[type='number'], select { width: 100%; min-width: 0; min-height: 44px; padding: 11px 12px; border: 0; border-radius: var(--radius-field); background: var(--fill-tertiary); color: var(--label); font: inherit; font-size: 17px; appearance: none; }
.row input[type='text'], .row input[type='password'], .row input[type='url'], .row input[type='number'], .row select { max-width: 300px; min-height: 22px; padding: 0; border-radius: 0; background: none; text-align: right; }
.row select { color: var(--tint); text-align-last: right; }
.row--stacked { align-items: stretch; flex-direction: column; gap: 6px; }
textarea { width: 100%; min-height: 64px; resize: vertical; padding: 8px 10px; border: 0; border-radius: 8px; background: var(--fill-tertiary); color: var(--label); font: inherit; font-size: 15px; }
.toggle { position: relative; flex: none; width: 51px; height: 31px; margin: 0; border: 0; border-radius: 999px; background: var(--fill); appearance: none; cursor: pointer; transition: background .2s ease; }
.toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 50%; background: #fff; box-shadow: 0 2px 5px rgb(0 0 0 / 25%); transition: transform .2s ease; }
.toggle:checked { background: var(--success); }
.toggle:checked::after { transform: translateX(20px); }
.row input::placeholder { color: var(--label-tertiary); }
.row--actions { justify-content: flex-end; }
.form-message:empty, .action-message:empty { display: none; }
.form-message { color: var(--danger); }
.pairing-code { color: var(--label); font-family: var(--font-mono); font-size: 17px; letter-spacing: .08em; }
.pairing-qr { padding: 16px; border-top: .5px solid var(--separator); text-align: center; }
.pairing-qr img { display: block; width: min(100%, 320px); height: auto; margin: 0 auto; border-radius: 8px; background: #fff; }
.secret-field { flex-wrap: nowrap; }
.model-stats { justify-content: space-between; color: var(--label-secondary); font-size: 13px; }
.model-stats span { display: grid; gap: 3px; text-align: center; }
.model-stats strong { color: var(--label); font-size: 17px; font-weight: 500; }
.model-actions { justify-content: center; flex-wrap: wrap; }
.device-name { display: block; }
.device-meta { display: block; max-width: 250px; overflow: hidden; color: var(--label-secondary); font-family: var(--font-mono); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.device-status { display: inline-flex; align-items: center; gap: 6px; color: var(--label-secondary); font-size: 13px; }
.device-status .status-dot { background: var(--success); }
.device-status--revoked .status-dot { background: var(--danger); }
.identity { max-width: 100%; font-family: var(--font-mono); font-size: 11px; text-align: left; }
.destructive-row { justify-content: center; color: var(--danger); }
:focus-visible { outline: 2px solid var(--tint); outline-offset: 2px; border-radius: 4px; }
[hidden] { display: none !important; }

@media (max-width: 520px) {
  .app-header__leading, .app-header__actions { min-width: 76px; }
  .connection span { display: none; }
  .secret-field { align-items: stretch; flex-wrap: wrap; }
  .secret-field .row__label { flex-basis: 100%; }
  .secret-field input { flex: 1; max-width: none !important; text-align: left !important; }
  .row input[type='url'] { max-width: 220px; }
  .device-row { align-items: flex-start; flex-wrap: wrap; }
  .device-row .row__value { margin-left: auto; }
}
`;

const script = `
(() => {
  const storageKey = 'kvitto.server.token';
  const deviceKey = 'kvitto.server.deviceId';
  const element = (id) => document.getElementById(id);
  let token = localStorage.getItem(storageKey) || '';
  let currentDeviceId = localStorage.getItem(deviceKey) || '';
  element('pair-server-url').value = location.origin;

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token) headers.authorization = 'Bearer ' + token;
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.message || 'Anropet misslyckades (' + response.status + ')');
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function setConnection(state, text) {
    element('connection').dataset.state = state;
    element('connection').querySelector('span').textContent = text;
  }

  function formatTime(value) {
    if (!value) return 'Aldrig';
    return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  }

  function queueValue(queue, name) {
    return queue?.[name] ?? queue?.[name === 'pending' ? 'queued' : name] ?? 0;
  }

  async function refresh() {
    element('refresh').disabled = true;
    try {
      const health = await request('/health');
      setConnection('ok', 'Online');
      element('health-value').textContent = 'Online';
      element('health-detail').textContent = 'Protokoll ' + health.protocolVersion;
      element('updated').textContent = 'Uppdaterad ' + formatTime(health.serverTime);
      if (!token) {
        currentDeviceId ||= crypto.randomUUID();
        const session = await request('/auth/dashboard', {
          method: 'POST',
          body: JSON.stringify({ deviceId: currentDeviceId, deviceName: 'Serverdashboard' }),
        });
        token = session.token;
        currentDeviceId = session.deviceId;
        localStorage.setItem(storageKey, token);
        localStorage.setItem(deviceKey, currentDeviceId);
      }

      const [me, sync, devices, llm, secrets, serverConfig] = await Promise.all([
        request('/auth/me'),
        request('/sync/status?counts=1'),
        request('/auth/devices'),
        request('/llm/status'),
        request('/secrets'),
        request('/server/config'),
      ]);
      currentDeviceId = me.deviceId;
      localStorage.setItem(deviceKey, currentDeviceId);
      element('dashboard').hidden = false;
      element('revision-value').textContent = String(sync.cursor ?? 0);
      element('receipts-value').textContent = String(sync.counts?.receipts ?? 0);
      element('ai-proxy-value').textContent = me.aiProxyEnabled ? 'Aktiv' : 'Ej konfigurerad';
      element('identity').textContent = me.deviceName + ' · ' + me.accountId;
      renderDevices(devices.devices || []);
      renderModel(llm);
      renderServerConfig(serverConfig);
      renderSecrets(secrets.secrets || [], serverConfig.ai.apiKeyConfigured);
    } catch (error) {
      if (error?.status === 401) {
        disconnect(false);
        element('dashboard').hidden = true;
        setConnection('ok', 'Online');
        element('updated').textContent = 'Dashboardens session har återställts. Uppdatera sidan.';
      } else {
        setConnection('error', 'Ej tillgänglig');
        element('updated').textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      element('refresh').disabled = false;
    }
  }

  function renderDevices(devices) {
    element('device-count').textContent = String(devices.filter((device) => !device.revokedAt).length);
    const rows = devices.map((device) => {
      const row = document.createElement('div');
      row.className = 'row device-row';
      const name = document.createElement('span');
      name.className = 'row__label';
      const nameText = document.createElement('span');
      nameText.className = 'device-name';
      nameText.textContent = device.name + (device.id === currentDeviceId ? ' (denna)' : '');
      const id = document.createElement('span');
      id.className = 'device-meta';
      id.textContent = device.id;
      name.append(nameText, id);
      const seen = document.createElement('span');
      seen.className = 'row__value';
      seen.textContent = formatTime(device.lastSeenAt);
      const status = document.createElement('span');
      status.className = 'device-status' + (device.revokedAt ? ' device-status--revoked' : '');
      const dot = document.createElement('i');
      dot.className = 'status-dot';
      status.append(dot, device.revokedAt ? 'Spärrad' : 'Aktiv');
      if (!device.revokedAt && device.id !== currentDeviceId) {
        const revoke = document.createElement('button');
        revoke.className = 'btn btn--plain btn--danger-plain btn--sm';
        revoke.type = 'button';
        revoke.textContent = 'Spärra';
        revoke.addEventListener('click', () => revokeDevice(device.id, revoke));
        row.append(name, seen, status, revoke);
      } else {
        row.append(name, seen, status);
      }
      return row;
    });
    element('devices').replaceChildren(...rows);
  }

  function renderModel(llm) {
    const state = llm.enabled ? (llm.runtime?.state || 'okänd') : 'avstängd';
    element('llm-value').textContent = state;
    element('model-state').textContent = state;
    element('queue-pending').textContent = String(queueValue(llm.queue, 'pending'));
    element('queue-running').textContent = String(queueValue(llm.queue, 'running'));
    element('queue-failed').textContent = String(queueValue(llm.queue, 'failed'));
    for (const id of ['model-start', 'model-scan', 'model-pull']) element(id).disabled = !llm.enabled;
  }

  function renderServerConfig(serverConfig) {
    element('ai-provider').value = serverConfig.ai.provider;
    element('ai-base-url').value = serverConfig.ai.baseUrl;
    element('ai-model').value = serverConfig.ai.model;
    element('ai-max-output-tokens').value = String(serverConfig.ai.maxOutputTokens);
    element('ai-effort').value = serverConfig.ai.effort;
    element('ai-structured-output').checked = serverConfig.ai.structuredOutput;
    element('ai-extra-instructions').value = serverConfig.ai.extraInstructions;
  }

  function renderSecrets(secrets, aiKeyConfigured) {
    for (const secret of secrets) {
      const form = document.querySelector('[data-secret="' + secret.id + '"]');
      const input = form.querySelector('input');
      const configured = secret.id === 'aiApiKey' ? aiKeyConfigured : secret.configured;
      form.dataset.configured = String(configured);
      input.placeholder = configured ? 'Sparad' : 'Inte sparad';
    }
  }

  async function saveServerConfig(event) {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    element('config-message').textContent = 'Sparar…';
    try {
      const result = await request('/server/config', {
        method: 'PUT',
        body: JSON.stringify({
          ai: {
            provider: element('ai-provider').value,
            baseUrl: element('ai-base-url').value.trim(),
            model: element('ai-model').value.trim(),
            maxOutputTokens: Number(element('ai-max-output-tokens').value),
            effort: element('ai-effort').value,
            structuredOutput: element('ai-structured-output').checked,
            extraInstructions: element('ai-extra-instructions').value.trim(),
          },
        }),
      });
      renderServerConfig(result);
      element('config-message').textContent = 'Sparad.';
      await refresh();
    } catch (error) {
      element('config-message').textContent = error instanceof Error ? error.message : String(error);
    } finally {
      submit.disabled = false;
    }
  }

  async function saveSecret(form, value) {
    const id = form.dataset.secret;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    element('secret-message').textContent = 'Sparar…';
    try {
      await request('/secrets/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      form.querySelector('input').value = '';
      element('secret-message').textContent = value ? 'Sparad.' : 'Rensad.';
      await refresh();
    } catch (error) {
      element('secret-message').textContent = error instanceof Error ? error.message : String(error);
    } finally {
      submit.disabled = false;
    }
  }

  async function createPairingCode() {
    const button = element('create-pairing-code');
    button.disabled = true;
    try {
      const result = await request('/auth/pairing-code', {
        method: 'POST',
        body: JSON.stringify({ serverUrl: element('pair-server-url').value.trim() }),
      });
      element('pairing-code').textContent = result.code;
      element('pairing-qr-image').src = result.qrImage;
      element('pairing-qr').hidden = false;
      element('pair-message').textContent = 'Giltig till ' + formatTime(result.expiresAt) + '.';
    } catch (error) {
      element('pair-message').textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  }

  async function revokeDevice(id, button) {
    button.disabled = true;
    try {
      await request('/auth/devices/' + encodeURIComponent(id), { method: 'DELETE' });
      await refresh();
    } catch (error) {
      element('updated').textContent = error instanceof Error ? error.message : String(error);
      button.disabled = false;
    }
  }

  async function modelAction(path, message) {
    const output = element('model-message');
    output.textContent = message;
    try {
      await request(path, { method: 'POST', body: path.endsWith('/scan') ? '{}' : undefined });
      output.textContent = 'Klart.';
      await refresh();
    } catch (error) {
      output.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function disconnect(refreshPage = true) {
    token = '';
    localStorage.removeItem(storageKey);
    if (refreshPage) void refresh();
  }

  element('refresh').addEventListener('click', refresh);
  element('create-pairing-code').addEventListener('click', createPairingCode);
  element('server-ai-form').addEventListener('submit', saveServerConfig);
  element('model-start').addEventListener('click', () => modelAction('/llm/start', 'Startar…'));
  element('model-scan').addEventListener('click', () => modelAction('/llm/scan', 'Bearbetar…'));
  element('model-pull').addEventListener('click', () => modelAction('/llm/pull', 'Startar hämtning…'));
  for (const form of document.querySelectorAll('.secret-row')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = form.querySelector('input').value.trim();
      if (value) void saveSecret(form, value);
    });
    form.querySelector('.secret-clear').addEventListener('click', () => void saveSecret(form, ''));
  }
  void refresh();
})();
`;