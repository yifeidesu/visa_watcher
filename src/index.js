import fs from 'node:fs';
import path from 'node:path';

const config = {
  calendarUrl:
    process.env.CALENDAR_URL || 'https://toronto.rsvsys.jp/reservations/calendar',
  calendarAjaxUrl:
    process.env.CALENDAR_AJAX_URL ||
    'https://toronto.rsvsys.jp/ajax/reservations/calendar',
  eventId: toPositiveInt(process.env.EVENT_ID, 16),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  pollIntervalMs: toPositiveInt(process.env.POLL_INTERVAL_MS, 45000),
  requestTimeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 20000),
  monthsAhead: toPositiveInt(process.env.MONTHS_AHEAD, 1),
  planIds: parseCsvInts(process.env.PLAN_IDS || ''),
  dryRun: String(process.env.DRY_RUN || '').toLowerCase() === 'true',
  sendStartupNotice:
    String(process.env.SEND_STARTUP_NOTICE || '').toLowerCase() !== 'false',
  debugCalendarResponse:
    String(process.env.DEBUG_CALENDAR_RESPONSE || '').toLowerCase() === 'true',
  debugCalendarResponseMaxChars: toNonNegativeInt(
    process.env.DEBUG_CALENDAR_RESPONSE_MAX_CHARS,
    3000
  ),
  stateFile: process.env.STATE_FILE || '.watcher-state.json',
};

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function toNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

function parseCsvInts(raw) {
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function loadState(stateFile) {
  try {
    const fullPath = path.resolve(stateFile);
    if (!fs.existsSync(fullPath)) {
      return { seen: {} };
    }
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!data || typeof data !== 'object' || typeof data.seen !== 'object') {
      return { seen: {} };
    }
    return data;
  } catch (error) {
    console.warn(`[${nowIso()}] state load failed: ${error.message}`);
    return { seen: {} };
  }
}

function saveState(stateFile, state) {
  const fullPath = path.resolve(stateFile);
  fs.writeFileSync(fullPath, JSON.stringify(state, null, 2));
}

function extractInputValue(html, name) {
  const pattern = new RegExp(
    `<input[^>]*name=["']${escapeRegExp(name)}["'][^>]*value=["']([^"']*)["'][^>]*>`,
    'i'
  );
  const match = html.match(pattern);
  return match ? decodeHtml(match[1]) : '';
}

function parseSelectedValue(html, name) {
  const hidden = extractInputValue(html, name);
  if (hidden) {
    return hidden;
  }

  const pattern = new RegExp(
    `<input[^>]*name=["']${escapeRegExp(name)}["'][^>]*value=["']([^"']*)["'][^>]*checked=["']checked["'][^>]*>`,
    'i'
  );
  const match = html.match(pattern);
  return match ? decodeHtml(match[1]) : '';
}

function parsePlans(html) {
  const plans = [];
  const regex =
    /<input[^>]*name=["']plan["'][^>]*id=["']plan-(\d+)["'][^>]*>\s*<label[^>]*for=["']plan-\1["'][^>]*>([\s\S]*?)<\/label>/gi;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const id = Number(match[1]);
    const labelRaw = stripTags(match[2]).replace(/\s+/g, ' ').trim();
    if (Number.isInteger(id) && labelRaw) {
      plans.push({ id, label: decodeHtml(labelRaw) });
    }
  }

  return dedupePlans(plans);
}

function dedupePlans(plans) {
  const seen = new Set();
  const out = [];
  for (const p of plans) {
    const key = `${p.id}|${p.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  return out;
}

function parseYearMonth(html, fallbackDate = new Date()) {
  const blockMatch = html.match(
    /<div class=["']date["']>[\s\S]*?(\d{4})年[\s\S]*?<b>(\d{1,2})<\/b>月[\s\S]*?<\/div>/i
  );

  if (!blockMatch) {
    return {
      year: fallbackDate.getFullYear(),
      month: fallbackDate.getMonth() + 1,
    };
  }

  const year = Number(blockMatch[1]);
  const month = Number(blockMatch[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return {
      year: fallbackDate.getFullYear(),
      month: fallbackDate.getMonth() + 1,
    };
  }

  return { year, month };
}

function parseAvailableDates(html, fallbackDate) {
  const { year, month } = parseYearMonth(html, fallbackDate);
  const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  const dates = [];

  let tdMatch;
  while ((tdMatch = tdRegex.exec(html)) !== null) {
    const cell = tdMatch[1];

    // In this calendar, icon_circle.svg indicates a selectable/available slot date.
    if (/icon_circle\.svg/i.test(cell)) {
      const dateMatches = [...cell.matchAll(/data-date=["'](\d{4}\/\d{2}\/\d{2})["']/gi)];
      if (dateMatches.length > 0) {
        for (const m of dateMatches) {
          const iso = rsvDateToIso(m[1]);
          if (iso) {
            dates.push(iso);
          }
        }
        continue;
      }
    }

    // icon_disabled.svg cells should be treated as unavailable.
    if (/icon_disabled\.svg/i.test(cell)) {
      continue;
    }

    // Fallback for other variants where availability is encoded in alt text.
    if (!/Available/i.test(cell) && !/受付中/.test(cell)) {
      continue;
    }

    const dayMatch = cell.match(
      /<div class=["']sc_cal_date(?:[^"']*)["']>\s*(?:<a[^>]*>)?(\d{1,2})(?:<\/a>)?\s*<\/div>/i
    );
    if (!dayMatch) {
      continue;
    }

    const day = Number(dayMatch[1]);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      continue;
    }

    dates.push(toIsoDate(year, month, day));
  }

  return [...new Set(dates)].sort();
}

function rsvDateToIso(raw) {
  const m = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function toIsoDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatRsvDate(dateObj) {
  return `${dateObj.getFullYear()}/${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}`;
}

function addMonths(dateObj, months) {
  const d = new Date(dateObj.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, '');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function getSessionAndInitialHtml() {
  const response = await fetchWithTimeout(config.calendarUrl, {
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0 (visa-slot-watcher)',
      accept: 'text/html,application/xhtml+xml',
    },
  }, config.requestTimeoutMs);

  if (!response.ok) {
    throw new Error(`initial GET failed: ${response.status}`);
  }

  const html = await response.text();
  const cookie = buildCookieHeader(response);
  return { html, cookie };
}

function buildCookieHeader(response) {
  const cookies = [];

  if (typeof response.headers.getSetCookie === 'function') {
    cookies.push(...response.headers.getSetCookie());
  } else {
    const raw = response.headers.get('set-cookie');
    if (raw) {
      cookies.push(raw);
    }
  }

  return cookies
    .map((raw) => raw.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookieHeaders(existingCookie, newCookie) {
  const map = new Map();
  for (const part of `${existingCookie || ''}; ${newCookie || ''}`.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    map.set(k, v);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function selectVisaCategoryContext({ cookie, initialHtml }) {
  const csrfToken = extractInputValue(initialHtml, '_csrfToken');
  const params = new URLSearchParams();
  params.set('_method', 'POST');
  if (csrfToken) params.set('_csrfToken', csrfToken);
  params.set('category', '');
  params.set('event', String(config.eventId));
  params.set('search', 'exec');

  const tryUrls = [config.calendarAjaxUrl, config.calendarUrl];
  let lastError = null;

  for (const url of tryUrls) {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          accept: 'text/html, */*; q=0.01',
          'x-requested-with': 'XMLHttpRequest',
          origin: new URL(config.calendarUrl).origin,
          referer: config.calendarUrl,
          ...(cookie ? { cookie } : {}),
          'user-agent': 'Mozilla/5.0 (visa-slot-watcher)',
        },
        body: params.toString(),
      },
      config.requestTimeoutMs
    );

    const body = await response.text();
    if (!response.ok) {
      const preview = body.slice(0, 300);
      lastError = new Error(
        `category select POST failed via ${url}: ${response.status} body=${preview}`
      );
      continue;
    }

    const html = extractHtmlFromCalendarResponse(body);
    const newCookie = buildCookieHeader(response);
    return {
      html,
      cookie: mergeCookieHeaders(cookie, newCookie),
    };
  }

  throw lastError || new Error('category select POST failed');
}

async function fetchCalendarByPlan({ cookie, csrfToken, tokenFields, tokenUnlocked, planId, date }) {
  const params = new URLSearchParams();
  params.set('_method', 'POST');
  if (csrfToken) params.set('_csrfToken', csrfToken);
  params.set('event', String(config.eventId));
  if (Number.isInteger(planId) && planId > 0) {
    params.set('plan', String(planId));
  }
  params.set('date', formatRsvDate(date));
  params.set('disp_type', 'month');
  params.set('search', 'exec');
  if (tokenFields) params.set('_Token[fields]', tokenFields);
  params.set('_Token[unlocked]', tokenUnlocked || '');

  const response = await fetchWithTimeout(config.calendarAjaxUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'text/html, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      origin: new URL(config.calendarUrl).origin,
      referer: config.calendarUrl,
      ...(cookie ? { cookie } : {}),
      'user-agent': 'Mozilla/5.0 (visa-slot-watcher)',
    },
    body: params.toString(),
  }, config.requestTimeoutMs);

  const body = await response.text();

  if (config.debugCalendarResponse) {
    const preview =
      config.debugCalendarResponseMaxChars === 0
        ? body
        : body.slice(0, config.debugCalendarResponseMaxChars);
    console.log(
      `[${nowIso()}] calendar api debug plan=${planId} date=${formatRsvDate(date)} status=${response.status} body:\n${preview}`
    );
  }

  if (!response.ok) {
    throw new Error(`calendar POST failed for plan ${planId}: ${response.status}`);
  }

  const html = extractHtmlFromCalendarResponse(body);
  return html;
}

function extractHtmlFromCalendarResponse(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) {
    return body;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.html === 'string') {
      return parsed.html;
    }
  } catch (_error) {
    // Fall back to raw body if response is not valid JSON.
  }

  return body;
}

function selectTargetPlans(allPlans) {
  if (config.planIds.length > 0) {
    const wanted = new Set(config.planIds);
    const fromPage = allPlans.filter((plan) => wanted.has(plan.id));
    if (fromPage.length > 0) {
      return fromPage;
    }
    // Fallback: if page parsing fails, still allow explicit PLAN_IDS to drive checks.
    return config.planIds.map((id) => ({ id, label: `Plan ${id}` }));
  }

  // No PLAN_IDS provided: check all plans returned by server.
  return allPlans;
}

function buildAlertText(foundSlots) {
  const lines = [];
  lines.push('Japan visa slot available');
  lines.push('');

  for (const match of foundSlots) {
    lines.push(`Plan: ${match.planLabel} (ID: ${match.planId})`);
    lines.push(`Date: ${match.date}`);
    lines.push('');
  }

  lines.push(`Checked at: ${nowIso()}`);
  lines.push(`URL: ${config.calendarUrl}`);
  return lines.join('\n');
}

async function sendTelegramMessage(text) {
  if (config.dryRun) {
    console.log(`[${nowIso()}] DRY_RUN telegram message:\n${text}`);
    return;
  }

  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required (unless DRY_RUN=true)');
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const chunks = splitForTelegram(text, 3900);

  for (const chunk of chunks) {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    }, config.requestTimeoutMs);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`telegram send failed: ${response.status} ${body}`);
    }
  }
}

function splitForTelegram(text, maxLen) {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (line.length <= maxLen) {
      current = line;
      continue;
    }

    let rest = line;
    while (rest.length > maxLen) {
      chunks.push(rest.slice(0, maxLen));
      rest = rest.slice(maxLen);
    }
    current = rest;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function buildStartupTestText() {
  return [
    'Visa watcher started',
    `Time: ${nowIso()}`,
    `URL: ${config.calendarUrl}`,
  ].join('\n');
}

async function checkOnce(state) {
  const { html: initialHtml, cookie: initialCookie } = await getSessionAndInitialHtml();
  const { html: visaContextHtml, cookie } = await selectVisaCategoryContext({
    cookie: initialCookie,
    initialHtml,
  });

  const csrfToken = extractInputValue(visaContextHtml, '_csrfToken');
  const tokenFields = extractInputValue(visaContextHtml, '_Token[fields]');
  const tokenUnlocked = extractInputValue(visaContextHtml, '_Token[unlocked]');
  const selectedPlanId = Number(parseSelectedValue(visaContextHtml, 'plan'));

  let allPlans = parsePlans(visaContextHtml);
  if (allPlans.length === 0 && Number.isInteger(selectedPlanId) && selectedPlanId > 0) {
    allPlans.push({ id: selectedPlanId, label: `Plan ${selectedPlanId}` });
  }

  // If PLAN_IDS is not set, do an initial request without `plan` to discover all plans
  // currently available in this event/date context.
  if (config.planIds.length === 0) {
    const seedDate = new Date();
    const seedHtml = await fetchCalendarByPlan({
      cookie,
      csrfToken,
      tokenFields,
      tokenUnlocked,
      planId: undefined,
      date: seedDate,
    });
    const discoveredPlans = parsePlans(seedHtml);
    if (discoveredPlans.length > 0) {
      allPlans = dedupePlans(discoveredPlans);
    }
  }
  const targetPlans = selectTargetPlans(allPlans);

  if (targetPlans.length === 0) {
    throw new Error('No plans detected from calendar page.');
  }

  console.log(
    `[${nowIso()}] checking ${targetPlans.length} plan(s): ${targetPlans.map((p) => p.id).join(', ')}`
  );

  const found = [];

  for (const plan of targetPlans) {
    for (let m = 0; m < config.monthsAhead; m += 1) {
      const date = addMonths(new Date(), m);
      const calendarHtml = await fetchCalendarByPlan({
        cookie,
        csrfToken,
        tokenFields,
        tokenUnlocked,
        planId: plan.id,
        date,
      });

      const availableDates = parseAvailableDates(calendarHtml, date);

      for (const slotDate of availableDates) {
        found.push({
          planId: plan.id,
          planLabel: plan.label,
          date: slotDate,
          key: `${plan.id}|${slotDate}`,
        });
      }
    }
  }

  const uniqueFound = dedupeFoundSlots(found);
  if (uniqueFound.length > 0) {
    const text = buildAlertText(uniqueFound);
    await sendTelegramMessage(text);
    console.log(`[${nowIso()}] sent alert for ${uniqueFound.length} available slot(s)`);
  } else {
    console.log(`[${nowIso()}] no new slots`);
  }
}

function dedupeFoundSlots(slots) {
  const byKey = new Map();
  for (const slot of slots) {
    if (!byKey.has(slot.key)) {
      byKey.set(slot.key, slot);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.planId - b.planId;
  });
}

async function main() {
  if (!config.dryRun && (!config.telegramBotToken || !config.telegramChatId)) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  }

  console.log(`[${nowIso()}] watcher started`);
  console.log(
    `[${nowIso()}] poll=${config.pollIntervalMs}ms monthsAhead=${config.monthsAhead} dryRun=${config.dryRun}`
  );

  const state = loadState(config.stateFile);

  if (config.sendStartupNotice) {
    try {
      await sendTelegramMessage(buildStartupTestText());
      console.log(`[${nowIso()}] startup telegram notice sent`);
    } catch (error) {
      console.error(`[${nowIso()}] startup telegram notice failed: ${error.message}`);
    }
  } else {
    console.log(`[${nowIso()}] startup telegram notice disabled`);
  }

  while (true) {
    try {
      await checkOnce(state);
    } catch (error) {
      console.error(`[${nowIso()}] check failed: ${error.message}`);
    }

    await sleep(config.pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(`[${nowIso()}] fatal: ${error.message}`);
  process.exit(1);
});
