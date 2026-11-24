#!/usr/bin/env node
// check.mjs — проверка доступности бесплатных моделей OpenRouter и обновление белого списка.
//
// Зачем: каталог :free меняется. Модель может исчезнуть, начать отдавать пустой ответ
// (reasoning съедает весь бюджет), или появиться что-то заметно лучше. Проверка на старте
// сессии ловит это до того, как агент начнёт «отфутболивать».
//
// Запуск:
//   node tools/free-models/check.mjs                 // полный прогон: каталог + пробы + отчёт
//   node tools/free-models/check.mjs --catalog-only  // только каталог, без запросов к моделям
//   node tools/free-models/check.mjs --json          // машинный вывод
//   node tools/free-models/check.mjs --update       // записать изменения в whitelist.json
//   node tools/free-models/check.mjs --repeats 3 --update   // каждая проба трижды, решение по большинству
//
// Ключ берётся из OmniRoute (storage.sqlite), как и остальные инструменты. Если ключа нет —
// каталог всё равно читается (он публичный), но пробы моделей пропускаются.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WHITELIST = path.join(HERE, 'whitelist.json');
const DB = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const CATALOG = 'https://openrouter.ai/api/v1/models';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const KEYINFO = 'https://openrouter.ai/api/v1/key';

const ARGV = process.argv.slice(2);
const HAS = f => ARGV.includes(f);
const CATALOG_ONLY = HAS('--catalog-only');
const JSON_OUT = HAS('--json');
const DO_UPDATE = HAS('--update');
// Одна проба врёт: 20.11.2026 при одиночном прогоне baidu/ernie (основная 13.11) ушла в EMPTY,
// а particle-1 (EMPTY 13.11) прошла. Поэтому --repeats N повторяет пару проб и решает по большинству.
const REPEATS = (() => {
  const i = ARGV.findIndex(a => a === '--repeats');
  const v = i >= 0 ? parseInt(ARGV[i + 1], 10) : 1;
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5) : 1;
})();

// Промпт-зонд: намеренно такой, чтобы reasoning-модель потратила много скрытых токенов.
// Если модель возвращает content пустым при max_tokens=800 — она непригодна для коротких задач.
const PROBE_SHORT = 'Ответь одним словом: 2+2?';
const PROBE_HARD = 'Ты отвечаешь на сертификационный вопрос. Выбери правильные варианты ТОЛЬКО из списка: '
  + 'какие области применения настраиваются в разделе «Продукты» при складском учёте, серийных номерах и резервировании?';

/* ---------- ключ ---------- */

let KEY = process.env.OPENROUTER_API_KEY || null;
let keySource = KEY ? 'env' : null;

// Настоящий Node.js. `node` из PATH на этой машине — это Electron от Chatbox (v22.x),
// OmniRoute требует >= 22.22.2 и под ним не стартует.
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const OMNI_MJS = 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\omniroute\\bin\\omniroute.mjs';

// Ключ извлечь можно двумя способами:
//  а) прямо из SQLite — работает, пока ключи в provider_connections лежат открытым текстом;
//  б) через `omniroute auth export` — с 15.11.2026, когда включили STORAGE_ENCRYPTION_KEY,
//     в базе лежит только шифротекст `enc:v1:...`, и отправка его в Bearer даёт
//     401 Missing Authentication header (именно на этом инструмент и сломался).
if (!KEY && fs.existsSync(DB)) {
  try {
    const { execFileSync } = await import('node:child_process');
    const py = 'C:\\Users\\User\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';

    if (fs.existsSync(py)) {
      const q = "SELECT api_key FROM provider_connections WHERE provider='openrouter' AND is_active=1 LIMIT 1;";
      const script = `import sqlite3,sys;c=sqlite3.connect('file:${DB.replace(/\\/g, '/')}?mode=ro',uri=True);`
        + `r=c.execute("${q}").fetchone();print(r[0] if r else '')`;
      const out = execFileSync(py, ['-X', 'utf8', '-c', script], { encoding: 'utf8' }).trim();
      if (out && !out.startsWith('enc:v1:')) { KEY = out; keySource = 'storage.sqlite'; }
      else if (out) console.warn('ключ в storage.sqlite зашифрован (enc:v1:) — расшифровываю через omniroute auth export');
    }

    if (!KEY && fs.existsSync(OMNI_MJS)) {
      const nodeExe = fs.existsSync(NODE_EXE) ? NODE_EXE : process.execPath;
      // --force обязателен: без него команда только предупреждает и выходит.
      const raw = execFileSync(nodeExe, [OMNI_MJS, 'auth', 'export', '--force', '--id', 'openrouter', '--format', 'json'],
        { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 24 });
      // CLI печатает перед JSON свои баннеры («📋 Loaded env from …»), а иногда и ANSI-цвета,
      // поэтому JSON вытаскиваем по смещению, а не парсим весь stdout.
      const clean = raw.replace(/\u001b\[[0-9;]*m/g, '');
      let parsed = null;
      for (let i = 0; i < clean.length && !parsed; i++) {
        const ch = clean[i];
        if (ch !== '[' && ch !== '{') continue;
        const close = ch === '[' ? ']' : '}';
        const end = clean.lastIndexOf(close);
        if (end <= i) continue;
        try { parsed = JSON.parse(clean.slice(i, end + 1)); } catch { /* пробуем со следующей позиции */ }
      }
      if (!parsed) throw new Error('не разобрать JSON из вывода auth export');
      const list = Array.isArray(parsed) ? parsed : (parsed.connections || parsed.data || [parsed]);
      const hit = list.find(c => String(c.provider || c.id || '').toLowerCase().includes('openrouter'));
      const k = hit && (hit.apiKey || hit.api_key || hit.key);
      if (hit && hit.apiKeyDecryptFailed === true) {
        console.warn('omniroute auth export: apiKeyDecryptFailed=true — проверь STORAGE_ENCRYPTION_KEY в .omniroute\.env');
      } else if (k && !String(k).startsWith('enc:v1:')) {
        KEY = String(k); keySource = 'omniroute auth export';
      }
    }
  } catch (e) {
    console.warn('не удалось получить ключ OpenRouter:', e.message.split('\n')[0]);
  }
}

/* ---------- утилиты ---------- */

const mask = s => (s ? s.slice(0, 9) + '...' + s.slice(-4) : '—');
const log = s => { if (!JSON_OUT) console.log(s); };
const isReasoning = m => (m.supported_parameters || []).some(p => /reasoning|thinking/i.test(p));

// В каталоге OpenRouter id даётся без префикса провайдера ("baidu/ernie...:free"),
// а в запросе к роутеру и в белом списке — с префиксом ("openrouter/baidu/...:free").
// Приводим к одному виду, иначе сверка показывает, что пропало всё.
const GATEWAY = 'openrouter/';
// Снимаем префикс роутера только если под ним остался настоящий id ("vendor/model").
// У мета-модели id сам по себе "openrouter/free" — её трогать нельзя.
const bare = id => {
  const s = (id || '').replace(/^openrouter\//, '');
  return s.includes('/') ? s : (id || '');
};
const full = id => (id || '').startsWith(GATEWAY) ? id : GATEWAY + (id || '');

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

/* ---------- 1. каталог ---------- */

log('=== 1. Каталог OpenRouter ===');
let catalog;
try {
  catalog = await getJSON(CATALOG, KEY ? { Authorization: `Bearer ${KEY}` } : {});
} catch (e) {
  console.error('не удалось получить каталог:', e.message);
  process.exit(1);
}

const all = catalog.data || [];
const free = all.filter(m => {
  const id = m.id || '';
  const pr = m.pricing || {};
  const zero = v => v === '0' || v === 0 || v === '0.0' || v === 0.0;
  return id.endsWith(':free') || (zero(pr.prompt) && zero(pr.completion));
}).map(m => ({
  id: m.id,
  ctx: m.context_length || null,
  maxOut: (m.top_provider || {}).max_completion_tokens || null,
  reasoning: isReasoning(m),
  outMods: (m.architecture || {}).output_modalities || [],
  params: m.supported_parameters || [],
}));

log(`всего в каталоге: ${all.length}, бесплатных: ${free.length}`);
log(`reasoning среди них: ${free.filter(m => m.reasoning).length}, обычных: ${free.filter(m => !m.reasoning).length}`);

/* ---------- 2. белый список: кто пропал ---------- */

const wl = JSON.parse(fs.readFileSync(WHITELIST, 'utf8'));
// «Новые в каталоге» = те, кого мы ещё не проверяли. Поэтому в known идёт не только
// активная часть списка, но и все снимки прошлых прогонов (verified), иначе
// демотированные модели каждый прогон всплывают как «новые».
const verifiedIds = Object.values(wl.verified || {})
  .flatMap(snap => Object.values(snap || {}))
  .flatMap(b => [...(b.pass || []), ...(b.empty || []), ...(b.fail || [])]);
const known = new Set([
  wl.active?.chat, wl.active?.vision, wl.active?.long_context,
  ...(wl.active?.fallback || []), ...Object.keys(wl.rejected || {}), ...verifiedIds,
].filter(Boolean));

const liveIds = new Set(free.map(m => bare(m.id)));
const vanished = [...known].filter(id => !liveIds.has(bare(id)));
const fresh = free.filter(m => !known.has(full(m.id)));

log('\n=== 2. Сверка с белым списком ===');
log(`в списке: ${known.size}`);
log(`исчезли из каталога: ${vanished.length}`);
vanished.forEach(id => log(`   ✗ ${id}`));
log(`новые в каталоге: ${fresh.length}`);
fresh.forEach(m => log(`   + ${m.id}  ctx=${m.ctx} out=${m.maxOut} ${m.reasoning ? 'reasoning' : ''}`));

/* ---------- 3. пробы ---------- */

async function probe(modelId, prompt, maxTokens, timeoutMs = 90000) {
  const body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  const t0 = Date.now();
  try {
    const r = await fetch(CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: txt.slice(0, 160) };
    const d = JSON.parse(txt);
    const ch = (d.choices || [{}])[0];
    const msg = ch.message || {};
    const u = d.usage || {};
    return {
      ok: true,
      status: 200,
      ms: Date.now() - t0,
      finish: ch.finish_reason,
      contentLen: (msg.content || '').length,
      contentHead: (msg.content || '').slice(0, 60),
      out: u.completion_tokens ?? null,
      reasoning: (u.completion_tokens_details || {}).reasoning_tokens ?? null,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'таймаут' : e.message };
  }
}

const verdict = p => {
  if (!p.ok) return 'FAIL';
  if (p.contentLen === 0) return 'EMPTY';        // ровно та самая «отфутболка»
  if (p.finish === 'length') return 'TRUNCATED';
  return 'OK';
};

const report = [];
if (!CATALOG_ONLY && KEY) {
  log(`\n=== 3. Пробы моделей (ключ: ${mask(KEY)}, источник: ${keySource}) ===`);
  for (const m of free) {
    // Проба не-текстовой модели (аудио/картинки на выходе) стоит денег: в каталоге
    // у таких pricing 0/0, но за запрос реально списывается ~$0.04
    // (13.11.2026: google/lyria-3-pro-preview и lyria-3-clip-preview утекли $0.08 за прогон).
    if (m.outMods.some(x => x !== 'text')) {
      log(`  – ${m.id}  пропущено: не-текстовый выход (${m.outMods.join(', ')})`);
      continue;
    }
    const runs = [];
    for (let a = 0; a < REPEATS; a++) {
      const short = await probe(m.id, PROBE_SHORT, 800, 60000);
      const hard = await probe(m.id, PROBE_HARD, 800, 90000);
      const vShort = verdict(short), vHard = verdict(hard);
      const good = ![vShort, vHard].some(v => v === 'EMPTY' || v === 'FAIL');
      runs.push({ short, hard, vShort, vHard, good });
      if (REPEATS > 1) log(`      попытка ${a + 1}/${REPEATS}: короткий=${vShort} сложный=${vHard}`);
      // большинство уже набрано — не жжём квоту на остальные попытки
      if (runs.filter(r => r.good).length * 2 > REPEATS) break;
    }
    const goodCount = runs.filter(r => r.good).length;
    const usable = goodCount * 2 > REPEATS;             // строгое большинство
    const best = runs.find(r => r.good) || runs[runs.length - 1];
    const { short, hard, vShort, vHard } = best;
    const bad = !usable;
    report.push({
      id: m.id, reasoning: m.reasoning, ctx: m.ctx, maxOut: m.maxOut,
      short: { v: vShort, ...short }, hard: { v: vHard, ...hard },
      usable, good: goodCount, attempts: runs.length, of: REPEATS,
    });
    log(`  ${bad ? '✗' : '✓'} ${m.id}  (годных ${goodCount}/${REPEATS})`);
    log(`      короткий: ${vShort.padEnd(9)} ${short.ok ? `${short.ms}ms out=${short.out} reason=${short.reasoning} ${JSON.stringify(short.contentHead)}` : short.error}`);
    log(`      сложный : ${vHard.padEnd(9)} ${hard.ok ? `${hard.ms}ms out=${hard.out} reason=${hard.reasoning} len=${hard.contentLen}` : hard.error}`);
  }
} else {
  log(`\n=== 3. Пробы пропущены (${CATALOG_ONLY ? '--catalog-only' : 'нет ключа OpenRouter'}) ===`);
}

/* ---------- 4. квота ---------- */

let quota = null;
if (KEY) {
  try {
    const k = await getJSON(KEYINFO, { Authorization: `Bearer ${KEY}` });
    const d = k.data || {};
    quota = d.free_model_daily_requests || null;
    log(`\n=== 4. Квота бесплатных моделей ===`);
    if (quota) {
      log(`   использовано ${quota.used} из ${quota.limit}, осталось ${quota.remaining}`);
    } else {
      log('   квота не сообщается (лимит по ключу не задан)');
    }
  } catch { /* не критично */ }
}

/* ---------- 5. рекомендации ---------- */

const usable = report.filter(r => r.usable);
const recommended = usable
  .filter(r => !r.reasoning || (r.hard.reasoning ?? 0) < 800)
  .sort((a, b) => (b.hard.contentLen || 0) - (a.hard.contentLen || 0));

log('\n=== 5. Рекомендация ===');
if (!report.length) {
  log('   проб нет — судить не о чем');
} else {
  const best = recommended[0] || usable[0];
  if (best) {
    log(`   основная: ${full(best.id)}  (ctx=${best.ctx}, ответ ${best.hard.contentLen ?? 0} симв.)`);
    const fb = usable.filter(r => r.id !== best.id).slice(0, 3).map(r => full(r.id));
    if (fb.length) log(`   фолбэк  : ${fb.join(', ')}`);
  } else {
    log('   ни одна модель не прошла пробы — бесплатные модели недоступны');
  }
}

/* ---------- вывод ---------- */

if (JSON_OUT) {
  console.log(JSON.stringify({ free, vanished, fresh, report, quota, generated: new Date().toISOString() }, null, 2));
}

if (DO_UPDATE) {
  const best = recommended[0];
  if (best) {
    wl.active = wl.active || {};
    // В белом списке id всегда с префиксом роутера (см. full() выше), иначе
    // сверка следующего прогона покажет, что пропало всё.
    wl.active.chat = full(best.id);
    wl.active.fallback = usable.filter(r => r.id !== best.id).slice(0, 3).map(r => full(r.id));
  }
  wl.updated = new Date().toISOString().slice(0, 10);

  // verified: снимок прогона по дате. rejected не трогаем — там формулировки
  // с нюансами (например, про max_tokens), их пишет человек.
  if (report.length) {
    const pass = [], empty = [], fail = [];
    for (const r of report) {
      if (r.usable) pass.push(full(r.id));
      else if (r.hard.v === 'EMPTY' || r.short.v === 'EMPTY') empty.push(full(r.id));
      else fail.push(full(r.id));
    }
    wl.verified = wl.verified || {};
    wl.verified[wl.updated] = {
      'max_tokens=800': {
        note: `check.mjs --repeats ${REPEATS}: годных моделей ${usable.length} из ${report.length}`,
        pass, empty, fail,
      },
    };
  }

  wl.history = wl.history || [];
  wl.history.push({
    date: wl.updated,
    action: 'check',
    vanished,
    added: fresh.map(m => m.id),
    note: `каталог ${free.length} free, моделей проверено ${report.length} (${REPEATS} проб(ы) на модель), годных ${usable.length}`,
  });
  fs.writeFileSync(WHITELIST, JSON.stringify(wl, null, 2) + '\n', 'utf8');
  log('\nwhitelist.json обновлён');
}