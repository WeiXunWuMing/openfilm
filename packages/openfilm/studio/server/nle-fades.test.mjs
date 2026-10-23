import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fadeGain, filmHtml } from '../../src/film-doc.mjs';
import { createExports } from './exports.mjs';
import { fadeKeyframes, nleRate, planNleTimeline, xmemlDocument } from './nle.mjs';

const facts = { w: 160, h: 90, duration: 12, fps: 25, hasVideo: true, hasAudio: true, channels: 1, sampleRate: 48000 };
const picture = { id: 'faded', kind: 'video', src: 'Camera Original.mp4', path: '/p/Camera Original.mp4',
  at: 2, end: 4, from: 4, speed: 1, track: 0, hidden: false, faded: true, fade: [0.4, 0.4], facts };
const sound = { id: 'faded', src: picture.src, path: picture.path, at: 2, from: 4, to: 6, speed: 1,
  volume: 0.5, enabled: true, role: 'footage', picture: picture.id, facts, fade: picture.fade };
const plan = (options = {}, p = picture, s = sound) => planNleTimeline({ stage: { w: 160, h: 90 }, duration: 4, pictures: [p], sounds: [s] },
  { title: 'Fades', fps: 25, media: 'copy', mediaDir: '/out', audio: 'clips', nativeFades: true, ...options });

test('native fades retain the complete shared source, trim and links, with ramps in source frame coordinates', () => {
  for (const media of ['copy', 'link']) {
    const timeline = plan({ media }), video = timeline.video[0].clips[0], audio = timeline.audio[0].clips[0];
    assert.equal(timeline.files.length, 1);
    assert.equal(timeline.files[0].job.kind, media);
    assert.equal(timeline.files[0].durationFrames, 300);
    assert.equal(video.fileId, audio.fileId);
    assert.equal(video.linkGroup, audio.linkGroup);
    assert.deepEqual([video.start, video.end, video.in, video.out], [50, 100, 100, 150]);
    assert.deepEqual([audio.start, audio.end, audio.in, audio.out], [50, 100, 100, 150]);
    const xml = xmemlDocument(timeline);
    for (const [parameter, values] of [['opacity', [0, 100, 100, 0]], ['level', [0, 0.5, 0.5, 0]]]) {
      const section = xml.match(new RegExp('<parameterid>' + parameter + '</parameterid>([\\s\\S]*?)</parameter>'))[1];
      const keys = [...section.matchAll(/<keyframe>\s*<when>(\d+)<\/when>\s*<value>([\d.]+)<\/value>/g)].map(k => [Number(k[1]), Number(k[2])]);
      assert.deepEqual(keys, [100, 110, 140, 150].map((when, i) => [when, values[i]]));
      const gain = parameter === 'opacity' ? 100 : 0.5;
      for (let frame = 100; frame < 150; frame++) {
        const i = Math.max(0, keys.findIndex(k => k[0] > frame) - 1), [a, b] = [keys[i], keys[i + 1]];
        const actual = a[1] + (b[1] - a[1]) * (frame - a[0]) / (b[0] - a[0]);
        assert.ok(Math.abs(actual / gain - fadeGain((frame - 100) / 25, 2, picture.fade)) < 1e-6);
      }
    }
  }
});

test('unrepresented effects and other formats keep their render fallback; retimed audio keeps pitch processing', () => {
  for (const [options, clip] of [[{ nativeFades: false }, picture], [{}, { ...picture, styled: true }], [{}, { ...picture, box: { r: 20 } }], [{}, { ...picture, kind: 'page', facts: null }], [{}, { ...picture, fade: undefined }]]) {
    const timeline = plan(options, clip);
    assert.equal(timeline.files.find(f => f.id === timeline.video[0].clips[0].fileId).job.kind, 'render');
    assert.equal(timeline.video[0].clips[0].opacity, undefined);
  }
  const timeline = plan({}, { ...picture, speed: 2 }, { ...sound, speed: 2 });
  assert.equal(timeline.files.find(f => f.id === timeline.video[0].clips[0].fileId).job.kind, 'render', 'combined retiming and opacity keep the render fallback');
  const audio = timeline.audio[0].clips[0], file = timeline.files.find(f => f.id === audio.fileId);
  assert.equal(file.job.kind, 'transcode');
  assert.equal(file.job.segment.speed, 2);
  assert.equal(audio.in, 0);
});

test('a sub-frame fade-in keeps the first picture and sound frame at zero without extending the cut', () => {
  const fade = [1 / 60, 0];
  for (const fps of [24, 25, 29.97]) {
    const timeline = plan({ fps }, { ...picture, fade }, { ...sound, fade });
    const video = timeline.video[0].clips[0], audio = timeline.audio[0].clips[0];
    assert.deepEqual(video.opacity, [{ when: 0, value: 0 }, { when: 1, value: 100 }]);
    assert.deepEqual(audio.levels, [{ when: 0, value: 0 }, { when: 1, value: 0.5 }]);
    assert.equal(video.in, audio.in);
    assert.equal(video.end - video.start, video.out - video.in);
    assert.equal(video.end, audio.end);
    assert.equal(timeline.files.length, 1);
    assert.equal(timeline.files[0].job.kind, 'copy');
    const rate = nleRate(fps);
    assert.deepEqual(fadeKeyframes([0, 0], 1, 1, rate), [{ when: 0, value: 1 }]);
    assert.deepEqual(fadeKeyframes(fade, 1, 1, rate), [{ when: 0, value: 0 }, { when: 1, value: 1 }]);
    assert.deepEqual(fadeKeyframes([1 / 60, 1 / 60], 1, 1, rate), [{ when: 0, value: 0 }, { when: 1, value: 1 }]);
    assert.deepEqual(fadeKeyframes(fade, 0, 1, rate), [{ when: 0, value: 1 }]);
  }
});

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
test('global styles preserve faded picture effects while unrelated CSS keeps native fades and original audio', { skip: !ffmpeg, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'of-nle-css-fades-'));
  const exports = createExports();
  const previous = process.env.OPENFILM_EXPORTS;
  process.env.OPENFILM_EXPORTS = join(root, 'Exports');
  try {
    const source = join(root, 'source.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:size=160x90:rate=25:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-c:v', 'libx264', '-c:a', 'aac', source]);
    await writeFile(join(root, 'look.css'), 'video{filter:grayscale(1);opacity:0.25}');
    const html = filmHtml({ stage: { w: 160, h: 90 }, tracks: [{ clips: [
      { id: 'faded', src: 'source.mp4', time: [4, 6], volume: 0.5, overrides: [{ fade: [0.4, 0.4] }] },
    ] }] });
    const cases = [
      ['inline', '<style>video{filter:grayscale(1);opacity:0.25}</style>', true],
      ['external', '<link rel="stylesheet" href="look.css">', true],
      ['ancestor', '<style>body{filter:grayscale(1);opacity:0.25}</style>', true],
      ['unrelated', '<style>body{font:14px sans-serif}.unused{filter:grayscale(1);opacity:0.25}video{filter:none;opacity:1}</style>', false],
    ];
    for (const [name, style, rendered] of cases) {
      await writeFile(join(root, 'film.html'), html.replace('</head>', style + '\n</head>'));
      const project = { id: 'css-fades', name, path: root };
      const job = exports.start(project, { kind: 'nle', format: 'xml', media: 'copy', audio: 'clips', fps: 25, subtitles: false });
      let done;
      do { await new Promise(r => setTimeout(r, 50)); done = exports.list(project.id).find(j => j.id === job.id); }
      while (!['done', 'failed', 'cancelled'].includes(done.status));
      assert.equal(done.status, 'done', done.error);
      assert.equal(done.framesTotal, rendered ? 50 : 0, name);
      const xml = await readFile(done.out, 'utf8');
      assert.equal([...xml.matchAll(/premiereChannelType="mono"/g)].length, 1, 'the original mono audio still imports once');
      assert.match(xml, /<audiochannel><sourcechannel>1<\/sourcechannel><\/audiochannel>/);
      assert.match(xml, /<outputchannelindex>1<\/outputchannelindex>/);
      assert.match(xml, /<pproTicksIn>1016064000000<\/pproTicksIn>/);
      assert.match(xml, /<parameterid>level<\/parameterid>[\s\S]*?<when>100<\/when>\s*<value>0<\/value>[\s\S]*?<when>110<\/when>\s*<value>0.5<\/value>/);
      assert.deepEqual(await readFile(join(dirname(done.out), 'media', 'source.mp4')), await readFile(source));
      assert.ok(!done.outputs.some(path => /\.wav$/i.test(path)), 'picture fallback must not bake the source audio');
      if (rendered) {
        assert.doesNotMatch(xml, /<effectid>opacity<\/effectid>/, 'the picture fade is baked only once');
        const rgba = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', join(dirname(done.out), 'media', 'faded.mov'), '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-']);
        const pixel = [...rgba.subarray((45 * 160 + 80) * 4, (45 * 160 + 80) * 4 + 4)];
        assert.ok(pixel[3] >= 60 && pixel[3] <= 68, `${name}: preserve 25% opacity: ${pixel}`);
        assert.ok(Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3)) <= 3, `${name}: preserve grayscale: ${pixel}`);
      } else {
        assert.match(xml, /<effectid>opacity<\/effectid>/);
        assert.deepEqual(done.outputs.filter(path => /\.(mov|wav)$/i.test(path)), []);
        assert.equal([...xml.matchAll(/<file id="file-\d+">/g)].length, 1, 'plain fades still share the complete source');
      }
    }
  } finally {
    await exports.stopAll();
    if (previous === undefined) delete process.env.OPENFILM_EXPORTS; else process.env.OPENFILM_EXPORTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit and default XML exports copy or link the full recording for fades without replacement MOV or WAV', { skip: !ffmpeg, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'of-nle-fades-'));
  const exports = createExports();
  const previous = process.env.OPENFILM_EXPORTS;
  process.env.OPENFILM_EXPORTS = join(root, 'Exports');
  try {
    await mkdir(join(root, 'footage'));
    const source = join(root, 'footage', 'Camera Original.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:size=160x90:rate=25:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-c:v', 'libx264', '-c:a', 'aac', source]);
    await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 160, h: 90 }, tracks: [{ clips: [
      { id: 'faded', src: 'footage/Camera Original.mp4', time: [4, 6], volume: 0.5, overrides: [{ fade: [0.4, 0.4] }] },
      { id: 'again', src: 'footage/Camera Original.mp4', time: [8, 10], at: 2 },
    ] }] }));
    for (const media of ['copy', 'link']) for (const format of ['xml', undefined]) {
      const project = { id: 'fades', name: 'Fades', path: root };
      const job = exports.start(project, { kind: 'nle', format, media, audio: 'clips', fps: 25, subtitles: false });
      let done;
      do { await new Promise(r => setTimeout(r, 50)); done = exports.list(project.id).find(j => j.id === job.id); }
      while (!['done', 'failed', 'cancelled'].includes(done.status));
      assert.equal(done.status, 'done', done.error);
      assert.equal(done.framesTotal, 0);
      const xml = await readFile(done.out, 'utf8');
      assert.match(xml, /<sequence id="sequence-1" explodedTracks="true">/);
      assert.match(xml, /<track premiereTrackType="Stereo" currentExplodedTrackIndex="0" totalExplodedTrackCount="1">/);
      assert.equal([...xml.matchAll(/premiereChannelType="mono"/g)].length, 2);
      assert.match(xml, /<audiochannel><sourcechannel>1<\/sourcechannel><\/audiochannel>/);
      assert.match(xml, /<outputchannelindex>1<\/outputchannelindex>/);
      assert.match(xml, /<pproTicksIn>1016064000000<\/pproTicksIn>/);
      assert.match(xml, /<pproTicksOut>1524096000000<\/pproTicksOut>/);
      assert.match(xml, /<effectid>opacity<\/effectid>/);
      assert.match(xml, /<parameterid>level<\/parameterid>/);
      assert.equal([...xml.matchAll(/<file id="file-1">/g)].length, 1);
      assert.doesNotMatch(xml, /<file id="file-2"/);
      assert.match(xml, /<duration>300<\/duration>/);
      assert.match(xml, /<in>100<\/in>\s*<out>150<\/out>/);
      const path = fileURLToPath(new URL(xml.match(/<pathurl>([^<]+)<\/pathurl>/)[1]));
      assert.deepEqual(await readFile(path), await readFile(source));
      if (media === 'link') assert.equal(path, source);
      assert.deepEqual((await readdir(dirname(done.out), { recursive: true })).filter(name => /\.(mov|wav)$/i.test(name)), []);
    }
  } finally {
    await exports.stopAll();
    if (previous === undefined) delete process.env.OPENFILM_EXPORTS; else process.env.OPENFILM_EXPORTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
