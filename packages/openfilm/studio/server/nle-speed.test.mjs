import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { planNleTimeline, xmemlDocument } from './nle.mjs';
import { fcpxmlDocument } from './fcpxml.mjs';
import { jianyingDraft } from './jianying.mjs';
import { createExports } from './exports.mjs';

const stage = { w: 160, h: 90 };
const facts = { ...stage, duration: 12, hasVideo: true, hasAudio: true, channels: 1, sampleRate: 48000 };
function plan({ speed = 1.5, frames = 7, from = 2, fps = 25, ...options } = {}) {
  const picture = { id: 'shot', kind: 'video', src: 'take.mp4', path: '/p/take.mp4', at: 0, end: frames / fps, from, speed,
    track: 0, hidden: false, facts };
  return planNleTimeline({ stage, duration: frames / fps, pictures: [picture], sounds: [{ ...picture, picture: 'shot',
    to: from + frames / fps * speed, enabled: true, role: 'footage', volume: 0.5 }] },
  { title: 'Speed', fps, media: 'copy', mediaDir: '/out', audio: 'clips', ...options });
}
const seconds = value => { const [n, d = 1] = value.replace(/s$/, '').split('/').map(Number); return n / d; };

test('rounding at the end of a source keeps file durations integral for FCPXML', () => {
  const timeline = plan({ speed: 1.5, frames: 20 / 3, from: 290 / 25 });
  assert.ok(timeline.files.every(file => Number.isInteger(file.durationFrames)));
  assert.doesNotMatch(fcpxmlDocument(timeline), /\d+\.\d+\/\d+s/);
  assert.equal(timeline.video[0].clips[0].speed, 1.5);
  assert.equal(timeline.video[0].clips[0].end, 7);
  const short = plan({ speed: 10, frames: 0.5, from: 11.8 });
  const clip = short.video[0].clips[0];
  assert.equal(clip.end - clip.start, 1, 'a half-frame cut rounded up must not disappear');
  assert.equal(short.files.find(file => file.id === clip.fileId).job.kind, 'render');
});

test('short clips keep their own speed and fractional source frames; audio keeps the pitch-preserving render', () => {
  for (const speed of [1.5, 0.7, 0.607843137, 2]) {
    const timeline = plan({ speed });
    const video = timeline.video[0].clips[0], audio = timeline.audio[0].clips[0];
    assert.equal(video.speed, speed);
    assert.equal(video.end - video.start, 7);
    assert.ok(Math.abs((video.out - video.in) / 7 - speed) < 1e-12);
    assert.equal(timeline.files.find(f => f.id === video.fileId).durationFrames, 300);
    const sound = timeline.files.find(f => f.id === audio.fileId);
    assert.equal(sound.job.kind, 'transcode');
    assert.equal(sound.job.segment.speed, speed);
    assert.equal(sound.job.segment.seconds, 7 / 25);
    assert.equal(audio.speed, undefined, 'the rendered sound is played once at normal speed');
    assert.notEqual(audio.fileId, video.fileId);
    for (const app of ['jianying', 'capcut']) {
      const { info } = jianyingDraft(timeline, { app, name: 'Speed', folder: '/out', root: '/' });
      const clip = info.tracks[0].segments[0];
      assert.equal(clip.speed, speed);
      assert.equal(info.materials.speeds.find(s => clip.extra_material_refs.includes(s.id)).speed, speed);
      assert.equal(clip.source_timerange.duration, Math.round(7 / 25 * speed * 1e6));
      assert.equal(clip.volume, 0, 'the unprocessed recording must not play beside its rendered audio');
      assert.equal(info.tracks.filter(t => t.type === 'audio').length, 1);
    }
  }
});

test('Premiere retains both boundary and trim flags when retiming starts or ends at the source boundary', () => {
  for (const frames of [7, 200]) {
    const xml = xmemlDocument(plan({ from: 0, frames }));
    const video = xml.match(/<clipitem id="clipitem-1">[\s\S]*?<\/clipitem>/)[0];
    assert.match(video, /<parameterid>speed<\/parameterid><name>speed<\/name><value>150<\/value>/);
    assert.match(video, /<keyframe><when>0<\/when><value>0<\/value><speedkfstart>TRUE<\/speedkfstart><speedkfin>TRUE<\/speedkfin><\/keyframe>/);
    if (frames === 200) assert.match(video, /<speedkfend>TRUE<\/speedkfend><speedkfout>TRUE<\/speedkfout>/);
    const ticks = Number(video.match(/<pproTicksOut>(\d+)<\/pproTicksOut>/)[1]);
    assert.equal(ticks, Math.round(frames * 1.5 / 25 * 254016000000));
    const audio = xml.match(/<clipitem id="clipitem-2">[\s\S]*?<\/clipitem>/)[0];
    assert.ok(!audio.includes('<effectid>timeremap</effectid>'), 'the separate sound retains its rendered pitch');
  }
});

test('FCP time maps cover the whole recording at the original speed, including handles on both sides', () => {
  for (const fps of [25, 30000 / 1001]) for (const speed of [0.5, 1.5, 0.607843137]) {
    const timeline = plan({ fps, speed, audioTracks: 'source' });
    const xml = fcpxmlDocument(timeline);
    const video = xml.match(/<video ref=[\s\S]*?<\/video>/)[0];
    const points = [...video.matchAll(/<timept time="([^"]+)" value="([^"]+)"/g)].map(m => [seconds(m[1]), seconds(m[2])]);
    assert.deepEqual(points[0], [0, 0]);
    const duration = timeline.files.find(f => f.video).durationFrames / timeline.rate.fps;
    assert.equal(points[1][1], duration, 'the map ends at the full recording, not the selected out-point');
    assert.ok(Math.abs(points[1][1] / points[1][0] - speed) < 1e-9);
    const start = seconds(video.match(/ start="([^"]+)"/)[1]);
    const clip = timeline.video[0].clips[0];
    assert.ok(Math.abs(start * speed - clip.in / timeline.rate.fps) < 1e-8);
    assert.ok(start > 0 && points[1][0] > start + 7 / timeline.rate.fps, 'both source handles remain available');
    assert.match(xml, /<\/video>\s*<audio /, 'rendered audio is outside the time-mapped video');
    for (const m of video.matchAll(/(?:time|value|start|offset|duration)="([^\"]+s)"/g)) {
      assert.match(m[1], /^\d+(?:\/\d+)?s$/, 'FCP rational times contain integer components');
      const denominator = Number(m[1].replace(/s$/, '').split('/')[1] ?? 1);
      assert.ok(denominator <= 0xffffffff);
    }
  }
});

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
test('all editors keep the full video and a 150% seven-frame cut while its audio retains 440 Hz pitch', { skip: !ffmpeg, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'of-nle-speed-'));
  const source = join(root, 'take.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source]);
  await writeFile(join(root, 'film.html'), filmHtml({ stage, tracks: [{ clips: [{ id: 'shot', src: 'take.mp4', time: [1, 1.42], speed: 1.5 }] }] }));
  try {
    for (const format of ['xml', 'fcpxml', 'jianying', 'capcut']) {
      let finished;
      const done = new Promise(resolve => { finished = resolve; });
      const exports = createExports({ drafts: () => null, onChange: job => { if (['done', 'failed', 'cancelled'].includes(job.status)) finished(job); } });
      try {
        exports.start({ id: format, name: format, path: root }, { kind: 'nle', format, fps: 25, subtitles: false }, { folder: join(root, 'output') });
        const job = await done;
        assert.equal(job.status, 'done', job.error);
        const video = job.outputs.filter(path => path.endsWith('.mp4')), sounds = job.outputs.filter(path => path.endsWith('.wav'));
        assert.equal(video.length, 1);
        assert.deepEqual(await readFile(video[0]), await readFile(source));
        assert.equal(job.outputs.filter(path => path.endsWith('.mov')).length, 0);
        assert.equal(sounds.length, 1);
        const samples = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.04', '-i', sounds[0], '-t', '0.2', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
        let crossings = 0;
        for (let i = 4; i < samples.length; i += 4) if (samples.readFloatLE(i - 4) <= 0 && samples.readFloatLE(i) > 0) crossings++;
        const frequency = crossings / (samples.length / 4 / 16000);
        assert.ok(Math.abs(frequency - 440) < 10, `${format}: measured pitch ${frequency} Hz`);
        if (format === 'jianying' || format === 'capcut') {
          const info = JSON.parse(await readFile(job.out, 'utf8'));
          const clip = info.tracks[0].segments[0];
          assert.equal(clip.speed, 1.5);
          assert.deepEqual(clip.target_timerange, { start: 0, duration: 280000 });
          assert.deepEqual(clip.source_timerange, { start: 1000000, duration: 420000 });
        }
      } finally { await exports.stopAll(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
