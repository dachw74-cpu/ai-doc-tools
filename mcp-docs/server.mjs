#!/usr/bin/env node
/**
 * agentdocs — MCP-сервер инструментария «Агент» (только чтение).
 *
 * Протокол: MCP over stdio (JSON-RPC 2.0, построчно).
 * Зависимости: только Node.js. Для docx/xlsx/MHTML вызывается Python 3.13 (lxml/openpyxl).
 *
 * Переменные окружения:
 *   AGENT_ROOT      — корень рабочей папки «Агент» (по умолчанию: два уровня выше этого файла)
 *   AGENT_PYTHON    — путь к python.exe (по умолчанию Python 3.13 из AGENTS.md)
 *   AGENTDOCS_DEBUG — 1, чтобы писать отладку в stderr
 *
 * Сервер НИЧЕГО не пишет на диск и не меняет документы.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = process.env.AGENT_ROOT || path.resolve(SERVER_DIR, '..', '..');
const PY = process.env.AGENT_PYTHON || 'C:\\Users\\User\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const PY_SCRIPT = path.join(SERVER_DIR, 'py', 'docs.py');
const DEBUG = process.env.AGENTDOCS_DEBUG === '1';
const SERVER_NAME = 'agentdocs';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOL = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'models', 'голоса', 'pkg',
  '.svn', 'obj', 'bin', '.venv', 'venv', 'dist', 'build', '.cache']);

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.log', '.py', '.ps1', '.mjs', '.cjs',
  '.js', '.ts', '.html', '.htm', '.yml', '.yaml', '.jsonl', '.xml', '.ini', '.cfg', '.cmd', '.bat']);
const DOC_EXT = new Set(['.docx', '.dotx', '.xlsx', '.xlsm', '.pptx', '.pdf', '.doc', '.xls', '.rtf', '.odt']);

function log(...args) { if (DEBUG) process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`); }

function resolveUserPath(p, base = AGENT_ROOT) {
  if (!p) return null;
  const expanded = String(p).replace(/^~[\\/]/, '');
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

function jsonText(obj) {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

/** Чтение JSON-файла с устойчивостью к BOM (PowerShell пишет UTF-8 с BOM). */
async function readJsonSafe(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}
function ok(obj) {
  return { content: [{ type: 'text', text: jsonText(obj) }] };
}
function fail(msg, extra = {}) {
  return { content: [{ type: 'text', text: jsonText({ ok: false, error: msg, ...extra }) }], isError: true };
}

async function* iterFiles(root, maxDepth = 8) {
  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch {
    return;
  }
  if (rootStat.isFile()) {
    yield root;   // корнем может быть и конкретный файл
    return;
  }
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase()) || depth >= maxDepth) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        yield full;
      }
    }
  }
}

async function fileInfo(full) {
  const st = await fsp.stat(full);
  return { full, size: st.size, mtime: st.mtime.toISOString() };
}

async function sha256(full) {
  const h = crypto.createHash('sha256');
  const fh = await fsp.open(full, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

async function isBinary(full) {
  const fh = await fsp.open(full, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
  } catch { return true; } finally { await fh.close(); }
  return false;
}

function runPy(command, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(PY_SCRIPT)) {
      return resolve({ ok: false, error: `Не найден скрипт ${PY_SCRIPT}` });
    }
    const child = spawn(PY, ['-X', 'utf8', PY_SCRIPT, command, JSON.stringify(args ?? {})], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: `Превышен таймаут ${timeoutMs} мс при чтении документа` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `Не удалось запустить Python (${PY}): ${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err.trim()) log('python stderr:', err.trim().slice(0, 1500));
      const raw = out.trim();
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({
          ok: false,
          error: 'Некорректный ответ Python-скрипта',
          exit_code: code,
          raw: raw.slice(0, 1500),
          stderr: err.slice(0, 1500),
        });
      }
    });
  });
}

/* ------------------------------------------------------------------ инструменты */

async function readDocx({ path: p, mode = 'text', max_chars = 200000 }) {
  const full = resolveUserPath(p);
  if (!full) return fail('Не указан path');
  return runPy('docx_text', { path: full, mode, max_chars });
}

async function readXlsx({ path: p, sheet, max_rows = 40, max_cols = 20, formulas = false }) {
  const full = resolveUserPath(p);
  if (!full) return fail('Не указан path');
  return runPy('xlsx_read', { path: full, sheet, max_rows, max_cols, formulas });
}

async function readHtmlExport({ path: p, max_chars = 300000 }) {
  const full = resolveUserPath(p);
  if (!full) return fail('Не указан path');
  return runPy('html_export', { path: full, max_chars });
}

async function docxRevisions({ path: p, limit = 200 }) {
  const full = resolveUserPath(p);
  if (!full) return fail('Не указан path');
  return runPy('docx_revisions', { path: full, limit });
}

async function docxCheck({ path: p, original }) {
  const full = resolveUserPath(p);
  if (!full) return fail('Не указан path');
  return runPy('docx_check', { path: full, original: original ? resolveUserPath(original) : null });
}

async function searchText({ query, roots, regex = false, max_results = 30, context = 1, include, case_sensitive = false }) {
  if (!query || !String(query).trim()) return fail('Не указан query');
  const q = String(query);
  const rootList = (Array.isArray(roots) && roots.length ? roots : [AGENT_ROOT]).map((r) => resolveUserPath(r));
  for (const r of rootList) {
    if (!fs.existsSync(r)) return fail(`Папка не найдена: ${r}`);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  let matcher;
  if (regex) {
    try {
      matcher = new RegExp(q, case_sensitive ? '' : 'i');
    } catch (e) {
      return fail(`Некорректное регулярное выражение: ${e.message}`);
    }
  }
  const extFilter = include
    ? new Set(String(include).split(/[,\s]+/).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
    : TEXT_EXT;

  const matches = [];
  let scanned = 0;
  let truncated = false;
  for (const root of rootList) {
    for await (const full of iterFiles(root, 10)) {
      if (!extFilter.has(path.extname(full).toLowerCase())) continue;
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.size > 3 * 1024 * 1024) continue;
      if (await isBinary(full)) continue;
      scanned++;
      let text;
      try { text = await fsp.readFile(full, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let hit;
        if (regex) {
          hit = matcher.test(line);
        } else {
          const hay = case_sensitive ? line : line.toLowerCase();
          hit = tokens.every((tk) => hay.includes(case_sensitive ? tk : tk.toLowerCase()));
        }
        if (!hit) continue;
        const ctx = [];
        for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
          ctx.push({ line: k + 1, text: lines[k].slice(0, 400) });
        }
        matches.push({ file: path.relative(AGENT_ROOT, full), line: i + 1, text: line.slice(0, 400), context: ctx });
        if (matches.length >= max_results) { truncated = true; break; }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return {
    ok: true,
    query: q,
    regex,
    roots: rootList.map((r) => path.relative(AGENT_ROOT, r) || '.'),
    files_scanned: scanned,
    matches_found: matches.length,
    truncated,
    note: truncated ? `Показаны первые ${max_results} совпадений — сузьте запрос или увеличьте max_results` : undefined,
    matches,
  };
}

async function findFiles({ dir, name_contains, ext, newer_than_days, max_depth = 6, limit = 100, kind = 'all' }) {
  const root = resolveUserPath(dir || AGENT_ROOT);
  if (!fs.existsSync(root)) return fail(`Папка не найдена: ${root}`);
  const extFilter = ext ? String(ext).split(/[,\s]+/).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()) : null;
  const cutoff = newer_than_days ? Date.now() - Number(newer_than_days) * 86400000 : null;
  const out = [];
  for await (const full of iterFiles(root, max_depth)) {
    const e = path.extname(full).toLowerCase();
    if (extFilter && !extFilter.includes(e)) continue;
    if (!extFilter && kind === 'documents' && !DOC_EXT.has(e)) continue;
    if (name_contains && !full.toLowerCase().includes(String(name_contains).toLowerCase())) continue;
    const info = await fileInfo(full);
    if (cutoff && Date.parse(info.mtime) < cutoff) continue;
    out.push({ path: path.relative(AGENT_ROOT, full), size: info.size, mtime: info.mtime });
    if (out.length >= limit * 4) break;
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return {
    ok: true,
    root: path.relative(AGENT_ROOT, root) || '.',
    found: out.length,
    note: out.length >= limit * 4 ? 'Список обрезан — уточните фильтры' : undefined,
    files: out.slice(0, limit),
  };
}

let bpmCache = null;
async function loadBpmSoft() {
  const candidates = [
    path.join(AGENT_ROOT, 'рабочие', 'BPMSoft_сертификация', 'trainer_questions.json'),
    path.join(AGENT_ROOT, 'временные', 'bpmsoft', 'trainer_questions.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      if (bpmCache && bpmCache.file === c) return bpmCache;
      const data = JSON.parse(await fsp.readFile(c, 'utf8'));
      const items = Array.isArray(data) ? data : data.items || [];
      bpmCache = { file: c, items, unclear: (data && data.unclear) || [] };
      return bpmCache;
    }
  }
  return null;
}

function formatQuestion(it) {
  // correct — список индексов (с нуля) верных вариантов
  const correctSet = new Set((Array.isArray(it.correct) ? it.correct : []).map(Number));
  const opts = it.options || [];
  const options = opts.map((o, i) => `${correctSet.has(i) ? '✔' : '·'} ${i + 1}. ${o}`);
  return {
    id: it.id,
    topic: it.topic,
    mode: it.mode === 'choice' ? 'тест (варианты)' : 'карточка (только верные ответы)',
    question: it.question,
    options: opts.length ? options : undefined,
    correct_indexes: [...correctSet],
    correct_texts: [...correctSet].map((i) => opts[i]).filter(Boolean),
    multiple: !!it.multiple,
    source: it.source,
    ref: it.ref,
    note: it.note,
  };
}

async function bpmsoftLookup({ query, id, topic, limit = 5, list_topics = false }) {
  const db = await loadBpmSoft();
  if (!db) return fail('Не найден файл банка вопросов BPMSoft (trainer_questions.json)');
  const items = db.items;
  const topics = {};
  for (const it of items) topics[it.topic || 'без темы'] = (topics[it.topic || 'без темы'] || 0) + 1;

  if (list_topics || (!query && !id && !topic)) {
    return { ok: true, source_file: path.relative(AGENT_ROOT, db.file), total: items.length, topics, hint: 'Укажите query, id (напр. q015) или topic' };
  }
  let picked;
  if (id) {
    picked = items.filter((it) => String(it.id).toLowerCase() === String(id).toLowerCase());
  } else if (topic) {
    const t = String(topic).toLowerCase();
    picked = items.filter((it) => String(it.topic || '').toLowerCase().includes(t));
  } else {
    const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const it of items) {
      const hay = [it.question, ...(it.options || []), it.topic].join(' ').toLowerCase();
      const score = tokens.filter((tk) => hay.includes(tk)).length;
      if (score === tokens.length && score > 0) {
        scored.push({ it, score, pos: hay.indexOf(tokens[0]) });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.pos - b.pos);
    picked = scored.map((s) => s.it);
  }
  return {
    ok: true,
    source_file: path.relative(AGENT_ROOT, db.file),
    total_in_bank: items.length,
    found: picked.length,
    shown: Math.min(picked.length, limit),
    results: picked.slice(0, limit).map(formatQuestion),
  };
}

async function meetingTranscript({ file, tail_lines = 40, list_limit = 6 }) {
  const audioDir = path.join(AGENT_ROOT, 'рабочие', 'аудио');
  if (!fs.existsSync(audioDir)) return fail(`Нет папки аудио: ${audioDir}`);

  // состояние записи
  const state = { recording: false };
  const sessionFile = path.join(audioDir, '.live_session.json');
  const stopFile = path.join(audioDir, 'СТОП');
  if (fs.existsSync(sessionFile)) {
    try {
      const s = await readJsonSafe(sessionFile);
      let alive = false;
      try { process.kill(Number(s.pid), 0); alive = true; } catch { alive = false; }
      state.recording = alive;
      state.pid = s.pid;
      state.session_started = s.started;
      state.video = !!s.video;
      state.out = s.out;
    } catch (e) { state.error = e.message; }
  }
  state.stop_marker_present = fs.existsSync(stopFile);

  const transcripts = [];
  for await (const full of iterFiles(audioDir, 5)) {
    if (path.basename(full).toLowerCase() !== 'transcript.md') continue;
    const info = await fileInfo(full);
    transcripts.push({ path: path.relative(AGENT_ROOT, full), size: info.size, mtime: info.mtime });
  }
  transcripts.sort((a, b) => b.mtime.localeCompare(a.mtime));

  let target = null;
  if (file) target = resolveUserPath(file);
  else if (transcripts.length) target = path.join(AGENT_ROOT, transcripts[0].path);
  if (!target || !fs.existsSync(target)) {
    return { ok: true, status: state, transcripts: transcripts.slice(0, list_limit), warning: 'Расшифровка не найдена' };
  }
  const text = await fsp.readFile(target, 'utf8');
  const lines = text.split(/\r?\n/);
  const speakers = {};
  const turns = [];
  const re = /^\[(\d{2}:\d{2}:\d{2})\]\s*([^:]{1,60}):\s*(.*)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    speakers[m[2].trim()] = (speakers[m[2].trim()] || 0) + 1;
    turns.push({ time: m[1], speaker: m[2].trim(), text: m[3] });
  }
  return {
    ok: true,
    status: state,
    file: path.relative(AGENT_ROOT, target),
    transcripts: transcripts.slice(0, list_limit),
    turns_total: turns.length,
    speakers,
    first_turn: turns[0] || null,
    last_turn: turns[turns.length - 1] || null,
    tail: turns.slice(-tail_lines),
    raw_tail_lines: lines.slice(-Math.min(tail_lines, lines.length)),
  };
}

async function finalsAudit({ dir, manifest, include_hashes = true, limit = 200, max_depth = 4 }) {
  const root = resolveUserPath(dir || path.join(AGENT_ROOT, 'Финальные документы'));
  if (!fs.existsSync(root)) return fail(`Папка не найдена: ${root}`);
  const entries = [];
  for await (const full of iterFiles(root, max_depth)) {
    const info = await fileInfo(full);
    const rec = {
      path: path.relative(root, full),
      size: info.size,
      mtime: info.mtime,
      ext: path.extname(full).toLowerCase(),
    };
    if (include_hashes && info.size < 64 * 1024 * 1024) rec.sha256 = await sha256(full);
    entries.push(rec);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'ru'));

  const result = {
    ok: true,
    root: path.relative(AGENT_ROOT, root) || '.',
    rule: 'Файлы в «Финальные документы» не редактируются: изменения — только новой версией',
    files_total: entries.length,
    total_bytes: entries.reduce((s, e) => s + e.size, 0),
    files: entries.slice(0, limit),
  };
  if (manifest) {
    const mf = resolveUserPath(manifest);
    if (!fs.existsSync(mf)) {
      result.manifest = { path: mf, found: false, hint: 'Манифест не найден. Сохраните вывод этого вызова (поле files) и передайте его путь позже.' };
    } else {
      const data = await readJsonSafe(mf);
      const old = data.files || data;
      const oldMap = new Map();
      if (Array.isArray(old)) for (const e of old) oldMap.set(e.path, e);
      else for (const [k, v] of Object.entries(old)) oldMap.set(k, typeof v === 'string' ? { sha256: v } : v);
      const added = [];
      const changed = [];
      const same = [];
      const cur = new Map(entries.map((e) => [e.path, e]));
      for (const e of entries) {
        const prev = oldMap.get(e.path);
        if (!prev) added.push(e.path);
        else if (prev.sha256 && e.sha256 && prev.sha256 !== e.sha256) {
          changed.push({ path: e.path, sha256_before: prev.sha256.slice(0, 16), sha256_after: e.sha256.slice(0, 16) });
        } else same.push(e.path);
      }
      const removed = [...oldMap.keys()].filter((k) => !cur.has(k));
      result.manifest = {
        path: mf,
        found: true,
        added, changed, removed,
        unchanged: same.length,
        verdict: added.length || changed.length || removed.length ? 'есть расхождения с манифестом' : 'всё совпадает',
      };
    }
  }
  return result;
}

async function searchDocs({ query, k = 8, index_dir, history = false, min_score, lex_min, cos_sure, lex_floor, max_chars = 1200 }) {
  const q = String(query ?? '').trim();
  if (!q) return fail('Не передан query');
  const args = { query: q, k, history: !!history, max_chars };
  if (index_dir) args.index_dir = resolveUserPath(index_dir, AGENT_ROOT);
  if (min_score != null) args.min_score = min_score;
  if (lex_min != null) args.lex_min = lex_min;
  if (cos_sure != null) args.cos_sure = cos_sure;
  if (lex_floor != null) args.lex_floor = lex_floor;
  return runPy('search_docs', args, 300000);
}

async function ragInfo({ index_dir }) {
  const args = {};
  if (index_dir) args.index_dir = resolveUserPath(index_dir, AGENT_ROOT);
  return runPy('rag_info', args);
}

/* ------------------------------------------------------------------ реестр инструментов */
const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

const TOOLS = [
  {
    name: 'read_docx',
    title: 'Прочитать docx',
    description: 'Извлекает текст, заголовки и таблицы из документа Word (.docx/.dotx). Режим outline — только структура. Только чтение.',
    inputSchema: S({ path: str('Путь к .docx (абсолютный или относительно корня «Агент»).'), mode: { type: 'string', enum: ['text', 'outline'], description: 'text — весь текст, outline — только заголовки' }, max_chars: num('Максимум символов текста (по умолчанию 200000)') }, ['path']),
    handler: readDocx,
  },
  {
    name: 'read_xlsx',
    title: 'Прочитать xlsx',
    description: 'Листы, размеры и предпросмотр строк книги Excel (.xlsx/.xlsm). По умолчанию отдаёт вычисленные значения, не формулы.',
    inputSchema: S({ path: str('Путь к .xlsx.'), sheet: str('Имя листа (по умолчанию все листы).'), max_rows: num('Строк предпросмотра (по умолчанию 40)'), max_cols: num('Колонок предпросмотра (по умолчанию 20)'), formulas: bool('true — вернуть формулы вместо значений') }, ['path']),
    handler: readXlsx,
  },
  {
    name: 'read_html_export',
    title: 'Прочитать HTML/MHTML-выгрузку',
    description: 'Разбирает HTML и MHTML-выгрузки (например, экспорт Confluence) в markdown: заголовки, списки, таблицы, зачёркнутые варианты (~~текст~~). Автоматически определяет реальный формат по содержимому.',
    inputSchema: S({ path: str('Путь к файлу (расширение может не соответствовать содержимому).'), max_chars: num('Максимум символов (по умолчанию 300000)') }, ['path']),
    handler: readHtmlExport,
  },
  {
    name: 'docx_revisions',
    title: 'Правки и комментарии docx',
    description: 'Перечисляет отслеженные правки (вставки, удаления, перемещения, изменения формата) и комментарии: автор, дата, текст. Показывает, кто и что менял.',
    inputSchema: S({ path: str('Путь к .docx.'), limit: num('Сколько правок вернуть (по умолчанию 200)') }, ['path']),
    handler: docxRevisions,
  },
  {
    name: 'docx_check',
    title: 'Проверить docx',
    description: 'Быстрая структурная проверка .docx: целостность zip, обязательные части, разбор XML, тип файла, макросы, внешние ссылки, количество необработанных правок и комментариев. Если указан original — построчное сравнение с оригиналом (блоки «добавлено/удалено/заменено»).',
    inputSchema: S({ path: str('Путь к проверяемому .docx.'), original: str('Путь к оригиналу для сравнения (необязательно).') }, ['path']),
    handler: docxCheck,
  },
  {
    name: 'search_text',
    title: 'Поиск по файлам',
    description: 'Поиск по текстовым файлам рабочей папки (md, txt, json, py, ps1, log, csv, html). Без regex все слова запроса должны встречаться в одной строке. Возвращает файл, номер строки и контекст.',
    inputSchema: S({ query: str('Строка или слова для поиска.'), roots: { type: 'array', items: { type: 'string' }, description: 'Папки поиска (по умолчанию вся папка «Агент»).' }, regex: bool('Считать query регулярным выражением'), max_results: num('Максимум совпадений (по умолчанию 30)'), context: num('Строк контекста вокруг совпадения (по умолчанию 1)'), include: str('Список расширений через запятую, напр. md,json'), case_sensitive: bool('Учитывать регистр') }, ['query']),
    handler: searchText,
  },
  {
    name: 'find_files',
    title: 'Найти файлы',
    description: 'Инвентаризация файлов: фильтры по имени, расширению, свежести; сортировка по времени изменения (свежие сверху). kind=documents — только офисные документы.',
    inputSchema: S({ dir: str('Папка поиска (по умолчанию корень «Агент»).'), name_contains: str('Подстрока в пути'), ext: str('Расширения через запятую, напр. docx,xlsx'), newer_than_days: num('Только файлы, изменённые за последние N дней'), max_depth: num('Глубина обхода (по умолчанию 6)'), limit: num('Максимум файлов в ответе (по умолчанию 100)'), kind: { type: 'string', enum: ['all', 'documents'], description: 'documents — только docx/xlsx/pdf/pptx' } }),
    handler: findFiles,
  },
  {
    name: 'bpmsoft_lookup',
    title: 'Банк вопросов BPMSoft',
    description: 'Поиск по банку вопросов сертификации BPMSoft (174 вопроса): по номеру (id), теме или словам. Показывает вопрос, варианты ответов с отметкой верного, тему и источник. Без аргументов отдаёт список тем с количеством вопросов.',
    inputSchema: S({ query: str('Слова для поиска по вопросу и вариантам.'), id: str('Номер вопроса, напр. q015'), topic: str('Тема, напр. «Бизнес-процессы и кейсы»'), limit: num('Сколько результатов вернуть (по умолчанию 5)'), list_topics: bool('Вернуть только список тем') }),
    handler: bpmsoftLookup,
  },
  {
    name: 'meeting_transcript',
    title: 'Расшифровка встречи',
    description: 'Читает живую расшифровку встречи (рабочие\\аудио): идёт ли запись сейчас, список расшифровок, доклады с ролями (говорящий, время, реплика), статистика по говорящим.',
    inputSchema: S({ file: str('Конкретный transcript.md (по умолчанию самый свежий).'), tail_lines: num('Сколько последних реплик вернуть (по умолчанию 40)'), list_limit: num('Сколько расшифровок перечислить (по умолчанию 6)') }),
    handler: meetingTranscript,
  },
  {
    name: 'finals_audit',
    title: 'Аудит «Финальных документов»',
    description: 'Инвентаризация папки «Финальные документы» с размерами, датами и SHA-256. Если передан manifest — сравнивает с ним и показывает добавленные, изменённые и удалённые файлы (контроль правила «оригиналы не правим»).',
    inputSchema: S({ dir: str('Папка (по умолчанию «Агент\\Финальные документы»).'), manifest: str('Путь к JSON-манифесту с полем files (пути + sha256).'), include_hashes: bool('Считать SHA-256 (по умолчанию true)'), limit: num('Максимум файлов в ответе (по умолчанию 200)'), max_depth: num('Глубина обхода (по умолчанию 4)') }),
    handler: finalsAudit,
  },
  {
    name: 'search_docs',
    title: 'Смысловой поиск по документам (RAG)',
    description:
      'Семантический поиск по локальному RAG-индексу боевых документов проекта (docx/xlsx). Поиск гибридный: косинус по эмбеддингам сливается с BM25 (RRF), поэтому находятся и аббревиатуры вроде «МЧД»/«MongoDB», которые один косинус пропускал. Возвращает топ-k фрагментов с точной ссылкой (файл, лист/абзацы), смысловой близостью (score) и лексическим покрытием с весами IDF (lex — какая доля веса содержательных терминов запроса реально найдена во фрагменте: служебные слова весят мало, редкие — много). Текст фрагмента обрезается до max_chars, при необходимости окно сдвигается к совпадению, поэтому совпадение всегда видно. Поле answer_found=false и warning означают, что прямого ответа в документах, скорее всего, НЕТ — тогда отвечать «не найдено», а не выдумывать. По умолчанию ищет только по актуальным документам (primary); history=true добавляет черновики и бэкапы. Индекс должен быть собран заранее (rag_info покажет состояние).',
    inputSchema: S({
      query: str('Вопрос или фраза на естественном языке.'),
      k: num('Сколько фрагментов вернуть (по умолчанию 8).'),
      history: bool('true — искать и по черновикам/бэкапам (по умолчанию только актуальные документы).'),
      index_dir: str('Папка индекса (по умолчанию рабочие\\rag_эп\\index).'),
      min_score: num('Минимальный косинус (по умолчанию 0.30) — только для запросов без содержательных терминов.'),
      lex_min: num('Порог лексического покрытия с весами IDF (по умолчанию 0.40).'),
      cos_sure: num('Уверенный косинус: ответ считается найденным при лексической опоре не ниже lex_floor (по умолчанию 0.44).'),
      lex_floor: num('Минимальная лексическая опора, без которой уверенный косинус не принимается (по умолчанию 0.30).'),
      max_chars: num('Максимум символов текста на фрагмент (по умолчанию 1200).'),
    }, ['query']),
    handler: searchDocs,
  },
  {
    name: 'rag_info',
    title: 'Состояние RAG-индекса',
    description:
      'Состояние локального RAG-индекса: когда собран, какая модель эмбеддингов и размерность, сколько чанков, список актуальных (primary) файлов, сколько дублей пропущено по содержимому. Без аргументов — индекс по боевым документам ЭП.',
    inputSchema: S({ index_dir: str('Папка индекса (по умолчанию рабочие\\rag_эп\\index).') }),
    handler: ragInfo,
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------------ MCP */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function pickProtocol(requested) {
  if (requested && SUPPORTED_PROTOCOL.includes(requested)) return requested;
  return SUPPORTED_PROTOCOL[0];
}

const INSTRUCTIONS = [
  'Инструменты рабочей папки «Агент» (проект корпоративной документации).',
  'Все инструменты только читают: они не меняют документы и не пишут файлы.',
  'Правило проекта: файлы в «Финальные документы» не редактируются — новые версии создаются отдельными файлами.',
  'Порядок работы с документом: find_files → read_docx/read_xlsx/read_html_export → при сомнениях docx_check (целостность, правки, сравнение с оригиналом).',
  'При правках автором в документах указывается «Андрей Демьянко».',
  'Пути можно указывать абсолютные или относительно корня рабочей папки «Агент».',
].join('\n');

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: pickProtocol(requested),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'Документы Агента (только чтение)', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          })),
        },
      });
    }
    if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
    if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = TOOL_MAP.get(name);
      if (!tool) {
        return send({ jsonrpc: '2.0', id, result: fail(`Неизвестный инструмент: ${name}`, { available: [...TOOL_MAP.keys()] }) });
      }
      let out;
      try {
        out = await tool.handler(args);
      } catch (e) {
        out = fail(`${e.name}: ${e.message}`, { stack: String(e.stack).split('\n').slice(0, 3) });
      }
      const text = out && out.content && out.content[0] ? out.content[0].text : JSON.stringify(out, null, 2);
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: safeParse(text),
          isError: !!(out && out.isError),
        },
      });
    }
    if (isNotification) return;
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Метод не поддерживается: ${method}` } });
  } catch (e) {
    if (isNotification) return;
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: `${e.name}: ${e.message}` } });
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Некорректный JSON: ${e.message}` } });
      continue;
    }
    handleMessage(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => { log('uncaught', e.message); });
if (DEBUG) log('старт: AGENT_ROOT=' + AGENT_ROOT);
