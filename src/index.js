import fs from 'node:fs';
import path from 'node:path';

const config = {
  calendarUrl:
    process.env.CALENDAR_URL || 'https://toronto.rsvsys.jp/reservations/calendar',
  calendarAjaxUrl:
    process.env.CALENDAR_AJAX_URL ||
    'https://toronto.rsvsys.jp/ajax/reservations/calendar',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  pollIntervalMs: toPositiveInt(process.env.POLL_INTERVAL_MS, 45000),
  requestTimeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 20000),
  monthsAhead: toPositiveInt(process.env.MONTHS_AHEAD, 1),
  planIds: parseCsvInts(process.env.PLAN_IDS || ''),
  dryRun: String(process.env.DRY_RUN || '').toLowerCase() === 'true',
  stateFile: process.env.STATE_FILE || '.watcher-state.json',
};

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
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

    if (!/Available/i.test(cell) && !/受付中/.test(cell)) {
      continue;
    }

    const dayMatch = cell.match(
      /<div class=["']sc_cal_date(?:[^"']*)["']>(\d{1,2})<\/div>/i
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

async function fetchCalendarByPlan({ cookie, csrfToken, tokenFields, tokenUnlocked, eventId, planId, date }) {
  const params = new URLSearchParams();
  params.set('_method', 'POST');
  if (csrfToken) params.set('_csrfToken', csrfToken);
  params.set('event', String(eventId));
  params.set('plan', String(planId));
  params.set('date', formatRsvDate(date));
  params.set('disp_type', 'month');
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

  if (!response.ok) {
    throw new Error(`calendar POST failed for plan ${planId}: ${response.status}`);
  }

  return await response.text();
}

function selectTargetPlans(allPlans) {
  if (config.planIds.length > 0) {
    const wanted = new Set(config.planIds);
    return allPlans.filter((plan) => wanted.has(plan.id));
  }

  const visaPlans = allPlans.filter((plan) => /visa/i.test(plan.label));
  return visaPlans.length > 0 ? visaPlans : allPlans;
}

function buildAlertText(newMatches) {
  const lines = [];
  lines.push('Japan visa slot available');
  lines.push('');

  for (const match of newMatches) {
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

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      disable_web_page_preview: true,
    }),
  }, config.requestTimeoutMs);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`telegram send failed: ${response.status} ${body}`);
  }
}

function buildStartupTestText() {
  return [
    'Visa watcher started',
    `Time: ${nowIso()}`,
    `URL: ${config.calendarUrl}`,
  ].join('\n');
}

async function checkOnce(state) {
  const { html: initialHtml, cookie } = await getSessionAndInitialHtml();
  const csrfToken = extractInputValue(initialHtml, '_csrfToken');
  const tokenFields = extractInputValue(initialHtml, '_Token[fields]');
  const tokenUnlocked = extractInputValue(initialHtml, '_Token[unlocked]');
  const eventId = Number(parseSelectedValue(initialHtml, 'event') || 16);
  const selectedPlanId = Number(parseSelectedValue(initialHtml, 'plan'));

  const allPlans = parsePlans(initialHtml);
  if (allPlans.length === 0 && Number.isInteger(selectedPlanId) && selectedPlanId > 0) {
    allPlans.push({ id: selectedPlanId, label: `Plan ${selectedPlanId}` });
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
        eventId,
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

  const newMatches = [];
  for (const slot of found) {
    if (!state.seen[slot.key]) {
      state.seen[slot.key] = nowIso();
      newMatches.push(slot);
    }
  }

  if (newMatches.length > 0) {
    const text = buildAlertText(newMatches);
    await sendTelegramMessage(text);
    console.log(`[${nowIso()}] sent alert for ${newMatches.length} new slot(s)`);
    saveState(config.stateFile, state);
  } else {
    console.log(`[${nowIso()}] no new slots`);
  }
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

  try {
    await sendTelegramMessage(buildStartupTestText());
    console.log(`[${nowIso()}] startup telegram notice sent`);
  } catch (error) {
    console.error(`[${nowIso()}] startup telegram notice failed: ${error.message}`);
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
