import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, isValidSlug } from './slug.ts';

test('slugify', () => {
  assert.equal(slugify('你好，世界'), 'ni-hao-shi-jie');
  assert.equal(slugify('从零开发 Blog v2.0！'), 'cong-ling-kai-fa-blog-v2-0');
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('！！！'), '');
  assert.ok(isValidSlug(slugify('重定向 Redirect 测试')));
  assert.ok(!isValidSlug('Bad Slug'));
  assert.ok(!isValidSlug('-a'));
});
