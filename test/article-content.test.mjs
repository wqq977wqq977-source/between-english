import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle } from '../server/article.mjs';

const introduction = 'Quantitative analysts build mathematical models to understand market behaviour. They compare their predictions with observations and explain the limits of each model. Careful testing helps them understand where a method is useful and where it may fail.';
const ending = 'Library quantitative analysis: Analysts validate existing models and check that the information remains useful. They communicate their findings clearly so that colleagues can understand both the results and the uncertainty.';
const page = content => `<html><head><title>Working with models</title></head><body><article>${content}</article></body></html>`;
const extract = content => extractArticle(page(content), 'https://example.org/models');

test('publisher recommendations inside the main article do not become reading paragraphs', () => {
  const result = extract(`<section><p>${introduction}</p><h3>Career paths</h3><ul><li>${ending}</li></ul>
    <h3>Additional Resources</h3><p>Continue learning with our professional certification programme.</p>
    <ul><li><a href="/careers">Financial analyst career guide</a></li><li><a href="/courses">Browse all finance courses</a></li></ul></section>`);
  assert.ok(result.text.includes(introduction));
  assert.ok(result.text.includes(ending));
  for (const unwanted of ['Additional Resources', 'certification programme', 'Financial analyst career guide', 'Browse all finance courses']) {
    assert.ok(!result.text.includes(unwanted), unwanted);
  }
  assert.equal(result.wordCount, result.text.split(/\s+/).length);
});

test('consecutive learning recommendations are removed without losing article sections', () => {
  const result = extract(`<div><p>${introduction}</p><p>${ending}</p>
    <h3>Interested in learning more about the Moon?</h3><ul><li><a href="/moon">Learn about the Moon here</a>!</li></ul>
    <h3>Related Resources for Educators</h3><p><a href="/guide">Daily Moon Guide</a><br><a href="/calendar">Make a Moon Calendar</a></p></div>`);
  assert.ok(result.text.includes(ending));
  assert.doesNotMatch(result.text, /Interested in learning|Related Resources|Daily Moon Guide|Moon Calendar/);
});

test('recommendation cleanup stops before the next real section, including nested headings', () => {
  for (const next of [`<h2>Limitations</h2><p>${ending}</p>`, `<section><h2>Limitations</h2><p>${ending}</p></section>`]) {
    const result = extract(`<p>${introduction}</p><h2>Related articles</h2><p><a href="/next">Another article</a></p>${next}`);
    assert.ok(result.text.includes('Limitations'));
    assert.ok(result.text.includes(ending));
    assert.doesNotMatch(result.text, /Another article|Related articles/);
  }
});

test('heading wrappers do not leave their following recommendation links behind', () => {
  const result = extract(`<p>${introduction}</p><p>${ending}</p><div><h3>Read next:</h3></div><p><a href="/next">Another article</a></p>`);
  assert.doesNotMatch(result.text, /Read next|Another article/);
});

test('ordinary links, references, lists, quotations and mentions of resources remain readable', () => {
  const result = extract(`<p>${introduction} An <a href="/orbit">orbit</a> is a curved path.</p>
    <h2>Additional resources in a constrained system</h2><p>The phrase “Additional Resources” can describe the inputs a model needs.</p>
    <ul><li>${ending}</li></ul><blockquote>Recommended reading can be an important part of an education.</blockquote>
    <h2>References</h2><p><a href="/paper">The original research paper</a> supports this conclusion.</p>`);
  for (const kept of ['An orbit is a curved path.', 'Additional resources in a constrained system', 'The phrase “Additional Resources”', ending, 'Recommended reading can be', 'The original research paper supports this conclusion.']) {
    assert.ok(result.text.includes(kept), kept);
  }
});

test('cleanup does not fall back to discarded recommendations when no readable body remains', () => {
  assert.throws(() => extract(`<h2>Additional Resources</h2><p>${introduction}</p><p>${ending}</p><p><a href="/next">Another article</a></p>`), /没有找到完整正文|没有返回可用正文/);
});

test('a matching section name without recommendation links is not enough to delete prose', () => {
  const result = extract(`<p>${introduction}</p><h2>Additional Resources</h2><p>${ending}</p>`);
  assert.ok(result.text.includes('Additional Resources'));
  assert.ok(result.text.includes(ending));
});

test('a resource section with an ordinary inline citation keeps its substantive prose', () => {
  const resources = 'The treatment group received additional resources for six months. The teachers used the materials to provide individual feedback, and the students improved their reading scores. Researchers compared the two groups and discussed the uncertainty in the estimates.';
  const result = extract(`<p>${introduction}</p><h2>Additional Resources</h2><p>${resources} See the <a href="/paper">original research paper</a>.</p><h2>Limitations</h2><p>${ending}</p>`);
  assert.ok(result.text.includes(resources));
  assert.ok(result.text.includes('original research paper'));
  assert.ok(result.text.includes(ending));
});
