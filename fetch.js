import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// ── CONFIG ────────────────────────────────────────────────
const ZOHO = {
  clientId:     process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  orgId:        process.env.ZOHO_ORG_ID,
};
const GH = {
  token:    process.env.GITHUB_TOKEN,
  username: process.env.GITHUB_USERNAME,
  repo:     'inocrea-dashboard',
};

const TODAY  = new Date().toISOString().slice(0, 10);
const HEURE  = new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
const J7     = new Date(Date.now() -   7 * 86400000).toISOString().slice(0, 10);
const J30    = new Date(Date.now() -  30 * 86400000).toISOString().slice(0, 10);
const J180   = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

const COMMERCIAUX = [
  'Mehdi Braham', 'Jonathan Schoonjans', 'Biagio Cacopardo',
  'Ismaïl Amezian', 'Dany Vermeulen', 'Tarik Burazerovic',
];
const ETAPES_ACTIVES = [
  'Rendez-vous pris','Négociation',"En attente d'activation WL & MP",
  'En validation de financement','Renting incomplet','En correction',
  'Traitement UBO','À compléter','Attribuer TID','Livraison/Installation',
  'Installation terminée','Installation non terminée','En attente de paiement',
  'Date Future','Prise de rendez-vous en cours','Signé','Contrat signé',
];

let token = null;
const logs = [];
const log = msg => { const l = `[${new Date().toISOString()}] ${msg}`; logs.push(l); console.log(l); };

// ── AUTH ──────────────────────────────────────────────────
async function refreshToken() {
  const res = await fetch('https://accounts.zoho.eu/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO.clientId,
      client_secret: ZOHO.clientSecret,
      refresh_token: ZOHO.refreshToken,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Token refresh échoué : ' + JSON.stringify(d));
  token = d.access_token;
  log('TOKEN OK');
}

async function get(url, retry = false) {
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (res.status === 401 && !retry) { await refreshToken(); return get(url, true); }
  if (!res.ok) { log(`WARN ${res.status} — ${url.slice(0, 80)}`); return null; }
  return res.json();
}

// ── FETCH CRM ─────────────────────────────────────────────
async function fetchPipeline() {
  const fields = 'Deal_Name,Stage,Amount,Owner,Type_of_opportunity,Last_Activity_Time,Modified_Time,Organisme_financier,Type';
  const d = await get(`https://www.zohoapis.eu/crm/v2/Potentials?fields=${fields}&per_page=200`);
  return (d?.data || []).filter(r =>
    ETAPES_ACTIVES.includes(r.Stage) &&
    (r.Last_Activity_Time || r.Modified_Time || '').slice(0, 10) >= J180
  );
}

async function fetchDealsRecents() {
  const fields = 'Deal_Name,Stage,Amount,Owner,Type_of_opportunity,Closing_Date';
  const crit = encodeURIComponent(`(Modified_Time:greater_equal:${J7}T00:00:00+00:00)AND((Stage:equals:Gagné)OR(Stage:equals:Pas signé))`);
  const d = await get(`https://www.zohoapis.eu/crm/v2/Potentials?fields=${fields}&criteria=${crit}&per_page=200`);
  return d?.data || [];
}

async function fetchCorrections() {
  const fields = 'Deal_Name,Owner,Reason_for_internal_correction,Modified_Time';
  const crit = encodeURIComponent(`(Reason_for_internal_correction:is_not_empty:true)AND(Modified_Time:greater_equal:${J30}T00:00:00+00:00)`);
  const d = await get(`https://www.zohoapis.eu/crm/v2/Potentials?fields=${fields}&criteria=${crit}&per_page=200`);
  return d?.data || [];
}

async function fetchGiveBacks() {
  const d = await get(`https://www.zohoapis.eu/crm/v2/Potentials?fields=Deal_Name,Owner,Reason_Give_Back,Created_Time,Stage&criteria=${encodeURIComponent('(Stage:equals:Give back)')}&per_page=100`);
  return d?.data || [];
}

// ── FETCH BOOKS ───────────────────────────────────────────
async function fetchInvoices() {
  const base = `https://www.zohoapis.eu/books/v3/invoices?organization_id=${ZOHO.orgId}&date_start=2026-01-01&date_end=${TODAY}&per_page=200`;
  let all = [], page = 1, more = true;
  while (more && page <= 10) {
    const d = await get(`${base}&page=${page}`);
    if (!d?.invoices?.length) break;
    all = all.concat(d.invoices);
    more = d.page_context?.has_more_page || false;
    page++;
  }
  return all;
}

async function fetchOverdue() {
  const d = await get(`https://www.zohoapis.eu/books/v3/invoices?organization_id=${ZOHO.orgId}&filter_by=Status.Overdue&per_page=200`);
  return d?.invoices || [];
}

// ── FETCH DESK ────────────────────────────────────────────
async function fetchTicketsRecents() {
  const d = await get(`https://desk.zoho.eu/api/v1/tickets?createdTimeRange=${J7}T00:00:00Z,${TODAY}T23:59:59Z&limit=100&fields=id,subject,status,assigneeId,classification,channel,createdTime,modifiedTime,reopenCount`);
  return d?.data || [];
}

async function fetchTicketsAnciens() {
  const d = await get(`https://desk.zoho.eu/api/v1/tickets?status=open&createdTimeRange=2025-01-01T00:00:00Z,${J30}T23:59:59Z&limit=50&fields=id,subject,status,assigneeId,classification,createdTime`);
  return d?.data || [];
}

// ── MÉTRIQUES ─────────────────────────────────────────────
function calcMetrics(pipeline, dealsR, corrections, giveBacks, invoices, overdue, ticketsR, ticketsA) {
  const ownerName = r => r.Owner?.name || r.Owner || '';
  const byType = arr => ({
    WL:  arr.filter(r => r.Type_of_opportunity === 'Worldline').length,
    MP:  arr.filter(r => r.Type_of_opportunity === 'Marketpay').length,
    INO: arr.filter(r => r.Type_of_opportunity === 'Inoresto').length,
  });

  const gagnes  = dealsR.filter(r => r.Stage === 'Gagné');
  const ps      = dealsR.filter(r => r.Stage === 'Pas signé');

  // Pipeline
  const pipe = {
    rdv_pris:          pipeline.filter(r => r.Stage === 'Rendez-vous pris').length,
    negociation:       pipeline.filter(r => r.Stage === 'Négociation').length,
    attente_wl:        pipeline.filter(r => r.Stage === "En attente d'activation WL & MP").length,
    en_correction:     pipeline.filter(r => r.Stage === 'En correction').length,
    val_financement:   pipeline.filter(r => r.Stage === 'En validation de financement').length,
    traitement_ubo:    pipeline.filter(r => r.Stage === 'Traitement UBO').length,
    renting_incomplet: pipeline.filter(r => r.Stage === 'Renting incomplet').length,
    closing_imminent:  pipeline.filter(r => ['Attribuer TID','Installation terminée','Signé'].includes(r.Stage)).length,
    valeur_totale:     Math.round(pipeline.reduce((s, r) => s + (parseFloat(r.Amount)||0), 0)),
  };

  // Commerciaux
  const comm = {};
  for (const nom of COMMERCIAUX) {
    comm[nom] = {
      gagnes_7j:       gagnes.filter(r => ownerName(r) === nom).length,
      ps_7j:           ps.filter(r => ownerName(r) === nom).length,
      corrections_30j: corrections.filter(r => ownerName(r) === nom).length,
      en_nego:         pipeline.filter(r => ownerName(r) === nom && r.Stage === 'Négociation').length,
      val_pipe:        Math.round(pipeline.filter(r => ownerName(r) === nom).reduce((s,r) => s+(parseFloat(r.Amount)||0), 0)),
    };
  }

  // Finances
  const ca_ytd = {}, ca_semaine = {};
  for (const inv of invoices) {
    const t = inv.cf_type || 'Autre';
    ca_ytd[t] = (ca_ytd[t]||0) + parseFloat(inv.total||0);
    if ((inv.date||'') >= J7) ca_semaine[t] = (ca_semaine[t]||0) + parseFloat(inv.total||0);
  }
  const overdue_par_type = {};
  let overdue_total = 0;
  for (const inv of overdue) {
    const t = inv.cf_type || 'Autre';
    const b = parseFloat(inv.balance||0);
    overdue_par_type[t] = (overdue_par_type[t]||0) + b;
    overdue_total += b;
  }

  // Desk
  const ticketsJour  = ticketsR.filter(r => r.createdTime?.slice(0,10) === TODAY);
  const activJour    = ticketsJour.filter(r => r.subject?.toLowerCase().includes('activat'));
  const reouvertsJ   = ticketsR.filter(r => (r.reopenCount||0) > 0 && r.modifiedTime?.slice(0,10) === TODAY);
  const dubail       = ticketsA.find(r => r.subject?.toLowerCase().includes('dubail'));
  const dubailAge    = dubail ? Math.floor((Date.now() - new Date(dubail.createdTime)) / 86400000) : null;

  // Alertes
  const alertes = [];
  for (const nom of COMMERCIAUX) {
    if (comm[nom].corrections_30j > 15)
      alertes.push({ niveau:'CRITIQUE', module:'CRM', titre:`${nom} — ${comm[nom].corrections_30j} corrections/30j`, action:'Session coaching individuelle cette semaine' });
  }
  if (dubail)
    alertes.push({ niveau:'CRITIQUE', module:'DESK', titre:`DUBAIL ouvert ${dubailAge}j — risque juridique`, action:"Escalade immédiate — contact client aujourd'hui" });
  if ((overdue_par_type['Résiliation']||0) > 130000)
    alertes.push({ niveau:'CRITIQUE', module:'BOOKS', titre:`Overdue résiliations ${Math.round(overdue_par_type['Résiliation']||0).toLocaleString('fr')}€`, action:'Campagne recouvrement résiliations urgente' });
  const gbAnciens = giveBacks.filter(r => Math.floor((Date.now()-new Date(r.Created_Time))/86400000) > 45);
  if (gbAnciens.length)
    alertes.push({ niveau:'MAJEUR', module:'CRM', titre:`${gbAnciens.length} Give Back(s) > 45j en attente`, action:'Relancer Worldline sur ces dossiers' });
  if (ticketsA.length > 5)
    alertes.push({ niveau:'MAJEUR', module:'DESK', titre:`${ticketsA.length} tickets ouverts > 30j`, action:'Revue tickets anciens — assignation obligatoire' });
  if (activJour.length > 15)
    alertes.push({ niveau:'MAJEUR', module:'DESK', titre:`${activJour.length} tickets activation aujourd'hui — embouteillage`, action:'Vérifier activations bloquées dans CRM' });

  // Scores
  const sp = Math.max(0, 100 - pipe.en_correction*10 - pipe.traitement_ubo*5);
  let sc = 70;
  for (const nom of COMMERCIAUX) {
    if (comm[nom].corrections_30j === 0) sc += 5;
    if (comm[nom].corrections_30j > 15)  sc -= 10;
  }
  if (gagnes.some(r => ['Marketpay','Inoresto'].includes(r.Type_of_opportunity))) sc += 5;
  const sf = Math.max(0, 100 - Math.min(40,(overdue_par_type['Résiliation']||0)/5000));
  let sd = 100;
  if (dubail) sd -= 20;
  sd -= ticketsA.filter(r => !r.assigneeId).length * 5;
  sd -= Math.min(30, ticketsA.length * 5);
  const scores = {
    pipeline:   Math.max(0, Math.round(sp)),
    commercial: Math.max(0, Math.min(100, Math.round(sc))),
    financier:  Math.max(0, Math.round(sf)),
    desk:       Math.max(0, Math.round(sd)),
    global:     Math.round(sp*0.30 + sc*0.30 + sf*0.25 + sd*0.15),
  };

  return {
    date: TODAY, heure: HEURE,
    pipeline: pipe, pipeline_par_type: byType(pipeline),
    gagnes_7j: { total: gagnes.length, ...byType(gagnes) },
    ps_7j:     { total: ps.length, ...byType(ps) },
    commerciaux: comm,
    finances: { ca_ytd, ca_semaine, overdue_total: Math.round(overdue_total), overdue_par_type },
    desk: {
      tickets_jour: ticketsJour.length,
      activations_jour: activJour.length,
      activations_pct: ticketsJour.length ? Math.round(activJour.length/ticketsJour.length*100) : 0,
      reouverts_jour: reouvertsJ.length,
      tickets_anciens: ticketsA.length,
      dubail_age_jours: dubailAge,
    },
    give_backs_en_attente: giveBacks.map(r => ({
      client: r.Deal_Name,
      age_jours: Math.floor((Date.now()-new Date(r.Created_Time))/86400000),
      raison: r.Reason_Give_Back || 'Non défini',
    })),
    alertes, scores,
  };
}

// ── DASHBOARD ─────────────────────────────────────────────
function updateDashboard(data) {
  const tpl  = path.join('dashboard', 'template.html');
  const dash = path.join('dashboard', 'index.html');
  if (!fs.existsSync(tpl)) throw new Error('dashboard/template.html introuvable');
  let html = fs.readFileSync(tpl, 'utf8');

  const block = `// DATA_START — généré le ${data.date} à ${data.heure}
const DATA = ${JSON.stringify(data, null, 2)};
// DATA_END`;

  html = html.includes('// DATA_START')
    ? html.replace(/\/\/ DATA_START[\s\S]*?\/\/ DATA_END/, block)
    : html.replace('</script>', block + '\n</script>');

  const dateStr = new Date().toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short', year:'numeric' }) + ` · ${data.heure}`;
  html = html.replace(/id="hd-date">[^<]*/, `id="hd-date">${dateStr}`);

  const nbCrit = data.alertes.filter(a => a.niveau === 'CRITIQUE').length;
  if (nbCrit > 0) html = html.replace(/id="badge-alertes">[^<]*/g, `id="badge-alertes">${nbCrit}`);

  fs.writeFileSync(dash, html, 'utf8');
  log(`DASHBOARD mis à jour → ${dash}`);
}

// ── GITHUB PAGES ──────────────────────────────────────────
async function pushToGitHub(data) {
  const content  = Buffer.from(fs.readFileSync(path.join('dashboard','index.html'))).toString('base64');
  const apiBase  = `https://api.github.com/repos/${GH.username}/${GH.repo}`;
  const headers  = {
    Authorization: `Bearer ${GH.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let sha = null;
  try {
    const r = await fetch(`${apiBase}/contents/index.html`, { headers });
    if (r.ok) sha = (await r.json()).sha;
  } catch (_) {}

  const res = await fetch(`${apiBase}/contents/index.html`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      message: `dashboard: ${data.date} ${data.heure}`,
      content,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error('GitHub push échoué : ' + await res.text());
  log(`GITHUB PAGES — publié → https://${GH.username}.github.io/${GH.repo}/`);
}

// ── SAUVEGARDE ────────────────────────────────────────────
function save(data) {
  ['archive','logs'].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d); });
  fs.writeFileSync(`archive/inocrea_${TODAY}.json`, JSON.stringify(data, null, 2));
  fs.writeFileSync(`logs/inocrea_${TODAY}.txt`, logs.join('\n'));
}

// ── RÉSUMÉ ────────────────────────────────────────────────
function summary(data) {
  const { scores:s, pipeline:p, finances:f, desk:d, alertes } = data;
  const crit = alertes.filter(a=>a.niveau==='CRITIQUE').length;
  const maj  = alertes.filter(a=>a.niveau==='MAJEUR').length;
  console.log(`
═══════════════════════════════════════════
  INOCREA — Routine du ${data.date}
═══════════════════════════════════════════
  Score global     : ${s.global}/100
  Alertes          : ${crit} critiques · ${maj} majeures
  ───────────────────────────────────────
  Pipeline         : ${p.negociation} négo · ${p.rdv_pris} RDV · ${p.attente_wl} att.WL
  Gagnés 7j        : WL ${data.gagnes_7j.WL} · MP ${data.gagnes_7j.MP} · INO ${data.gagnes_7j.INO}
  ───────────────────────────────────────
  Overdue total    : ${Math.round(f.overdue_total).toLocaleString('fr')}€
  ───────────────────────────────────────
  Tickets/jour     : ${d.tickets_jour} (${d.activations_pct}% activation)
  Tickets anciens  : ${d.tickets_anciens}
  DUBAIL           : ${d.dubail_age_jours !== null ? d.dubail_age_jours+'j ouvert ⚠' : 'résolu ✓'}
═══════════════════════════════════════════
  → https://${GH.username}.github.io/${GH.repo}/
═══════════════════════════════════════════`);
  if (alertes.length) {
    console.log('\nALERTES :');
    for (const a of alertes) {
      const ico = a.niveau==='CRITIQUE'?'🔴':a.niveau==='MAJEUR'?'🟠':'🔵';
      console.log(`  ${ico} [${a.module}] ${a.titre}\n     → ${a.action}`);
    }
  }
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  log(`START — Routine Inocrea ${TODAY}`);
  await refreshToken();

  log('CRM — pipeline...');
  const pipeline = await fetchPipeline();
  log(`CRM — ${pipeline.length} deals actifs (zombies exclus)`);

  log('CRM — deals récents...');
  const dealsR = await fetchDealsRecents();
  log(`CRM — ${dealsR.length} deals 7j`);

  log('CRM — corrections...');
  const corrections = await fetchCorrections();
  log(`CRM — ${corrections.length} corrections 30j`);

  log('CRM — give backs...');
  const giveBacks = await fetchGiveBacks();
  log(`CRM — ${giveBacks.length} give backs en attente`);

  log('BOOKS — factures...');
  const invoices = await fetchInvoices();
  log(`BOOKS — ${invoices.length} factures 2026`);

  log('BOOKS — overdue...');
  const overdue = await fetchOverdue();
  log(`BOOKS — ${overdue.length} factures overdue`);

  log('DESK — tickets récents...');
  const ticketsR = await fetchTicketsRecents();
  log(`DESK — ${ticketsR.length} tickets 7j`);

  log('DESK — tickets anciens...');
  const ticketsA = await fetchTicketsAnciens();
  log(`DESK — ${ticketsA.length} tickets ouverts > 30j`);

  const data = calcMetrics(pipeline, dealsR, corrections, giveBacks, invoices, overdue, ticketsR, ticketsA);
  log(`SCORES — global:${data.scores.global} | ALERTES — ${data.alertes.filter(a=>a.niveau==='CRITIQUE').length} critiques`);

  updateDashboard(data);
  save(data);
  await pushToGitHub(data);

  log(`DONE — ${TODAY}`);
  summary(data);
}

main().catch(err => { console.error('ERREUR FATALE :', err.message); process.exit(1); });
