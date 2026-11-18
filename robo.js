'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DIR    = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const HAS_CONFIG_FILE = fs.existsSync(CONFIG_FILE);
const CONFIG = loadConfig();
const STATE_FILE = path.join(DIR, 'robo_processados.json');
const LOG_FILE   = path.join(DIR, 'robo_log.csv');

// RUN_ONCE=1 → executa um único ciclo e encerra (modo Container App Job).
const RUN_ONCE = /^(1|true|sim)$/i.test(process.env.RUN_ONCE || '');
// STATE_BLOB_URL → estado guardado num blob do Azure (identidade gerenciada) em vez de arquivo local.
const STATE_BLOB_URL = process.env.STATE_BLOB_URL || '';

// ---- Configuração: config.json (opcional) + variáveis de ambiente (têm prioridade) ----
function loadConfig() {
  const cfg = HAS_CONFIG_FILE ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.apresentame = cfg.apresentame || {};
  cfg.clikchat = cfg.clikchat || {};
  const env = process.env;
  const str = v => (v === undefined || v === '') ? undefined : v;
  const num = v => (v === undefined || v === '' || Number.isNaN(Number(v))) ? undefined : Number(v);
  const set = (obj, key, val) => { if (val !== undefined) obj[key] = val; };

  set(cfg.apresentame, 'baseUrl',         str(env.APRESENTAME_BASE_URL));
  set(cfg.apresentame, 'email',           str(env.APRESENTAME_EMAIL));
  set(cfg.apresentame, 'password',        str(env.APRESENTAME_PASSWORD));
  set(cfg.apresentame, 'companyId',       num(env.APRESENTAME_COMPANY_ID));
  set(cfg.apresentame, 'stepLead',        num(env.APRESENTAME_STEP_LEAD));
  set(cfg.apresentame, 'stepFollowUp',    num(env.APRESENTAME_STEP_FOLLOWUP));
  set(cfg.apresentame, 'stepAtendimento', num(env.APRESENTAME_STEP_ATENDIMENTO));
  set(cfg.clikchat,    'email',           str(env.CLIKCHAT_EMAIL));
  set(cfg.clikchat,    'password',        str(env.CLIKCHAT_PASSWORD));
  set(cfg.clikchat,    'whatsappId',      num(env.CLIKCHAT_WHATSAPP_ID));
  set(cfg, 'fusoHorario',      num(env.FUSO_HORARIO));
  set(cfg, 'horarioInicio',    num(env.HORARIO_INICIO));
  set(cfg, 'horarioFim',       num(env.HORARIO_FIM));
  set(cfg, 'intervaloMinutos', num(env.INTERVALO_MINUTOS));

  cfg.apresentame.baseUrl = cfg.apresentame.baseUrl || 'https://api.apresenta.me';
  if (cfg.fusoHorario === undefined)      cfg.fusoHorario = -3;
  if (cfg.horarioInicio === undefined)    cfg.horarioInicio = 8;
  if (cfg.horarioFim === undefined)       cfg.horarioFim = 18;
  if (cfg.intervaloMinutos === undefined) cfg.intervaloMinutos = 15;

  const faltando = [
    ['apresentame.email', cfg.apresentame.email], ['apresentame.password', cfg.apresentame.password],
    ['apresentame.stepLead', cfg.apresentame.stepLead], ['apresentame.stepFollowUp', cfg.apresentame.stepFollowUp],
    ['apresentame.stepAtendimento', cfg.apresentame.stepAtendimento],
    ['clikchat.email', cfg.clikchat.email], ['clikchat.password', cfg.clikchat.password],
    ['clikchat.whatsappId', cfg.clikchat.whatsappId]
  ].filter(([, v]) => v === undefined || v === '').map(([k]) => k);
  if (faltando.length) {
    console.error('Configuração incompleta. Faltando: ' + faltando.join(', '));
    process.exit(1);
  }
  return cfg;
}

// ---- Estado ----
let state = {};
let saveChain = Promise.resolve();

async function loadState() {
  if (STATE_BLOB_URL) {
    // Falha ao ler o blob interrompe o ciclo: rodar sem estado reprocessaria leads.
    state = (await blobGetJson())?.deals || {};
    console.log(`[ESTADO] ${Object.keys(state).length} negócios carregados do Blob`);
    return;
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = s.deals || {};
    }
  } catch(e) { console.error('Erro ao carregar estado:', e.message); }
}
function saveState() {
  const json = JSON.stringify({deals: state}, null, 2);
  if (STATE_BLOB_URL) {
    saveChain = saveChain.then(() => blobPutJson(json))
      .catch(e => console.error('Erro ao salvar estado no Blob:', e.message));
    return;
  }
  try { fs.writeFileSync(STATE_FILE, json, 'utf8'); }
  catch(e) { console.error('Erro ao salvar estado:', e.message); }
}

// ---- Azure Blob via identidade gerenciada (Container Apps) ----
let storageToken = null;
let storageTokenExp = 0;
async function getStorageToken() {
  if (storageToken && Date.now() < storageTokenExp - 300000) return storageToken;
  const {IDENTITY_ENDPOINT, IDENTITY_HEADER} = process.env;
  if (!IDENTITY_ENDPOINT || !IDENTITY_HEADER) throw new Error('Identidade gerenciada indisponível (IDENTITY_ENDPOINT/IDENTITY_HEADER)');
  const url = `${IDENTITY_ENDPOINT}?resource=${encodeURIComponent('https://storage.azure.com/')}&api-version=2019-08-01`;
  const r = await request(url, {headers: {'X-IDENTITY-HEADER': IDENTITY_HEADER}});
  if (r.status !== 200 || !r.data?.access_token) throw new Error(`Token de storage falhou (HTTP ${r.status})`);
  storageToken = r.data.access_token;
  storageTokenExp = Number(r.data.expires_on) * 1000 || Date.now() + 3600000;
  return storageToken;
}
async function blobGetJson() {
  const r = await request(STATE_BLOB_URL, {headers: {
    Authorization: 'Bearer ' + await getStorageToken(), 'x-ms-version': '2021-08-06'
  }});
  if (r.status === 404) return null; // primeira execução
  if (r.status !== 200) throw new Error(`Leitura do estado no Blob falhou (HTTP ${r.status})`);
  return typeof r.data === 'string' ? JSON.parse(r.data || '{}') : r.data;
}
async function blobPutJson(json) {
  const r = await request(STATE_BLOB_URL, {method: 'PUT', headers: {
    Authorization: 'Bearer ' + await getStorageToken(), 'x-ms-version': '2021-08-06',
    'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json; charset=utf-8'
  }}, json);
  if (r.status !== 201) throw new Error(`Gravação do estado no Blob falhou (HTTP ${r.status})`);
}
function log(dealId, name, phone, status, ticketId, erro) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  const linha = `${ts},${dealId},${name},${phone},${status},${ticketId||''},${erro||''}`;
  try { fs.appendFileSync(LOG_FILE, linha + '\n', 'utf8'); } catch {}
  console.log(`[${ts}] ${status} | ${name} | ${phone}`);
}
try {
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, 'timestamp,dealId,name,phone,status,ticketId,erro\n', 'utf8');
} catch(e) { console.error('Log CSV indisponível:', e.message); }

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
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (payload) opts.headers = {...opts.headers, 'Content-Length': Buffer.byteLength(payload)};
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve({status: res.statusCode, data: JSON.parse(data)}); }
        catch { resolve({status: res.statusCode, data}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout HTTP: ' + parsed.hostname)));
    if (payload) req.write(payload);
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
  // Persiste no config para sobreviver restart (só no modo serviço com config.json)
  if (HAS_CONFIG_FILE && !RUN_ONCE) {
    CONFIG.apresentame.token = apresentameToken;
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2), 'utf8'); } catch {}
  }
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
  let ok = true;

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
    ok = false;
    console.error('[CICLO ERRO]', e.message);
  }

  if (!RUN_ONCE) {
    const prox = new Date(Date.now() + CONFIG.intervaloMinutos * 60000).toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo'});
    console.log(`  Próximo ciclo: ${prox}`);
  }
  return ok;
}

// ---- Utilitário ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Inicialização ----
async function main() {
  console.log(RUN_ONCE ? 'Robô Sam Dias: execução única.' : 'Robô Sam Dias iniciado. Ctrl+C para encerrar.');
  await loadState();
  await Promise.all([renovarTokenApresentame(), clikLogin()]);

  if (RUN_ONCE) {
    const ok = await ciclo();
    await saveChain; // garante que o estado foi gravado antes de sair
    process.exit(ok ? 0 : 1);
  }

  ciclo();
  setInterval(ciclo, CONFIG.intervaloMinutos * 60000);
  // Renova token Apresenta.me a cada 9h (expira em 10h)
  setInterval(() => renovarTokenApresentame().catch(console.error), 9 * 3600000);
  // Renova token Clikchat a cada 20h
  setInterval(() => clikLogin().catch(console.error), 20 * 3600000);
}

main().catch(e => {
  console.error('Falha ao iniciar:', e.message);
  process.exit(1);
});
