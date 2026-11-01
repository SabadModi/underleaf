import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { markSource, lineMap, HEADER } from './markdown.js';

const markersIn = (text) => [...text.matchAll(/^\\underleafsrc\{(\d+)\}$/gm)].map((m) => +m[1]);

test('marks each top-level block with its source line', () => {
  const md = '# Intro\n\nFirst paragraph\nstill first.\n\nSecond paragraph.\n';
  const { text } = markSource(md);
  assert.deepEqual(markersIn(text), [1, 3, 6]);
  assert.equal(text.replace(/^\\underleafsrc\{\d+\}\n\n/gm, ''), md);
});

test('leaves YAML front matter, fenced code and raw environments alone', () => {
  const md = [
    '---', 'title: T', '', 'author: A', '---', '', // 1-6
    'Text.', '', // 7-8
    '```', 'code', '', 'col0 inside fence', '```', '', // 9-14
    '\\begin{verbatim}', 'x', '', 'col0 inside verbatim', '\\end{verbatim}', '', // 15-20
    'After.', // 21
  ].join('\n');
  assert.deepEqual(markersIn(markSource(md).text), [7, 9, 15, 21]);
});

test('does not split lists, quotes, captions or definitions', () => {
  const md = [
    '- a', '', '- b', '', '1. one', '', '2. two', '', // 1-8
    'After list.', '', // 9-10
    '> q1', '', '> q2', '', // 11-14
    '| x |', '|---|', '| 1 |', '', ': caption', '', // 15-20
    'Term', '', ':   definition', // 21-23
  ].join('\n');
  assert.deepEqual(markersIn(markSource(md).text), [1, 9, 11, 15, 21]);
});

test('reports the original line of every line it hands to pandoc', () => {
  const { text, origLine } = markSource('One.\n\nTwo.\n');
  const lines = text.split('\n');
  lines.forEach((l, i) => { if (l === 'Two.') assert.equal(origLine(i + 1), 3); });
  assert.equal(origLine(1), 1);
});

test('maps generated LaTeX lines back to Markdown lines and forward again', () => {
  const tex = [
    '\\documentclass{article}', // 1
    '\\begin{document}', // 2
    '\\underleafsrc{3}', // 3
    '', // 4
    '\\section{Intro}\\label{intro}', // 5
    '', // 6
    '\\underleafsrc{5}', // 7
    '', // 8
    'Para one', // 9  <- md 5
    'para two.', // 10 <- md 6
    '', // 11
    '\\underleafsrc{9}', // 12 (block that produced nothing, e.g. a link definition)
    '', // 13
    '\\underleafsrc{11}', // 14
    '', // 15
    'Last.', // 16 <- md 11
    '\\end{document}', // 17
  ].join('\n');
  const map = lineMap(tex, 12);
  assert.equal(map.toMd(1), 1);
  assert.equal(map.toMd(5), 3);
  assert.equal(map.toMd(9), 5);
  assert.equal(map.toMd(10), 6);
  assert.equal(map.toMd(16), 11);
  assert.equal(map.toMd(17), 12); // clamped to the end of the Markdown
  assert.equal(map.toTex(3), 5);
  assert.equal(map.toTex(6), 10);
  assert.equal(map.toTex(7), 10); // blank line after the paragraph stays inside its block
  assert.equal(map.toTex(11), 16);
  assert.equal(map.toTex(1), 5);
});

let pandoc = null;
try { execFileSync('pandoc', ['--version']); pandoc = 'pandoc'; } catch {}

test('round-trips through real pandoc', { skip: !pandoc && 'pandoc not installed' }, () => {
  const md = [
    '---', 'title: Round trip', '---', '', // 1-4
    '# Heading alpha', '', // 5-6
    'Paragraph bravo *emph*', 'continues charlie.', '', // 7-9
    '- item delta', '- item echo', '', // 10-12
    '\\newpage', '', // 13-14
    '```', 'code foxtrot', '```', '', // 15-18
    'Closing golf.', // 19
  ].join('\n');
  const { text } = markSource(md);
  const tex = execFileSync(pandoc, ['-f', 'markdown', '-t', 'latex', '-s', '--wrap=preserve'], { input: text }).toString();
  const map = lineMap(tex, md.split('\n').length);
  const texLines = tex.split('\n');
  const find = (word) => texLines.findIndex((l) => l.includes(word)) + 1;
  assert.equal(map.toMd(find('Heading alpha')), 5);
  assert.equal(map.toMd(find('Paragraph bravo')), 7);
  assert.equal(map.toMd(find('continues charlie')), 8);
  assert.equal(map.toMd(find('code foxtrot')), 16);
  assert.equal(map.toMd(find('Closing golf')), 19);
  assert.equal(map.toTex(8), find('continues charlie'));
  assert.equal(map.toTex(19), find('Closing golf'));
  assert.match(HEADER, /\\providecommand\{\\underleafsrc\}/);
});
