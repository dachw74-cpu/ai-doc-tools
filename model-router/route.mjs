#!/usr/bin/env node
// model-router: единая точка вызовов к api.aiai.by с зафиксированным набором моделей.
// Типы (модель фиксирована, авто-подбор НЕ используется):
//   standard — deepseek-v4-flash   (всё по умолчанию)
//   bigdoc   — ripple-65b          (большие документы целиком, точечная правка)
//   review   — gpt-5.6-luna        (перепроверка артефактов, JSON-вердикт)
//   critical — gpt-5.6-luna        (только по явному запросу пользователя!)
//
// Примеры:
//   node route.mjs --type standard --prompt "Сократи абзац" --attach file.md
//   node route.mjs --type bigdoc --prompt "Поправь таблицу 2.1" --attach big.docx --max-tokens 4000
//   node route.mjs --type review --attach правки.docx --prompt "Сверь нумерацию" --dry-run
//   node route.mjs --introspect    // настройки без сети

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_URL = 'https://api.aiai.by/v1/chat/completions';
const MODELS_URL = 'https://api.aiai.by/v1/models';
const PRICES_CACHE = path.join(HERE, 'models_cache.json');
const LOGS_DIR = path.join(HERE, 'logs');
const PRICES_TTL_MS = 6 * 3600 * 1000;   // обновлять каталог цен не чаще 6 ч
const KEY_FILE = path.join(os.homedir(), '.aiai', 'key.txt');

// ЗАФИКСИРОВАННЫЙ НАБОР — менять только по явному указанию пользователя
const FIXED = {
  standard: { model: 'deepseek-v4-flash',  budget: 3, out: 8192, vision: false },
  bigdoc:   { model: 'ripple-65b',         budget: 3, out: 8192, vision: false },
  review:   { model: 'gpt-5.6-luna',       budget: 8, out: 8192, vision: true },
  critical: { model: 'gpt-5.6-luna',       budget: 8, out: 8192, vision: true },
  vision:   { model: 'gpt-6-luna',        budget: 3, out: 8192, vision: true },
  'vision-econ': { model: 'qwen3.7-flash', budget: 3, out: 8192, vision: true },
  site:     { model: 'qwen3-coder-flash', budget: 3, out: 8192 },
  telegram: { model: 'ling-3.1-flash',    budget: 3, out: 8192 },
  web:      { model: 'gpt-6-luna',        budget: 3, out: 8192, vision: true, web: true },
  prompt:   { model: 'deepseek-v4-flash', budget: 3, out: 8192 },
  script:   { model: 'gpt-6-luna',        budget: 3, out: 8192, vision: true },
  video:    { model: 'qwen3.7-flash',     budget: 3, out: 8192, vision: true },
};

// видео-генерация (отдельный тариф /v1/videos, BYN за секунду, без звука)
const VIDEO_GEN = {
  'kling-v3.0-pro': { perSecNoAudio: 0.569856, seconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], sizes: ['1280x720', '720x1280', '720x720'] },
  'veo-3.1':       { perSecNoAudio: 1.0176,   seconds: [4, 6, 8], sizes: ['1080x1920', '1280x720', '1920x1080', '720x1280', '2160x3840', '3840x2160'] },
};
const DAILY_BUDGET = 5.0;               // BYN в сутки на все вызовы роутера
const MAX_IN_TOKENS = 790_000;          // запас под выход/систему при контексте 1M

const SYSTEM = {
  standard: 'Ты — рабочий ассистент. Выполни задание пользователя по приложенным материалам. Опирайся только на их содержание, ничего не выдумывай. Если просят правку — возвращай точный изменённый фрагмент, а не пересказ.',
  bigdoc: 'Ты работаешь с ПОЛНЫМ текстом документа (передан целиком). Вноси только точечные правки: цитируй точное место, давай замену, не переписывай документ целиком. Отвечай списком правок: [место] -> было -> стало. Если правок нет — так и скажи.',
  review: 'Ты — придирчивый рецензент технической документации. Опирайся ТОЛЬКО на текст артефакта, не выдумывай; каждое замечание привязывай к цитате или номеру раздела. НЕ переписывай документ целиком. Ответ строго в JSON: {"ok": true|false, "issues": [{"severity": "critical|major|minor", "where": "раздел/цитата", "what": "в чём проблема", "fix": "что сделать"}], "summary": "1-2 предложения"}',
  critical: 'Ты — самый строгий эксперт. Критичная проверка: ищи любые противоречия, неточности, пропуски, расхождения с заданием. Каждое замечание — с цитатой и номером раздела. Ответ строго в JSON: {"ok": true|false, "issues": [{"severity": "critical|major|minor", "where": "…", "what": "…", "fix": "…"}], "summary": "…"}',
  vision: 'Ты — аналитик изображений. Внимательно разбери картинки (графики, схемы, скриншоты, таблицы-скрины). Опиши, что на них, извлеки числа/подписи без искажений, ответь на вопросы по содержимому. Если изображение нечитаемо или не хватает данных — так и скажи, не додумывай.',
  'vision-econ': 'Ты — быстрый аналитик изображений. Разбери картинку, извлеки ключевые данные (числа, надписи, структуру), кратко ответь на вопрос. Не додумывай, чего нет на изображении.',
  site: 'Ты — senior-фронтенд/веб-разработчик. Пиши чистый, завершённый код сайтов/страниц (HTML/CSS/JS/React по запросу). Весь проект в контексте — не теряй структуру, правь точечно, не сноси без надобности. Возвращай готовый код целиком для небольших файлов или точные диффы для больших.',
  telegram: 'Ты — ассистент для работы с Telegram. Отвечай кратко и по делу, учитывай контекст переписки (история в чате). Обрабатывай команды, давай короткие ответы для быстрых мессенджер-сессий. Не разворачивай длинные рассуждения.',
  web: 'Ты — ассистент с доступом к поиску в интернете. Если вопрос требует свежих данных — используй поиск, потом отвечай по найденному, указывая источники. Не выдумывай факты; если поиск не дал ответа — так и скажи.',
  prompt: 'Ты — эксперт по промпт-инжинирингу. Перепиши запрос пользователя в чёткий, структурированный промпт для LLM: роль, контекст, задача, требования к формату, критерии качества. Сохрани намерение пользователя, добавь недостающие уточнения. Ответ — только готовый промпт (текстом, без пояснений).',
  script: 'Ты — профессиональный сценарист видео. Составь детальный сценарий: хронометраж, сцены (место/действие), кадры/ракурсы, реплики/закадровый текст, визуальные заметки (как снимать/монтировать). Если дан референс-изображение — опирайся на него. Пиши по-русски, структурированно.',
  video: 'Ты — аналитик видео. Тебе даны кадры (фреймы) из видео. Реконструируй и опиши происходящее: сюжет, сцены, текст на экране, действия. Если кадров мало или они неинформативны — так и скажи, не додумывай.',
};

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.html', '.htm', '.xml', '.log', '.py', '.ps1', '.mjs', '.js', '.yaml', '.yml', '.ini', '.cfg']);
const CHARS_PER_TOKEN = 3.0;            // консервативно для кириллицы

// ---------- helpers ----------
function loadKey() {
  if (process.env.AIAI_API_KEY) return process.env.AIAI_API_KEY.trim();
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  return null;
}

function httpsJson(url, key, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: out.slice(0, 2000) }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function loadPrices() {
  try { return JSON.parse(fs.readFileSync(PRICES_CACHE, 'utf8')); } catch { return {}; }
}
function priceOf(prices, model) {
  const m = prices[model];
  if (!m?.sell_pricing?.chat) return null;
  const p = m.sell_pricing.chat;
  return { in: p.per_1m_input, out: p.per_1m_output, cache: p.per_1m_cached ?? null };
}

async function refreshPrices(key, force) {
  const st = fs.existsSync(PRICES_CACHE) ? fs.statSync(PRICES_CACHE).mtimeMs : 0;
  if (!force && Date.now() - st < PRICES_TTL_MS) return loadPrices();
  try {
    const res = await httpsJson(MODELS_URL, key, null, 30000);
    if (res.status === 200 && Array.isArray(res.json?.data)) {
      const map = {};
      for (const m of res.json.data) map[m.id] = m;
      const tmp = PRICES_CACHE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(map));
      fs.renameSync(tmp, PRICES_CACHE);
      return map;
    }
  } catch { /* сеть недоступна — оставляем старый кэш */ }
  return loadPrices();
}

function logUsage(rec) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  fs.appendFileSync(path.join(LOGS_DIR, `route_${day}.jsonl`), JSON.stringify(rec) + '\n');
}

function dailySpent() {
  const d = new Date().toISOString().slice(0, 10);
  const f = path.join(LOGS_DIR, `route_${d}.jsonl`);
  if (!fs.existsSync(f)) return 0;
  let sum = 0;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (typeof r.cost_byn === 'number') sum += r.cost_byn; } catch {}
  }
  return sum;
}

function readArtifact(p) {
  const ext = path.extname(p).toLowerCase();
  let text;
  if (ext === '.docx') {
    try {
      text = execFileSync('py', ['-3', '-X', 'utf8', path.join(HERE, 'docx_extract.py'), p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      throw new Error(`docx не прочитан (${p}): ${String(e.stderr || e.message).slice(0, 300)}`);
    }
  } else if (TEXT_EXT.has(ext)) {
    text = fs.readFileSync(p, 'utf8');
  } else {
    throw new Error(`Формат ${ext} не поддержан (docx/txt/md/json/csv/html/xml/py/ps1...). Для xlsx/pdf сначала выгрузите текст.`);
  }
  return text;
}

function estimateTokens(chars) { return Math.ceil(chars / CHARS_PER_TOKEN); }

function extractJson(text) {
  text = text.replace(/```(?:json)?/g, '').trim().replace(/^`+|`+$/g, '');
  const m = text.match(/\{.*\}/s);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ---------- main ----------
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);

if (has('--introspect')) {
  const prices = loadPrices();
  const key = loadKey();
  console.log('Ключ:', key ? `${key.slice(0, 5)}…${key.slice(-4)} (len=${key.length})` : 'НЕТ');
  console.log('Каталог цен:', Object.keys(prices).length, 'моделей, кэш в', PRICES_CACHE);
  for (const [t, c] of Object.entries(FIXED)) {
    const p = priceOf(prices, c.model);
    console.log(`  ${t.padEnd(12)} ${c.model.padEnd(18)} вх ${p ? p.in.toFixed(3) : '?'} / вых ${p ? p.out.toFixed(3) : '?'} / кэш ${p && p.cache ? p.cache.toFixed(3) : '?'} BYN/1M${c.vision ? '   [vision]' : ''}`);
  }
  console.log('Дневной лимит:', DAILY_BUDGET, 'BYN | потрачено сегодня:', dailySpent().toFixed(4), 'BYN');
  process.exit(0);
}

const type = arg('--type') || 'standard';
if (!FIXED[type] && type !== 'video-gen') { console.error(`Неизвестный --type: ${type} (standard|bigdoc|review|critical|vision|vision-econ|site|telegram|web|prompt|script|video|video-gen)`); process.exit(1); }
const cfg = FIXED[type];

// --- видео-генерация: отдельный конвейер (не chat) ---
if (type === 'video-gen') {
  const vprompt = arg('--prompt') || (arg('--prompt-file') ? fs.readFileSync(arg('--prompt-file'), 'utf8') : null);
  if (!vprompt) { console.error('Нужен промпт: --prompt'); process.exit(1); }
  const vkey = loadKey();
  if (!vkey) { console.error('Нет ключа: AIAI_API_KEY или ' + KEY_FILE); process.exit(1); }
  const vmodel = arg('--vmodel') || 'kling-v3.0-pro';
  const vg = VIDEO_GEN[vmodel];
  if (!vg) { console.error(`Неизвестная видео-модель --vmodel: ${vmodel} (kling-v3.0-pro|veo-3.1)`); process.exit(1); }
  const seconds = Number(arg('--seconds') || vg.seconds[0]);
  if (!vg.seconds.includes(seconds)) { console.error(`--seconds должен быть одним из: ${vg.seconds.join(', ')}`); process.exit(1); }
  const size = arg('--size') || vg.sizes[0];
  const audio = has('--audio');
  const price = vg.perSecNoAudio * seconds; // без звука
  console.log(`[video-gen] ${vmodel} | ${seconds} сек | ${size}${audio ? ' +audio' : ''} | ~${price.toFixed(2)} BYN`);
  if (has('--dry-run')) { console.log('DRY-RUN: задача не создана. Промпт:', vprompt.slice(0, 200)); process.exit(0); }
  const body = { model: vmodel, seconds, size, prompt: vprompt };
  const createRes = await httpsJson('https://api.aiai.by/v1/videos', vkey, body, 60000);
  if (createRes.status !== 200) { console.error('Ошибка создания:', createRes.status, JSON.stringify(createRes.json || createRes.raw).slice(0, 400)); process.exit(1); }
  const jobId = createRes.json.id;
  console.log('Задача:', jobId, 'статус:', createRes.json.status);
  // опрос
  let final = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await httpsJson('https://api.aiai.by/v1/videos/' + jobId, vkey, null, 60000);
    if (st.status !== 200) { console.log('poll err', st.status); continue; }
    const s = st.json.status;
    console.log(`  ... ${s}`);
    if (s === 'completed') { final = st.json; break; }
    if (s === 'failed' || s === 'error') { console.error('Генерация не удалась:', JSON.stringify(st.json).slice(0, 300)); process.exit(1); }
  }
  if (!final) { console.error('Таймаут ожидания генерации (10 мин). Задача:', jobId, '- проверьте позже GET /v1/videos/' + jobId); process.exit(1); }
  const vurl = final.videos?.[0]?.url;
  if (!vurl) { console.error('Нет URL в ответе:', JSON.stringify(final).slice(0, 400)); process.exit(1); }
  console.log('URL видео:', vurl);
  process.exit(0);
}

let prompt = arg('--prompt');
if (arg('--prompt-file')) prompt = fs.readFileSync(arg('--prompt-file'), 'utf8');
if (!prompt) { console.error('Нужно задание: --prompt или --prompt-file'); process.exit(1); }

const attaches = [];
let ip = 0;
while (args.indexOf('--attach') >= 0) {
  const i = args.indexOf('--attach');
  const p = args[i + 1];
  if (!p) break;
  attaches.push(p);
  args.splice(i, 2);
  if (++ip > 10) break;
}

// картинки: --image file.png (можно несколько)
const images = []; {
  let ii = 0;
  while (args.indexOf('--image') >= 0) {
    const i = args.indexOf('--image');
    const p = args[i + 1];
    if (!p) break;
    images.push(p);
    args.splice(i, 2);
    if (++ii > 8) break;
  }
}
// видео: --video file.mp4 (режется на кадры)
let videos = []; {
  let vi = 0;
  while (args.indexOf('--video') >= 0) {
    const i = args.indexOf('--video');
    const p = args[i + 1];
    if (!p) break;
    videos.push(p);
    args.splice(i, 2);
    if (++vi > 2) break;
  }
}
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const VID_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const FFMpeg = () => {
  // ищем ffmpeg: рядом с роутером (tools/ffmpeg), в PATH, в ms-playwright
  const cand = [
    path.join(HERE, '..', 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg',
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', '.links', 'ffmpeg.exe'),
  ];
  for (const c of cand) { try { if (c === 'ffmpeg') { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } if (fs.existsSync(c)) return c; } catch {} }
  return null;
};
function loadImageB64(p) {
  const ext = path.extname(p).toLowerCase();
  const mime = IMG_MIME[ext];
  if (!mime) throw new Error(`Формат ${ext} не поддержан для --image (png/jpg/jpeg/gif/webp/bmp)`);
  return { mime, b64: fs.readFileSync(p).toString('base64') };
}
function extractFrames(videoPath, maxFrames = 6) {
  // qwen3.7-flash НЕ принимает видео через chat API (проверено 06.11) — режем на кадры
  const ff = FFMpeg();
  if (!ff) throw new Error('ffmpeg не найден — нужен для разбора видео (кадры)');
  const ext = path.extname(videoPath).toLowerCase();
  if (!VID_EXT.has(ext)) throw new Error(`Формат ${ext} не поддержан для --video (mp4/webm/mov/mkv/avi/m4v)`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidframes-'));
  // длительность через ffprobe (обычно рядом с ffmpeg)
  let dur = 0;
  const fprobe = path.join(path.dirname(ff), 'ffprobe.exe');
  const probe = fs.existsSync(fprobe) ? fprobe : 'ffprobe';
  try {
    const raw = execFileSync(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { encoding: 'utf8', timeout: 30000 });
    dur = Math.max(0, parseFloat(raw.trim()));
  } catch {}
  if (!dur) { try { const raw = execFileSync(ff, ['-i', videoPath], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }); const m = raw.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/); if (m) dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]); } catch {} }
  const n = Math.min(maxFrames, Math.max(1, Math.round((dur || 10) / 3)));
  const fps = dur > 0 ? (n / dur) : 0.5;
  execFileSync(ff, ['-y', '-i', videoPath, '-vf', `fps=${fps}`, '-frames:v', String(n), '-q:v', '3', path.join(tmpDir, 'f_%03d.jpg')], { stdio: 'ignore', timeout: 180000 });
  const frames = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jpg')).sort();
  if (!frames.length) throw new Error('Не удалось извлечь кадры из видео (возможно, битый файл или неверный кодек)');
  return frames.map((f) => {
    const p = path.join(tmpDir, f);
    return { mime: 'image/jpeg', b64: fs.readFileSync(p).toString('base64'), file: f, tmp: p };
  });
}

const maxTokens = Number(arg('--max-tokens') || cfg.out);
const temperature = Number(arg('--temperature') || 0);
const timeout = Number(arg('--timeout') || 300) * 1000;

const key = loadKey();
if (!key) { console.error('Нет ключа: AIAI_API_KEY или ' + KEY_FILE); process.exit(1); }

// --- собираем контекст ---
const parts = [prompt];
for (const p of attaches) {
  if (!fs.existsSync(p)) { console.error('Нет файла:', p); process.exit(1); }
  const text = readArtifact(p);
  const maxChars = type === 'bigdoc' ? 3_300_000 : 400_000;
  const body = text.length > maxChars ? text.slice(0, maxChars) + '\n…[обрезано по лимиту]' : text;
  parts.push(`=== АРТЕФАКТ: ${path.basename(p)} ===\n${body}`);
}
const textUser = parts.join('\n\n');

// картинки -> base64
const imgs = [];
for (const p of images) {
  if (!fs.existsSync(p)) { console.error('Нет файла картинки:', p); process.exit(1); }
  try { imgs.push({ file: path.basename(p), ...loadImageB64(p) }); }
  catch (e) { console.error(e.message); process.exit(1); }
}
// видео -> кадры (qwen3.7-flash видео через chat API не принимает, поэтому кадры)
const videoFrames = [];
for (const v of videos) {
  if (!fs.existsSync(v)) { console.error('Нет файла видео:', v); process.exit(1); }
  if (type !== 'video') { console.error('--video работает только с --type video'); process.exit(1); }
  try {
    const fr = extractFrames(v, Number(arg('--frames') || 6));
    videoFrames.push(...fr);
    console.log(`[route] видео ${path.basename(v)} -> ${fr.length} кадров`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
const allImgs = [...imgs, ...videoFrames];
// модель умеет картинки?
if (imgs.length && !cfg.vision) {
  console.error(`Тип ${type} (${cfg.model}) не принимает изображения — только текст. Используйте --type vision или vision-econ.`);
  process.exit(1);
}

const inEst = estimateTokens(textUser.length) + allImgs.reduce((s, im) => s + Math.ceil(im.b64.length / 3 / 780), 0); // грубая оценка: ~1 токен на ~780 байт изображения
if (inEst + maxTokens > MAX_IN_TOKENS) {
  console.error(`Оценка входа ~${inEst.toLocaleString('ru-RU')} токенов + выход ${maxTokens} превышает рабочий контекст (${MAX_IN_TOKENS}). Разбейте документ или уменьшите --max-tokens.`);
  process.exit(1);
}

// --- цены и лимиты ---
const prices = await refreshPrices(key, has('--refresh'));
const price = priceOf(prices, cfg.model);
let estCost = null;
if (price) estCost = (inEst * price.in + maxTokens * price.out) / 1e6;

if (has('--dry-run')) {
  console.log('--- DRY RUN ---');
  console.log('тип:', type, '| модель:', cfg.model, '| файлы:', attaches.length, '| картинки:', allImgs.length);
  if (allImgs.length) for (const im of allImgs.slice(0, 10)) console.log('  image:', im.file, `(${Math.ceil(im.b64.length * 3 / 4).toLocaleString('ru-RU')} байт)`);
  console.log('вход (оценка):', inEst.toLocaleString('ru-RU'), 'токенов | выход (макс):', maxTokens);
  if (price) console.log(`оценочная цена: ${estCost.toFixed(4)} BYN (без кэша)`);
  console.log('цена/1M: вх', price?.in, 'вых', price?.out, 'кэш', price?.cache);
  console.log('промпт (превью):', textUser.slice(0, 300).replace(/\n/g, ' '));
  process.exit(0);
}

if (estCost !== null && estCost > cfg.budget) {
  console.error(`Оценка ${estCost.toFixed(3)} BYN > бюджет типа ${type} (${cfg.budget}). Уменьшите вход/--max-tokens или разбейте документ.`);
  process.exit(1);
}
const spent = dailySpent();
if (spent + (estCost ?? 0) > DAILY_BUDGET) {
  console.error(`Превышение дневного лимита: сегодня уже ${spent.toFixed(3)} BYN, лимит ${DAILY_BUDGET}. Ждите завтра или попросите пользователя поднять лимит.`);
  process.exit(1);
}

// --- вызов ---
let userContent;
if (imgs.length || videoFrames.length) {
  userContent = [{ type: 'text', text: textUser }];
  for (const im of allImgs) userContent.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } });
} else {
  userContent = textUser;
}
const body = {
  model: cfg.model,
  messages: [{ role: 'system', content: SYSTEM[type] }, { role: 'user', content: userContent }],
  max_tokens: maxTokens,
  temperature,
};
if (cfg.web) body.tools = [{ type: 'web_search' }];

console.log(`[route] ${type} -> ${cfg.model} (вход ~${inEst.toLocaleString('ru-RU')} ток.)`);
const t0 = Date.now();
let resp = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    resp = await httpsJson(API_URL, key, body, timeout);
    if (resp.status === 200) break;
    if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
      console.log(`[route] HTTP ${resp.status}, повтор ${attempt}...`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    console.error('HTTP', resp.status, JSON.stringify(resp.json || resp.raw).slice(0, 800));
    process.exit(1);
  } catch (e) {
    if (attempt < 3) { console.log(`[route] сеть: ${e.message}, повтор ${attempt}...`); await new Promise((r) => setTimeout(r, 3000 * attempt)); continue; }
    console.error('Сеть недоступна:', e.message);
    process.exit(1);
  }
}
const sec = (Date.now() - t0) / 1000;

const content = (() => {
  const ch = resp.json?.choices || [];
  // при tools=[web_search] API возвращает несколько choices (шаги поиска/рассуждения);
  // реальный ответ — последний непустой
  for (let i = ch.length - 1; i >= 0; i--) {
    const c = ch[i]?.message?.content;
    if (c && String(c).trim()) return String(c);
  }
  return '';
})();
const lastChoice = (resp.json?.choices || []).slice(-1)[0] || {};
const msg = lastChoice.message || {};
const reasoning = (() => {
  const ch = resp.json?.choices || [];
  for (let i = ch.length - 1; i >= 0; i--) {
    const m = ch[i]?.message || {};
    const r = m.reasoning_content || m.reasoning || (Array.isArray(m.reasoning_details) ? m.reasoning_details.filter(x => x.type === 'reasoning.summary').map(x => x.summary).join('\n') : '');
    if (r) return String(r);
  }
  return '';
})();
const usage = resp.json?.usage || {};
const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
const promptTok = usage.prompt_tokens ?? inEst;
const outTok = usage.completion_tokens ?? 0;
let cost = null;
if (price) cost = (Math.max(promptTok - cached, 0) * price.in + cached * (price.cache ?? price.in) + outTok * price.out) / 1e6;

logUsage({
  ts: new Date().toISOString(), type, model: cfg.model, files: attaches.map(path.basename),
  prompt_tokens: promptTok, cached_tokens: cached, output_tokens: outTok,
  cost_byn: cost, seconds: +sec.toFixed(1), ok: true,
});

if (content) {
  console.log('\n' + content);
} else if (reasoning) {
  console.log('[предупреждение] модель вернула только рассуждение (content пуст). Причина: reasoning-модель израсходовала max_tokens на размышление. Увеличьте --max-tokens или задайте ответ покороче.');
  console.log('--- reasoning (первые 600 симв.) ---');
  console.log(reasoning.slice(0, 600));
}
console.log(`\n--- [route] ${cfg.model} | ${type} | токены: вх ${promptTok} (кэш ${cached}) вых ${outTok} | ${cost !== null ? cost.toFixed(4) + ' BYN' : 'цена неизвестна'} | ${sec.toFixed(1)} c`);

if (type === 'review' || type === 'critical') {
  const v = extractJson(content);
  if (v) {
    console.log('\n=== ВЕРДИКТ ===');
    console.log(v.ok ? 'ЧИСТО' : 'ЕСТЬ ЗАМЕЧАНИЯ');
    for (const [i, iss] of (v.issues || []).entries()) {
      console.log(`  ${i + 1}) [${iss.severity}] ${iss.where} — ${iss.what} → ${iss.fix}`);
    }
    if (v.summary) console.log('итог:', v.summary);
  }
}