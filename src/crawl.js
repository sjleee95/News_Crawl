import * as cheerio from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIME_ZONE = 'Asia/Seoul';

export const PRESSES = [
  { id: '055', name: 'SBS' },
  { id: '015', name: '한국경제' },
  { id: '009', name: '매일경제' },
];

export const SECTIONS = [
  { id: '100', name: '정치' },
  { id: '101', name: '경제' },
  { id: '102', name: '사회' },
  { id: '103', name: '생활/문화' },
  { id: '104', name: '세계' },
  { id: '105', name: 'IT/과학' },
];

const SECTION_ORDER = new Map(SECTIONS.map((section, index) => [section.name, index]));
const ARTICLE_URL_PATTERN = /^https?:\/\/(?:n\.)?news\.naver\.com\/article\/(\d{3})\/(\d+)/i;
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; News_Crawl/1.0; +https://github.com/sjleee95/News_Crawl)',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export function getKoreanDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function normalizeArticleUrl(url, expectedPressId) {
  if (!url) return null;

  let decoded = url.trim().replaceAll('&amp;', '&');
  if (decoded.startsWith('//')) decoded = `https:${decoded}`;
  if (decoded.startsWith('/')) decoded = `https://n.news.naver.com${decoded}`;

  const match = decoded.match(ARTICLE_URL_PATTERN);
  if (!match || (expectedPressId && match[1] !== expectedPressId)) return null;

  return {
    pressId: match[1],
    articleId: match[2],
    key: `${match[1]}/${match[2]}`,
    url: `https://n.news.naver.com/article/${match[1]}/${match[2]}`,
  };
}

export function hasKorean(text) {
  return /[가-힣]/.test(text ?? '');
}

export function getActiveTabName(html) {
  const $ = cheerio.load(html);
  const raw = $('meta[name="nlog"][data-nlog-params]').first().attr('data-nlog-params');
  if (!raw) return null;

  try {
    return JSON.parse(raw).tab_name ?? null;
  } catch {
    return raw.match(/["']?tab_name["']?\s*:\s*["']([^"']+)/)?.[1] ?? null;
  }
}

function cleanTitle(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function parseSectionPage(html, pressId, sectionName) {
  const $ = cheerio.load(html);
  const articles = [];

  $('.press_edit_news_list a.press_edit_news_link[href], .press_edit_news_item a[href]').each((_, element) => {
    const link = normalizeArticleUrl($(element).attr('href'), pressId);
    if (!link) return;

    const title = cleanTitle(
      $(element).find('.press_edit_news_title').first().text()
      || $(element).find('[class*="title"]').first().text()
      || $(element).attr('title')
      || $(element).text(),
    );
    if (!title) return;

    articles.push({ ...link, title, section: sectionName });
  });

  return articles;
}

function formatIsoInKorea(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const item = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${item.year}-${item.month}-${item.day} ${item.hour}:${item.minute}`;
}

export function normalizePublishedAt(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();

  const naverTime = trimmed.match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (naverTime && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const [, year, month, day, hour, minute] = naverTime;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute}`;
  }

  return formatIsoInKorea(trimmed);
}

export function parseArticlePage(html) {
  const $ = cheerio.load(html);
  const candidates = [
    $('._ARTICLE_DATE_TIME[data-date-time]').first().attr('data-date-time'),
    $('.media_end_head_info_datestamp_time[data-date-time]').first().attr('data-date-time'),
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="article:published_time"]').attr('content'),
  ];

  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(script).text());
      const objects = Array.isArray(data) ? data : [data];
      for (const object of objects) {
        if (object?.datePublished) candidates.push(object.datePublished);
        if (Array.isArray(object?.['@graph'])) {
          candidates.push(...object['@graph'].map((item) => item?.datePublished));
        }
      }
    } catch {
      // 다른 JSON-LD 후보와 네이버 data-date-time 속성을 계속 확인한다.
    }
  }

  const publishedAt = candidates.map(normalizePublishedAt).find(Boolean) ?? null;
  const title = cleanTitle(
    $('meta[property="og:title"]').attr('content')
    || $('#title_area').text()
    || $('h2#title_area').text(),
  ).replace(/\s*:\s*네이버 뉴스\s*$/, '');

  return { publishedAt, title: title || null };
}

export async function fetchWithRetry(url, options = {}) {
  const { attempts = 3, timeoutMs = 15_000, fetchImpl = fetch } = options;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  throw new Error(`${url} 요청 실패: ${lastError?.message ?? '알 수 없는 오류'}`);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function makeCsv(rows) {
  const header = ['언론사', '섹션', '발행시각', '제목', 'URL'];
  const lines = [header, ...rows.map((row) => [row.press, row.sections, row.publishedAt, row.title, row.url])];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export async function crawl({ today = getKoreanDate(), fetcher = fetchWithRetry } = {}) {
  console.log(`수집 기준일: ${today} (${TIME_ZONE})`);

  const candidates = new Map();
  const failedSections = [];
  const pressStats = new Map(PRESSES.map((press) => [press.id, {
    press,
    raw: 0,
    unique: 0,
    englishRemoved: 0,
    timeSuccess: 0,
    timeFailure: 0,
    today: 0,
    successfulSections: 0,
  }]));

  for (const press of PRESSES) {
    for (const section of SECTIONS) {
      const listUrl = `https://media.naver.com/press/${press.id}?sid=${section.id}`;
      try {
        const html = await fetcher(listUrl);
        const activeTab = getActiveTabName(html);
        if (activeTab && activeTab !== `section_${section.id}`) {
          throw new Error(`요청한 section_${section.id} 대신 ${activeTab} 응답`);
        }
        const found = parseSectionPage(html, press.id, section.name);
        if (found.length === 0) throw new Error('기사 링크를 찾지 못함 (HTML 구조 확인 필요)');
        const stat = pressStats.get(press.id);
        stat.raw += found.length;
        stat.successfulSections += 1;

        for (const item of found) {
          const existing = candidates.get(item.key);
          if (existing) {
            existing.sections.add(section.name);
            if (!existing.title && item.title) existing.title = item.title;
          } else {
            candidates.set(item.key, {
              ...item,
              press: press.name,
              sections: new Set([section.name]),
            });
          }
        }
      } catch (error) {
        failedSections.push(`${press.name}/${section.name}`);
        console.error(`[목록 실패] ${press.name}/${section.name}: ${error.message}`);
      }
    }
  }

  for (const item of candidates.values()) pressStats.get(item.pressId).unique += 1;

  const koreanCandidates = [];
  for (const item of candidates.values()) {
    if (!hasKorean(item.title)) {
      pressStats.get(item.pressId).englishRemoved += 1;
    } else {
      koreanCandidates.push(item);
    }
  }

  const detailed = await mapWithConcurrency(koreanCandidates, 8, async (item) => {
    const stat = pressStats.get(item.pressId);
    try {
      const html = await fetcher(item.url);
      const detail = parseArticlePage(html);
      if (!detail.publishedAt) {
        stat.timeFailure += 1;
        console.warn(`[발행시각 실패] ${item.url}`);
        return null;
      }
      stat.timeSuccess += 1;
      if (!detail.publishedAt.startsWith(today)) return null;

      const title = detail.title && hasKorean(detail.title) ? detail.title : item.title;
      stat.today += 1;
      return {
        press: item.press,
        pressId: item.pressId,
        articleId: item.articleId,
        sections: [...item.sections]
          .sort((a, b) => SECTION_ORDER.get(a) - SECTION_ORDER.get(b))
          .join('|'),
        publishedAt: detail.publishedAt,
        title,
        url: item.url,
      };
    } catch (error) {
      stat.timeFailure += 1;
      console.warn(`[상세 실패] ${item.url}: ${error.message}`);
      return null;
    }
  });

  const rows = detailed
    .filter(Boolean)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.url.localeCompare(b.url));

  console.log('\n언론사별 결과');
  for (const { id, name } of PRESSES) {
    const stat = pressStats.get(id);
    console.log(
      `- ${name}: 목록 ${stat.raw}건, 중복 제거 후 ${stat.unique}건, `
      + `영문 제거 ${stat.englishRemoved}건, 발행시각 성공/실패 ${stat.timeSuccess}/${stat.timeFailure}건, `
      + `오늘 기사 ${stat.today}건`,
    );
  }
  console.log(`중복 제거 전/후: ${[...pressStats.values()].reduce((sum, stat) => sum + stat.raw, 0)}/${candidates.size}건`);
  console.log(`최종 저장 기사 수: ${rows.length}건`);
  console.log(`실패한 언론사/섹션: ${failedSections.length ? failedSections.join(', ') : '없음'}`);

  const allPressesFailed = [...pressStats.values()].every((stat) => stat.successfulSections === 0);
  if (allPressesFailed) throw new Error('세 언론사의 모든 섹션 수집에 실패했습니다.');
  if (rows.length === 0) throw new Error('최종 결과가 0건입니다. 네이버 HTML 구조 또는 네트워크 상태를 확인하세요.');

  return { rows, pressStats, failedSections, rawCount: [...pressStats.values()].reduce((sum, stat) => sum + stat.raw, 0), uniqueCount: candidates.size };
}

export async function main() {
  const today = getKoreanDate();
  const { rows } = await crawl({ today });
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.join(projectRoot, 'data');
  const outputPath = path.join(dataDir, `${today}.csv`);
  await mkdir(dataDir, { recursive: true });
  await writeFile(outputPath, makeCsv(rows), 'utf8');
  console.log(`CSV 저장 완료: ${outputPath}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`수집 실패: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
