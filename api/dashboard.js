// api/dashboard.js — Password-protected sales dashboard reading live Stripe data.
//
// Security model:
//   - Access is gated by HTTP Basic Auth. The expected password lives in the
//     DASHBOARD_PASSWORD env var (never in code, never sent to the browser).
//   - Stripe is read with STRIPE_SECRET_KEY. Use a *restricted, read-only* key
//     (Stripe → Developers → API keys → Create restricted key: Checkout Sessions
//     = Read). The key stays server-side; the browser only ever receives HTML.
//   - Sales are filtered to this book's payment link(s), so other products sold
//     on the same Stripe account never appear here.

function requireAuth(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard", charset="UTF-8"');
  res.status(401).send('Autenticazione richiesta');
}

function isAuthorized(req) {
  const expected = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!expected) return false; // no password set => locked by default
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const pass = decoded.slice(decoded.indexOf(':') + 1); // ignore username
  return pass === expected;
}

// Fetches paid Checkout Sessions for a given payment link (paginated).
async function fetchSessionsForLink(key, link) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://api.stripe.com/v1/checkout/sessions');
    url.searchParams.set('limit', '100');
    if (link) url.searchParams.set('payment_link', link);
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    const r = await fetch(url.toString(), {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (!r.ok) throw new Error('Stripe ' + r.status + ': ' + (await r.text()));
    const data = await r.json();
    out.push(...(data.data || []));
    if (!data.has_more || !(data.data || []).length) break;
    startingAfter = data.data[data.data.length - 1].id;
  }
  return out;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function eur(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

function dmy(unix) {
  const d = new Date(unix * 1000);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) return requireAuth(res);

  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    res.status(500).send('STRIPE_SECRET_KEY non configurata su Vercel.');
    return;
  }

  const FRONTEND =
    process.env.STRIPE_PAYMENT_LINK_ID || 'plink_1TtpetFyO2awdoWuF1oDPpBl';
  const UPSELL = (process.env.STRIPE_UPSELL_PAYMENT_LINK_ID || '').trim();
  const links = [FRONTEND].concat(UPSELL ? [UPSELL] : []);

  let sessions = [];
  try {
    for (const l of links) {
      sessions = sessions.concat(await fetchSessionsForLink(key, l));
    }
  } catch (e) {
    res.status(502).send('Errore lettura Stripe: ' + esc(e.message));
    return;
  }

  // Keep only genuinely paid sessions, most recent first.
  const linkSet = new Set(links);
  const paid = sessions
    .filter(
      (s) =>
        s.payment_status === 'paid' &&
        (s.amount_total || 0) > 0 &&
        (!s.payment_link || linkSet.has(s.payment_link))
    )
    .sort((a, b) => b.created - a.created);

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const sum = (arr) => arr.reduce((t, s) => t + (s.amount_total || 0), 0) / 100;
  const within = (secs) => paid.filter((s) => now - s.created <= secs);

  const d1 = within(DAY);
  const d7 = within(7 * DAY);
  const d30 = within(30 * DAY);

  const kpis = [
    { label: 'Ultime 24h', n: d1.length, v: sum(d1) },
    { label: '7 giorni', n: d7.length, v: sum(d7) },
    { label: '30 giorni', n: d30.length, v: sum(d30) },
    { label: 'Totale mostrato', n: paid.length, v: sum(paid) },
  ];

  // 14-day daily revenue buckets.
  const todayStart = Math.floor(now / DAY) * DAY;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = todayStart - i * DAY;
    const items = paid.filter((s) => s.created >= start && s.created < start + DAY);
    days.push({ ts: start, v: sum(items), n: items.length });
  }
  const maxV = Math.max(1, ...days.map((d) => d.v));

  const bars = days
    .map((d, i) => {
      const h = Math.round((d.v / maxV) * 90);
      const x = 8 + i * 26;
      const dd = new Date(d.ts * 1000).getDate();
      return (
        `<g>` +
        `<rect x="${x}" y="${110 - h}" width="18" height="${h}" rx="3" fill="${d.v > 0 ? '#C4342F' : '#2A1F1C'}"></rect>` +
        `<text x="${x + 9}" y="126" text-anchor="middle" font-size="9" fill="#9C8F89">${dd}</text>` +
        `</g>`
      );
    })
    .join('');

  const rows = paid
    .slice(0, 60)
    .map((s) => {
      const email = esc((s.customer_details && s.customer_details.email) || '—');
      const amt = eur((s.amount_total || 0) / 100);
      const isUpsell = UPSELL && s.payment_link === UPSELL;
      return (
        `<tr>` +
        `<td class="amt">${amt}</td>` +
        `<td class="em">${email}${isUpsell ? ' <span class="tag">upsell</span>' : ''}</td>` +
        `<td class="dt">${dmy(s.created)}</td>` +
        `</tr>`
      );
    })
    .join('');

  const kpiHtml = kpis
    .map(
      (k) =>
        `<div class="kpi"><div class="kpi-l">${k.label}</div>` +
        `<div class="kpi-v">${eur(k.v)}</div>` +
        `<div class="kpi-n">${k.n} vendite</div></div>`
    )
    .join('');

  const updated = dmy(now);

  const html = `<!DOCTYPE html>
<html lang="it"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Vendite · Il corpo tradisce la mente</title>
<style>
  :root{--void:#0E0B0C;--void-2:#17110F;--ember:#C4342F;--signal:#E7B24A;--parchment:#F5F0EA;--ash:#9C8F89;--line:#2A1F1C;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--void);color:var(--parchment);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:20px;}
  .wrap{max-width:720px;margin:0 auto;}
  h1{font-size:20px;margin:0 0 2px;}
  .sub{color:var(--ash);font-size:12px;margin-bottom:18px;}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px;}
  @media(min-width:560px){.grid{grid-template-columns:repeat(4,1fr);}}
  .kpi{background:var(--void-2);border:1px solid var(--line);border-radius:10px;padding:14px;}
  .kpi-l{color:var(--ash);font-size:11px;text-transform:uppercase;letter-spacing:.04em;}
  .kpi-v{font-size:22px;font-weight:800;margin-top:6px;}
  .kpi-n{color:var(--signal);font-size:12px;margin-top:2px;}
  .card{background:var(--void-2);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:20px;}
  .card h2{font-size:13px;color:var(--ash);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px;font-weight:700;}
  svg{width:100%;height:auto;display:block;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th{text-align:left;color:var(--ash);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--line);}
  td{padding:9px 8px;border-bottom:1px solid var(--line);}
  td.amt{font-weight:800;white-space:nowrap;}
  td.em{color:#D8CFC9;word-break:break-all;}
  td.dt{color:var(--ash);white-space:nowrap;text-align:right;}
  .tag{background:var(--signal);color:#1a1206;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;}
  .foot{color:var(--ash);font-size:12px;text-align:center;margin-top:8px;}
  a.refresh{color:var(--signal);text-decoration:none;}
</style></head>
<body><div class="wrap">
  <h1>Vendite · Il corpo tradisce la mente</h1>
  <div class="sub">Dati live da Stripe · aggiornato ${updated} · <a class="refresh" href="/api/dashboard">↻ ricarica</a></div>
  <div class="grid">${kpiHtml}</div>
  <div class="card">
    <h2>Ricavi ultimi 14 giorni</h2>
    <svg viewBox="0 0 380 132" preserveAspectRatio="xMidYMid meet">${bars}</svg>
  </div>
  <div class="card">
    <h2>Ultimi pagamenti</h2>
    <table>
      <thead><tr><th>Importo</th><th>Cliente</th><th style="text-align:right;">Data</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" style="color:#9C8F89;padding:16px;">Nessuna vendita trovata.</td></tr>'}</tbody>
    </table>
  </div>
  <div class="foot">Mostra le vendite dei payment link del libro · fino a ~500 sessioni recenti.</div>
</div></body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
};
