import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getActiveTabName,
  hasKorean,
  makeCsv,
  normalizeArticleUrl,
  normalizePublishedAt,
  parseArticlePage,
  parseSectionPage,
} from '../src/crawl.js';

test('기사 URL에서 query를 제거하고 ID 키를 만든다', () => {
  assert.deepEqual(
    normalizeArticleUrl('https://n.news.naver.com/article/009/0005722619?sid=100', '009'),
    {
      pressId: '009',
      articleId: '0005722619',
      key: '009/0005722619',
      url: 'https://n.news.naver.com/article/009/0005722619',
    },
  );
});

test('한글 포함 여부를 제목 전체에서 판단한다', () => {
  assert.equal(hasKorean('Markets rally after Fed remarks'), false);
  assert.equal(hasKorean('美 SEC, 가상자산 맞춤형 규제안 발표'), true);
  assert.equal(hasKorean('KAIST 찾은 구글의 전설'), true);
});

test('섹션 HTML에서 해당 언론사의 기사만 추출한다', () => {
  const html = `
    <ul class="press_edit_news_list">
      <li class="press_edit_news_item">
        <a class="press_edit_news_link" href="https://n.news.naver.com/article/009/0001?sid=101">
          <span class="press_edit_news_title">코스피 상승</span>
        </a>
      </li>
      <li class="press_edit_news_item">
        <a class="press_edit_news_link" href="https://n.news.naver.com/article/015/0002"><span>다른 언론사</span></a>
      </li>
    </ul>`;
  assert.deepEqual(parseSectionPage(html, '009', '경제'), [{
    pressId: '009',
    articleId: '0001',
    key: '009/0001',
    url: 'https://n.news.naver.com/article/009/0001',
    title: '코스피 상승',
    section: '경제',
  }]);
});

test('요청 섹션 대신 홈으로 돌아간 응답을 식별한다', () => {
  const section = '<meta name="nlog" data-nlog-params="{&quot;tab_name&quot;:&quot;section_104&quot;}">';
  const fallback = '<meta name="nlog" data-nlog-params="{&quot;tab_name&quot;:&quot;home&quot;}">';
  assert.equal(getActiveTabName(section), 'section_104');
  assert.equal(getActiveTabName(fallback), 'home');
});

test('상세 HTML에서 네이버 절대 발행시각을 읽는다', () => {
  const html = '<span class="media_end_head_info_datestamp_time _ARTICLE_DATE_TIME" data-date-time="2026-08-19 06:32:10"></span>';
  assert.equal(parseArticlePage(html).publishedAt, '2026-08-19 06:32');
  assert.equal(normalizePublishedAt('2026-08-19T00:32:10+09:00'), '2026-08-19 00:32');
});

test('CSV는 BOM과 CRLF를 사용하고 쉼표/따옴표를 이스케이프한다', () => {
  const csv = makeCsv([{
    press: '매일경제',
    sections: '경제|사회',
    publishedAt: '2026-08-19 09:43',
    title: '코스피, "장 초반" 상승',
    url: 'https://n.news.naver.com/article/009/1',
  }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /"코스피, ""장 초반"" 상승"/);
  assert.ok(csv.endsWith('\r\n'));
});
