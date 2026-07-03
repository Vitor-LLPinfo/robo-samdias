'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DIR    = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'robo_processados.json');
const LOG_FILE   = path.join(DIR, 'robo_log.csv');

// ---- Estado ----
let state = {};
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = s.deals || {};
    }
  } catch(e) { console.error('Erro ao carregar estado:', e.message); }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({deals: state}, null, 2), 'utf8'); }
  catch(e) { console.error('Erro ao salvar estado:', e.message); }
}
function log(dealId, name, phone, status, ticketId, erro) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  const linha = `${ts},${dealId},${name},${phone},${status},${ticketId||''},${erro||''}`;
  try { fs.appendFileSync(LOG_FILE, linha + '\n', 'utf8'); } catch {}
  console.log(`[${ts}] ${status} | ${name} | ${phone}`);
}
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, 'timestamp,dealId,name,phone,status,ticketId,erro\n', 'utf8');

// ---- Horário comercial (UTC-3 Brasília) ----
function isHorarioComercial() {
  const agora = new Date(Date.now() + CONFIG.fusoHorario * 3600000);
  return agora.getUTCHours() >= CONFIG.horarioInicio && agora.getUTCHours() < CONFIG.horarioFim;
}

// ---- HTTP helper ----
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({status: res.statusCode, data: JSON.parse(data)}); }
        catch { resolve({status: res.statusCode, data}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ---- API Apresenta.me ----
let apresentameToken = CONFIG.apresentame.token;
let apresentameTokenAt = 0;

async function renovarTokenApresentame() {
  const r = await request('https://api.apresenta.me/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'}
  }, {username: CONFIG.apresentame.email, password: CONFIG.apresentame.password, company_id: CONFIG.apresentame.companyId});
  if (!r.data?.token) throw new Error('Falha ao renovar token Apresenta.me');
  apresentameToken = 'Bearer ' + r.data.token;
  apresentameTokenAt = Date.now();
  // Persiste no config para sobreviver restart
  CONFIG.apresentame.token = apresentameToken;
  try { fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(CONFIG, null, 2), 'utf8'); } catch {}
  console.log('[APRESENTAME] Token renovado');
}

async function apGet(path, params = {}) {
  const url = new URL(CONFIG.apresentame.baseUrl + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await request(url.toString(), {headers: {Authorization: apresentameToken}});
  if (r.status === 401) {
    await renovarTokenApresentame();
    return apGet(path, params);
  }
  return r.data;
}

async function apPost(path, body) {
  const r = await request(CONFIG.apresentame.baseUrl + path, {
    method: 'POST',
    headers: {Authorization: apresentameToken, 'Content-Type': 'application/json; charset=utf-8'}
  }, body);
  if (r.status === 401) {
    await renovarTokenApresentame();
    return apPost(path, body);
  }
  return r.data;
}

async function getPhone(customerId) {
  try {
    const r = await apGet(`/persons/${customerId}/contacts`);
    const contacts = Array.isArray(r?.data) ? r.data : [];
    for (const c of contacts) {
      const raw = (c.cellphone || c.phone || '').replace(/\D/g,'');
      if (raw.length >= 10) return raw.startsWith('55') ? raw : '55' + raw;
    }
  } catch {}
  return null;
}

async function getBuildingSlug(buildingId) {
  if (!buildingId) return null;
  try {
    const r = await apGet(`/buildings/${buildingId}`);
    const d = r?.data;
    if (d?.slug) return d.slug;
    const titulo = d?.title_internal || d?.title || '';
    return titulo.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-') || null;
  } catch { return null; }
}

async function moveDeal(dealId, newStepId) {
  try {
    const r = await apGet(`/deals/${dealId}`);
    const deal = r?.data;
    if (!deal) return false;
    await apPost('/deals', Object.assign({}, deal, {step_id: newStepId}));
    return true;
  } catch(e) { console.error(`Erro ao mover deal ${dealId}:`, e.message); return false; }
}

async function fetchAllDeals() {
  const deals = [];
  let page = 1;
  try {
    while (true) {
      const r = await apGet('/deals', {status: 'progress', per_page: 100, page});
      const data = r?.data;
      if (!Array.isArray(data) || data.length === 0) break;
      deals.push(...data);
      const total = r?.total || 0;
      if (deals.length >= total || data.length < 100) break;
      page++;
    }
  } catch(e) { console.error('Erro ao buscar deals:', e.message); }
  return deals;
}

// ---- API Clikchat ----
let clikToken = null;
let clikTokenAt = 0;

async function clikLogin() {
  const r = await request('https://inbox.clikchat.com.br/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'}
  }, {email: CONFIG.clikchat.email, password: CONFIG.clikchat.password});
  if (!r.data?.token) throw new Error('Clikchat login falhou');
  clikToken = r.data.token;
  clikTokenAt = Date.now();
  console.log('[CLIK] Token renovado');
}

async function clikPost(path, body) {
  if (!clikToken || Date.now() - clikTokenAt > 20 * 3600000) await clikLogin();
  const r = await request('https://inbox.clikchat.com.br/api' + path, {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + clikToken, 'Content-Type': 'application/json; charset=utf-8'}
  }, body);
  if (r.status === 401) { await clikLogin(); return clikPost(path, body); }
  return r;
}

async function clikGet(path) {
  if (!clikToken || Date.now() - clikTokenAt > 20 * 3600000) await clikLogin();
  const r = await request('https://inbox.clikchat.com.br/api' + path, {
    headers: {Authorization: 'Bearer ' + clikToken}
  });
  if (r.status === 401) { await clikLogin(); return clikGet(path); }
  return r;
}

async function findContact(phone) {
  const variants = [phone, phone.substring(2), '+' + phone];
  for (const v of variants) {
    try {
      const r = await clikGet(`/contacts?search=${encodeURIComponent(v)}`);
      const stored = phone.substring(2);
      const found = (r.data?.contacts || []).find(c => {
        const n = (c.number || '').replace(/\D/g,'');
        return n === phone || n === stored || phone.endsWith(n) || stored.endsWith(n);
      });
      if (found) return found;
    } catch {}
  }
  return null;
}

async function getOrCreateContact(phone, name) {
  const existing = await findContact(phone);
  if (existing) return existing.id;
  try {
    const r = await clikPost('/contacts', {name, number: phone});
    await sleep(800);
    return r.data?.id;
  } catch(e) {
    const msg = e.message || '';
    if (msg.includes('DUPLICATED')) {
      await sleep(1000);
      const e2 = await findContact(phone);
      if (e2) return e2.id;
    }
    throw e;
  }
}

async function getOrCreateTicket(contactId, phone) {
  try {
    const r = await clikPost('/tickets', {contactId, phone, whatsappId: CONFIG.clikchat.whatsappId});
    if (r.data?.id) return r.data.id;
    throw new Error(JSON.stringify(r.data));
  } catch(e) {
    const msg = e.message || '';
    try {
      const j = JSON.parse(msg);
      if (j?.extraData?.ticketId) return j.extraData.ticketId;
    } catch {}
    throw new Error(msg);
  }
}

async function getOrCreateTicketByPhone(phone) {
  const r = await clikPost('/tickets', {phone, whatsappId: CONFIG.clikchat.whatsappId});
  if (r.data?.id) return r.data.id;
  try {
    const j = r.data;
    if (j?.extraData?.ticketId) return j.extraData.ticketId;
  } catch {}
  throw new Error(JSON.stringify(r.data));
}

async function alreadySent(ticketId) {
  try {
    const r = await clikGet(`/messages/${ticketId}`);
    const msgs = r.data?.messages || [];
    const sent = msgs.filter(m => m.fromMe && m.type === 'conversation');
    if (sent.length === 0) return false;
    const good = sent.filter(m => (m.body || '').match(/Sam Dias|samdias\.com\.br/) && !m.body.includes('�'));
    return good.length > 0;
  } catch { return false; }
}

async function hasReply(ticketId) {
  try {
    const r = await clikGet(`/messages/${ticketId}`);
    const msgs = r.data?.messages || [];
    const types = ['conversation','chat','extendedTextMessage','imageMessage','audioMessage','videoMessage','documentMessage'];
    return msgs.some(m => !m.fromMe && types.includes(m.type));
  } catch { return false; }
}

// ---- Templates ----
function getTemplate(file, slug, nome) {
  const p = path.join(DIR, 'templates', file);
  if (!fs.existsSync(p)) return '';
  let t = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  const firstName = nome ? nome.split(' ')[0] : '';
  let propUrl = '';
  if (slug && slug !== 'null' && slug.length > 5) {
    propUrl = `Imóvel de interesse 🏠: https://samdias.com.br/${slug}\n\n`;
  }
  return t.replace(/\{PROP_URL\}/g, propUrl).replace(/\{NOME\}/g, firstName);
}

// ---- Enviar WhatsApp ----
async function sendWhatsApp(dealId, name, phone, slug) {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      let tid;
      try {
        const cid = await getOrCreateContact(phone, name);
        tid = await getOrCreateTicket(cid, phone);
      } catch {
        console.log('  [FALLBACK] Ticket direto pelo telefone...');
        tid = await getOrCreateTicketByPhone(phone);
      }
      if (await alreadySent(tid)) return {ok: true, ticketId: tid, status: 'JA_ENVIADO'};
      const msg = getTemplate('mensagem_template.txt', slug, name);
      await clikPost(`/messages/${tid}`, {body: msg});
      log(dealId, name, phone, 'ENVIADO', tid);
      return {ok: true, ticketId: tid, status: 'ENVIADO'};
    } catch(e) {
      const msg = e.message || '';
      if (msg.match(/401|expir|token|Sess/i)) { await clikLogin(); continue; }
      if (msg.match(/502|503|504|Gateway/i) && tentativa < 3) { await sleep(15000); continue; }
      log(dealId, name, phone, 'ERRO', '', msg);
      return {ok: false, status: 'ERRO', erro: msg};
    }
  }
  return {ok: false, status: 'ERRO', erro: 'Falha após 3 tentativas'};
}

async function sendFollowUp(dealId, phone, name, ticketId, slug, attempt) {
  const templates = {2: 'mensagem_tentativa2.txt', 3: 'mensagem_tentativa3.txt', 4: 'mensagem_encerramento.txt'};
  const file = templates[attempt] || 'mensagem_tentativa2.txt';
  const msg = getTemplate(file, slug, name);
  if (!msg) return {ok: false, erro: 'Template não encontrado: ' + file};
  for (let t = 1; t <= 3; t++) {
    try {
      await clikPost(`/messages/${ticketId}`, {body: msg});
      log(dealId, name, phone, `FOLLOWUP_${attempt}`, ticketId);
      return {ok: true};
    } catch(e) {
      if (e.message?.match(/401|expir/i)) { await clikLogin(); continue; }
      if (e.message?.match(/502|503|504/i) && t < 3) { await sleep(15000); continue; }
      return {ok: false, erro: e.message};
    }
  }
  return {ok: false, erro: 'Falha após 3 tentativas'};
}

// ---- Processar Follow-Up ----
async function processFollowUp(dealId) {
  const s = state[dealId];
  if (!s) return {action: 'not_tracked'};

  const now = Date.now();
  const {phone, name, slug, ticketId, attempts, firstContactAt, pendente} = s;

  if (pendente && attempts === 0) {
    if (!isHorarioComercial()) return {action: 'waiting_hours'};
    const r = await sendWhatsApp(dealId, name, phone, slug);
    if (r.ok) {
      state[dealId] = {...s, ticketId: r.ticketId, attempts: 1, pendente: false, firstContactAt: now, lastAttemptAt: now};
      saveState();
      console.log(`  [PENDENTE ENVIADO] ${name}`);
      return {action: 'enviado_pendente'};
    }
    return {action: 'waiting_hours'};
  }

  if (!ticketId || attempts >= 99) return {action: 'not_tracked'};
  if (!isHorarioComercial()) return {action: 'waiting_hours'};

  const hoursSince = (now - firstContactAt) / 3600000;

  if (await hasReply(ticketId)) return {action: 'replied', ticketId};

  if (attempts >= 4 && hoursSince >= 96) return {action: 'perdido'};

  if (attempts === 3 && hoursSince >= 72) {
    const r = await sendFollowUp(dealId, phone, name, ticketId, slug, 4);
    if (r.ok) { state[dealId] = {...s, attempts: 4, lastAttemptAt: now}; saveState(); }
    return {action: 'closing'};
  }
  if (attempts === 2 && hoursSince >= 48) {
    const r = await sendFollowUp(dealId, phone, name, ticketId, slug, 3);
    if (r.ok) { state[dealId] = {...s, attempts: 3, lastAttemptAt: now}; saveState(); }
    return {action: 'attempt3'};
  }
  if (attempts === 1 && hoursSince >= 24) {
    const r = await sendFollowUp(dealId, phone, name, ticketId, slug, 2);
    if (r.ok) { state[dealId] = {...s, attempts: 2, lastAttemptAt: now}; saveState(); }
    return {action: 'attempt2'};
  }

  return {action: 'waiting', attempts, hoursSince: Math.round(hoursSince * 10) / 10};
}

// ---- Ciclo principal ----
async function ciclo() {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  console.log(`\n[${ts}] === CICLO INICIADO ===`);

  try {
    const allDeals = await fetchAllDeals();
    const leads    = allDeals.filter(d => d.step_id === CONFIG.apresentame.stepLead);
    const followUps = allDeals.filter(d => d.step_id === CONFIG.apresentame.stepFollowUp);

    console.log(`  Leads: ${leads.length} | Follow-Up: ${followUps.length}`);

    // ---- Processar novos leads ----
    for (const deal of leads) {
      const dealId = String(deal.id);
      if (state[dealId]) { console.log(`  [JÁ PROCESSADO] ${deal.title}`); continue; }

      const phone = await getPhone(deal.customer_id);
      if (!phone) { console.log(`  [SEM TELEFONE] ${deal.title}`); continue; }

      const buildingId = deal.building?.[0]?.id;
      const slug = await getBuildingSlug(buildingId);
      const name = deal.title || 'Lead';

      console.log(`  [LEAD] ${name} | ${phone} | ${slug || 'sem imóvel'}`);

      if (!isHorarioComercial()) {
        state[dealId] = {name, phone, slug, ticketId: null, attempts: 0, pendente: true, firstContactAt: Date.now(), lastAttemptAt: Date.now()};
        saveState();
        console.log(`  [AGENDADO] ${name} (fora do horário)`);
        await moveDeal(dealId, CONFIG.apresentame.stepFollowUp);
        await sleep(1500);
        continue;
      }

      const r = await sendWhatsApp(dealId, name, phone, slug);
      if (r.ok) {
        state[dealId] = {name, phone, slug, ticketId: r.ticketId, attempts: 1, pendente: false, firstContactAt: Date.now(), lastAttemptAt: Date.now()};
        saveState();
        await moveDeal(dealId, CONFIG.apresentame.stepFollowUp);
      }
      await sleep(1500);
    }

    // ---- Processar follow-ups ----
    for (const deal of followUps) {
      const dealId = String(deal.id);
      const result = await processFollowUp(dealId);

      if (result.action === 'replied') {
        await moveDeal(dealId, CONFIG.apresentame.stepAtendimento);
        console.log(`  [RESPONDEU] ${deal.title} → Atendimento`);
      } else if (result.action === 'perdido') {
        try {
          const dr = await apGet(`/deals/${dealId}`);
          const d = dr?.data;
          if (d) await apPost('/deals', Object.assign({}, d, {status: 'lost', reason_id: null}));
        } catch {}
        console.log(`  [PERDIDO] ${deal.title}`);
      }

      await sleep(500);
    }

  } catch(e) {
    console.error('[CICLO ERRO]', e.message);
  }

  const prox = new Date(Date.now() + CONFIG.intervaloMinutos * 60000).toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo'});
  console.log(`  Próximo ciclo: ${prox}`);
}

// ---- Utilitário ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Inicialização ----
loadState();
Promise.all([renovarTokenApresentame(), clikLogin()]).then(() => {
  ciclo();
  setInterval(ciclo, CONFIG.intervaloMinutos * 60000);
  // Renova token Apresenta.me a cada 9h (expira em 10h)
  setInterval(() => renovarTokenApresentame().catch(console.error), 9 * 3600000);
}).catch(e => {
  console.error('Falha ao iniciar:', e.message);
  process.exit(1);
});

// Renova token Clikchat a cada 20h
setInterval(() => clikLogin().catch(console.error), 20 * 3600000);

console.log('Robô Sam Dias iniciado. Ctrl+C para encerrar.');
