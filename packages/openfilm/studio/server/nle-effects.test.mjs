import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { open } from '../../src/shared.mjs';
import { planNleTimeline } from './nle.mjs';
import { createExports } from './exports.mjs';

const stage = { w: 160, h: 90 };
const look = { fit: 'contain', position: '50% 50%', radius: '0px', opacity: '1', blend: 'normal', clip: 'none', filter: 'none' };
const picture = { id: 'shot', kind: 'video', src: 'take.mp4', path: '/p/take.mp4', at: 0, end: 1, from: 1, speed: 1,
  track: 0, hidden: false, styled: true, look, facts: { ...stage, duration: 4, hasVideo: true } };
const plan = (pictures) => planNleTimeline({ stage, duration: 1, pictures, sounds: [] }, { fps: 25, audio: 'clips', media: 'copy', mediaDir: '/out', title: 'Film' });

test('effect detection preserves plain classes and supported placement while retaining appearance for actual effects', () => {
  for (const box of [undefined, { x: 20, y: 10, w: 80 }]) {
    const timeline = plan([{ ...picture, box }]);
    assert.equal(timeline.files[0].job.kind, 'copy');
    assert.equal(timeline.files[0].durationFrames, 100, 'the full four-second source is kept');
    assert.equal(timeline.video[0].clips[0].in, 25);
  }
  for (const changed of [
    { filter: 'brightness(0.8)' }, { opacity: '0.5' }, { blend: 'multiply' }, { clip: 'circle(50%)' },
    { radius: '8px' }, { extra: true }, { animated: true }, { fit: 'cover' }, { position: '0% 50%' },
  ]) assert.equal(plan([{ ...picture, styled: false, look: { ...look, ...changed } }]).files[0].job.kind, 'render');
  for (const changed of [{ look: undefined }, { faded: true }, { facts: null }, { box: { r: 30 } }]) {
    assert.equal(plan([{ ...picture, ...changed }]).files[0].job.kind, 'render', 'existing unsupported cases still render');
  }
});

test('computed looks distinguish inactive outlines from filters, outlines, animation and inherited effects', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'of-nle-effects-'));
  await writeFile(join(root, 'picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>');
  await writeFile(join(root, 'film.html'), filmHtml({ stage, tracks: [{ clips:
    ['plain', 'placed', 'tinted', 'outlined', 'animated', 'transformed', 'resized', 'shifted', 'concealed', 'absent'].map(id => ({ id, src: 'picture.svg', time: [0, 1], class: id,
      ...(id === 'placed' ? { box: { x: 1.25, y: 2.5, w: 80.333 } } : {}) })),
  }, { attrs: { class: 'tinted' }, clips: [{ id: 'parented', src: 'picture.svg', time: [0, 1] }] }] })
    .replace('</head>', '<style>.plain{outline-width:3px;outline-style:none}.tinted{filter:brightness(.8)}.outlined{outline:3px solid blue}.transformed{transform:scale(.5)!important}.resized{width:80px!important}.shifted{margin-left:10px!important}.concealed{visibility:hidden!important}.absent{display:none}</style></head>'));
  const session = await open(root);
  try {
    await session.film.page.evaluate(() => document.getElementById('animated').animate([{ opacity: .2 }, { opacity: .8 }], { duration: 2000, iterations: Infinity }));
    const spans = await session.film.page.evaluate(() => window.__filmSpans());
    for (const span of spans) {
      const timeline = plan([{ ...picture, look: span.look }]);
      assert.equal(timeline.files[0].job.kind, ['plain', 'placed'].includes(span.id) ? 'copy' : 'render', span.id);
    }
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
test('export probes track styles and only replaces pictures that actually need rendering', { skip: !ffmpeg, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'of-nle-effects-export-'));
  const source = join(root, 'take.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=4', '-c:v', 'libx264', source]);
  await writeFile(join(root, 'film.html'), filmHtml({ stage, tracks: [
    { clips: [{ id: 'plain', src: 'take.mp4', class: 'plain', time: [1, 2] }, { id: 'filtered', src: 'take.mp4', class: 'tinted', time: [2, 3], at: 1 }] },
    { attrs: { class: 'tinted' }, clips: [{ id: 'parented', src: 'take.mp4', time: [3, 4], at: 2 }] },
  ] }).replace('</head>', '<style>.plain{object-fit:contain}.tinted{filter:brightness(.8)}</style></head>'));
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const exports = createExports({ drafts: () => null, onChange: job => { if (['done', 'failed', 'cancelled'].includes(job.status)) finished(job); } });
  try {
    exports.start({ id: 'test', name: 'Effects', path: root }, { kind: 'nle', format: 'jianying', fps: 25, subtitles: false }, { folder: join(root, 'output') });
    const job = await done;
    assert.equal(job.status, 'done', job.error);
    const originals = job.outputs.filter(path => path.endsWith('.mp4'));
    assert.equal(originals.length, 1);
    assert.deepEqual(await readFile(originals[0]), await readFile(source));
    const draft = JSON.parse(await readFile(job.out, 'utf8'));
    const durations = Object.fromEntries(draft.materials.videos.map(m => [m.material_name, m.duration]));
    assert.deepEqual(durations, { 'parented.mov': 1_000_000, 'take.mp4': 4_000_000, 'filtered.mov': 1_000_000 });
  } finally { await exports.stopAll(); await rm(root, { recursive: true, force: true }); }
});
