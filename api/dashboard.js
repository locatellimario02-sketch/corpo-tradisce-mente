// api/dashboard.js — Password-protected sales dashboard reading live Stripe data.
//
// Security model:
//   - Access is gated by HTTP Basic Auth. The expected password lives in the
//     DASHBOARD_PASSWORD env var (never in code, never sent to the browser).
//   - Stripe is read with STRIPE_SECRET_KEY. Use a *restricted, read-only* key.
//     The key stays server-side; the browser only ever receives HTML/CSV.
//   - Sales are filtered to this book's payment link(s).
//
// Add ?format=csv to download the raw rows.

const MAX_PAGES = 3; // pages of 100 sessions per payment link

// Only show sales from the relaunch onward. Default: 07/08/2026 00:00 Europe/Rome
// (= 06/08/2026 22:00 UTC). Override with DASHBOARD_SINCE_UNIX if needed.
const CUTOFF = Number(process.env.DASHBOARD_SINCE_UNIX) || Math.floor(Date.UTC(2026, 7, 6, 22, 0, 0) / 1000);

function requireAuth(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard", charset="UTF-8"');
  res.status(401).send('Autenticazione richiesta');
}

function isAuthorized(req) {
  const expected = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!expected) return false;
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return pass === expected;
}

// Fetch paid Checkout Sessions for a payment link. `expand` toggles pulling the
// payment method details (payment_intent + charge). If the key lacks permission
// to expand, the caller retries without it so the dashboard still works.
async function fetchSessionsForLink(key, link, expand) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.stripe.com/v1/checkout/sessions');
    url.searchParams.set('limit', '100');
    if (link) url.searchParams.set('payment_link', link);
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    if (expand) url.searchParams.append('expand[]', 'data.payment_intent.latest_charge');
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

function cap(s) {
  s = String(s || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Derive the payment method used from an (optionally expanded) session.
function paymentMethod(s) {
  const pi = s.payment_intent;
  const charge = pi && typeof pi === 'object' ? pi.latest_charge : null;
  const pmd = charge && typeof charge === 'object' ? charge.payment_method_details : null;
  if (pmd && pmd.type) {
    if (pmd.type === 'card' && pmd.card) {
      return { type: 'card', label: `${cap(pmd.card.brand)} ••${pmd.card.last4}` };
    }
    if (pmd.type === 'paypal') return { type: 'paypal', label: 'PayPal' };
    return { type: pmd.type, label: cap(pmd.type) };
  }
  const types = s.payment_method_types || [];
  if (types.length === 1) return { type: types[0], label: cap(types[0]) };
  return { type: 'unknown', label: '—' };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function eur(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}
function dmy(unix) {
  const d = new Date(unix * 1000);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
  const linkSet = new Set(links);

  // Try to fetch with payment-method details; if the key can't expand, fall back.
  let sessions = [];
  let methodAvailable = true;
  try {
    for (const l of links) {
      sessions = sessions.concat(await fetchSessionsForLink(key, l, true));
    }
  } catch (e) {
    methodAvailable = false;
    sessions = [];
    try {
      for (const l of links) {
        sessions = sessions.concat(await fetchSessionsForLink(key, l, false));
      }
    } catch (e2) {
      res.status(502).send('Errore lettura Stripe: ' + esc(e2.message));
      return;
    }
  }

  const paid = sessions
    .filter(
      (s) =>
        s.payment_status === 'paid' &&
        (s.amount_total || 0) > 0 &&
        s.created >= CUTOFF &&
        (!s.payment_link || linkSet.has(s.payment_link))
    )
    .sort((a, b) => b.created - a.created);

  // Normalize into rows.
  const rows = paid.map((s) => {
    const d = s.customer_details || {};
    const m = paymentMethod(s);
    return {
      ts: s.created,
      amount: (s.amount_total || 0) / 100,
      currency: (s.currency || 'eur').toUpperCase(),
      email: d.email || '',
      name: d.name || '',
      country: (d.address && d.address.country) || '',
      method: m.label,
      methodType: m.type,
      type: UPSELL && s.payment_link === UPSELL ? 'upsell' : 'front-end',
    };
  });

  // ---- CSV export ----
  if (/[?&]format=csv/.test(req.url || '')) {
    const header = ['data', 'importo', 'valuta', 'metodo', 'email', 'nome', 'paese', 'tipo'];
    const lines = [header.join(',')].concat(
      rows.map((r) =>
        [dmy(r.ts), r.amount.toFixed(2), r.currency, r.method, r.email, r.name, r.country, r.type]
          .map(csvCell)
          .join(',')
      )
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vendite.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('﻿' + lines.join('\n'));
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const sum = (arr) => arr.reduce((t, r) => t + r.amount, 0);
  const within = (secs) => rows.filter((r) => now - r.ts <= secs);

  const d1 = within(DAY);
  const d7 = within(7 * DAY);
  const d30 = within(30 * DAY);
  const totalRev = sum(rows);
  const aov = rows.length ? totalRev / rows.length : 0;

  const kpis = [
    { l: 'Ultime 24h', v: eur(sum(d1)), n: d1.length + ' vendite' },
    { l: '7 giorni', v: eur(sum(d7)), n: d7.length + ' vendite' },
    { l: '30 giorni', v: eur(sum(d30)), n: d30.length + ' vendite' },
    { l: 'Totale', v: eur(totalRev), n: rows.length + ' vendite' },
    { l: 'Scontrino medio', v: eur(aov), n: 'per vendita' },
  ];

  // Money by method (where the funds are).
  const byMethod = {};
  rows.forEach((r) => {
    const k = r.methodType === 'card' ? 'Carta (Stripe)' : r.methodType === 'paypal' ? 'PayPal' : 'Altro';
    if (!byMethod[k]) byMethod[k] = { n: 0, v: 0 };
    byMethod[k].n++;
    byMethod[k].v += r.amount;
  });
  const methodRows = Object.keys(byMethod)
    .sort((a, b) => byMethod[b].v - byMethod[a].v)
    .map((k) => `<tr><td>${esc(k)}</td><td class="num">${byMethod[k].n}</td><td class="num amt">${eur(byMethod[k].v)}</td></tr>`)
    .join('');

  // Breakdown by price point.
  const byPrice = {};
  rows.forEach((r) => {
    const k = eur(r.amount);
    if (!byPrice[k]) byPrice[k] = 0;
    byPrice[k]++;
  });
  const priceRows = Object.keys(byPrice)
    .sort((a, b) => byPrice[b] - byPrice[a])
    .map((k) => `<tr><td>${esc(k)}</td><td class="num">${byPrice[k]} vendite</td></tr>`)
    .join('');

  // Abandoned / incomplete checkouts: opened the payment link but never paid.
  const abandoned = sessions
    .filter(
      (s) =>
        s.created >= CUTOFF &&
        (s.amount_total || 0) > 0 &&
        (!s.payment_link || linkSet.has(s.payment_link)) &&
        s.payment_status !== 'paid'
    )
    .sort((a, b) => b.created - a.created);
  const totalCheckouts = rows.length + abandoned.length;
  const completionRate = totalCheckouts ? Math.round((rows.length / totalCheckouts) * 100) : 0;
  const statusLabel = (s) =>
    s.status === 'expired' ? 'scaduto' : s.status === 'open' ? 'aperto' : 'incompleto';
  const abRows = abandoned
    .slice(0, 40)
    .map((s) => {
      const d = s.customer_details || {};
      const email = d.email || s.customer_email || '';
      return (
        `<tr><td class="dt">${esc(dmy(s.created).slice(0, 11))}</td>` +
        `<td class="amt">${eur((s.amount_total || 0) / 100)}</td>` +
        `<td class="em">${esc(email || '—')}</td>` +
        `<td>${esc(statusLabel(s))}</td></tr>`
      );
    })
    .join('');

  // 30-day daily revenue chart.
  const todayStart = Math.floor(now / DAY) * DAY;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const start = todayStart - i * DAY;
    const items = rows.filter((r) => r.ts >= start && r.ts < start + DAY);
    days.push({ ts: start, v: sum(items), n: items.length });
  }
  const maxV = Math.max(1, ...days.map((d) => d.v));
  const barW = 18, gap = 8, chartW = days.length * (barW + gap) + 8;
  const bars = days
    .map((d, i) => {
      const h = Math.round((d.v / maxV) * 90);
      const x = 8 + i * (barW + gap);
      const dd = new Date(d.ts * 1000).getDate();
      return (
        `<rect x="${x}" y="${110 - h}" width="${barW}" height="${h}" rx="3" fill="${d.v > 0 ? '#C4342F' : '#241a18'}"><title>${dmy(d.ts).slice(0, 5)}: ${eur(d.v)} (${d.n})</title></rect>` +
        `<text x="${x + barW / 2}" y="126" text-anchor="middle" font-size="9" fill="#9C8F89">${dd}</text>`
      );
    })
    .join('');

  const tableRows = rows
    .slice(0, 100)
    .map(
      (r) =>
        `<tr>` +
        `<td class="dt">${esc(dmy(r.ts).slice(0, 11))}</td>` +
        `<td class="amt">${eur(r.amount)}</td>` +
        `<td>${esc(r.method)}</td>` +
        `<td class="em">${esc(r.email)}</td>` +
        `<td>${esc(r.name || '—')}</td>` +
        `<td class="ctr">${esc(r.country || '—')}</td>` +
        `<td>${r.type === 'upsell' ? '<span class="tag">upsell</span>' : 'front-end'}</td>` +
        `</tr>`
    )
    .join('');

  const kpiHtml = kpis
    .map((k) => `<div class="kpi"><div class="kpi-l">${k.l}</div><div class="kpi-v">${k.v}</div><div class="kpi-n">${k.n}</div></div>`)
    .join('');

  const updated = dmy(now);
  const methodNote = methodAvailable
    ? 'Gli incassi <b>PayPal</b> arrivano sul tuo conto PayPal; quelli con <b>carta</b> sul saldo Stripe.'
    : 'Metodo di pagamento non disponibile con questa chiave (serve il permesso di lettura su Charge/PaymentIntent).';

  const html = `<!DOCTYPE html>
<html lang="it"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Vendite · Il linguaggio segreto del corpo</title>
<style>
  :root{--void:#0E0B0C;--void-2:#17110F;--ember:#C4342F;--signal:#E7B24A;--parchment:#F5F0EA;--ash:#9C8F89;--line:#2A1F1C;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--void);color:var(--parchment);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:20px;}
  .wrap{max-width:900px;margin:0 auto;}
  h1{font-size:20px;margin:0 0 2px;}
  .sub{color:var(--ash);font-size:12px;margin-bottom:18px;}
  .sub a{color:var(--signal);text-decoration:none;}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px;}
  @media(min-width:620px){.grid{grid-template-columns:repeat(5,1fr);}}
  .kpi{background:var(--void-2);border:1px solid var(--line);border-radius:10px;padding:12px;}
  .kpi-l{color:var(--ash);font-size:10px;text-transform:uppercase;letter-spacing:.04em;}
  .kpi-v{font-size:19px;font-weight:800;margin-top:6px;}
  .kpi-n{color:var(--signal);font-size:11px;margin-top:2px;}
  .cols{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:16px;}
  @media(min-width:620px){.cols{grid-template-columns:1fr 1fr;}}
  .card{background:var(--void-2);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:16px;}
  .card h2{font-size:12px;color:var(--ash);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px;font-weight:700;}
  .note{color:var(--ash);font-size:12px;margin-top:8px;line-height:1.5;}
  .scroll{overflow-x:auto;}
  svg{display:block;height:132px;}
  table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap;}
  th{text-align:left;color:var(--ash);font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--line);}
  td{padding:8px;border-bottom:1px solid var(--line);}
  td.amt{font-weight:800;}
  td.num{text-align:right;}
  td.em{color:#D8CFC9;}
  td.dt,td.ctr{color:var(--ash);}
  .tag{background:var(--signal);color:#1a1206;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;}
  .btn{display:inline-block;background:var(--ember);color:#FCEBEB;font-weight:700;font-size:13px;padding:8px 14px;border-radius:6px;text-decoration:none;}
</style></head>
<body><div class="wrap">
  <h1>Vendite · Il linguaggio segreto del corpo</h1>
  <div class="sub">Dati live da Stripe · aggiornato ${updated} · <a href="/api/dashboard">↻ ricarica</a> · <a href="/api/dashboard?format=csv">⬇ CSV</a></div>

  <div class="grid">${kpiHtml}</div>

  <div class="cols">
    <div class="card">
      <h2>Dove sono i soldi (per metodo)</h2>
      <table><thead><tr><th>Metodo</th><th class="num">Vendite</th><th class="num">Incasso</th></tr></thead>
      <tbody>${methodRows || '<tr><td colspan="3">—</td></tr>'}</tbody></table>
      <div class="note">${methodNote}</div>
    </div>
    <div class="card">
      <h2>Vendite per prezzo</h2>
      <table><thead><tr><th>Prezzo</th><th>Quantità</th></tr></thead>
      <tbody>${priceRows || '<tr><td colspan="2">—</td></tr>'}</tbody></table>
    </div>
  </div>

  <div class="cols">
    <div class="card">
      <h2>Checkout (funnel)</h2>
      <table>
        <tr><td>Completati (pagati)</td><td class="num amt">${rows.length}</td></tr>
        <tr><td>Abbandonati</td><td class="num">${abandoned.length}</td></tr>
        <tr><td>Tasso di completamento</td><td class="num" style="color:var(--signal);font-weight:800;">${completionRate}%</td></tr>
      </table>
      <div class="note">"Abbandonati" = ha aperto il link di pagamento ma non ha completato l'acquisto.</div>
    </div>
    <div class="card">
      <h2>Ultimi checkout abbandonati (max 40)</h2>
      <div class="scroll"><table>
        <thead><tr><th>Data</th><th>Importo</th><th>Email</th><th>Stato</th></tr></thead>
        <tbody>${abRows || '<tr><td colspan="4">Nessuno.</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>

  <div class="card">
    <h2>Ricavi ultimi 30 giorni</h2>
    <div class="scroll"><svg viewBox="0 0 ${chartW} 132" width="${chartW}" preserveAspectRatio="xMinYMid meet">${bars}</svg></div>
  </div>

  <div class="card">
    <h2>Ultimi pagamenti (max 100)</h2>
    <div class="scroll">
    <table>
      <thead><tr><th>Data</th><th>Importo</th><th>Metodo</th><th>Email</th><th>Nome</th><th>Paese</th><th>Tipo</th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="7">Nessuna vendita trovata.</td></tr>'}</tbody>
    </table>
    </div>
    <div style="margin-top:12px;"><a class="btn" href="/api/dashboard?format=csv">⬇ Scarica tutto in CSV</a></div>
  </div>

  <div class="sub">Vendite dal ${dmy(CUTOFF).slice(0, 10)} · payment link del libro (front-end${UPSELL ? ' + upsell' : ''}) · fino a ~${MAX_PAGES * 100} sessioni recenti per link.</div>
</div></body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
};
