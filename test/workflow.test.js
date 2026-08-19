import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

test('daily-news workflow YAML이 유효하고 예약/수동 실행을 제공한다', async () => {
  const source = await readFile(new URL('../.github/workflows/daily-news.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(source);

  assert.equal(workflow.on.schedule[0].cron, '0 9 * * *');
  assert.equal(workflow.on.schedule[0].timezone, 'Asia/Seoul');
  assert.ok('workflow_dispatch' in workflow.on);
  assert.equal(workflow.permissions.contents, 'write');
});
