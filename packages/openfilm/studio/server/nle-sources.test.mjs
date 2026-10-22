import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nlePictureEffects, nlePictureMotion } from '../../src/nle-picture.mjs';
import { planNleTimeline, xmemlDocument } from './nle.mjs';
import { fcpxmlDocument } from './fcpxml.mjs';
import { jianyingDraft } from './jianying.mjs';

const stage = { w: 320, h: 180 };
const facts = { w: 640, h: 360, duration: 12, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000 };
const look = { fit: 'contain', position: '50% 50%', radius: '0px', opacity: '1', blend: 'normal', clip: 'none', filter: 'none' };
const picture = { kind: 'video', facts, look };

test('render detection reads actual effects, not the presence of a class or an inline placement', () => {
  assert.deepEqual(nlePictureEffects({ ...picture, styled: true }, stage), []);
  assert.deepEqual(nlePictureEffects({ ...picture, box: { x: 20, y: 30, w: 160, r: 15 } }, stage), []);
  assert.deepEqual(nlePictureEffects({ ...picture, look: { ...look, filter: 'saturate(0.65) contrast(1.1)' } }, stage), ['filter']);
  assert.deepEqual(nlePictureEffects({ ...picture, faded: true }, stage), ['fade']);
  assert.deepEqual(nlePictureEffects({ ...picture, look: { ...look, animated: true } }, stage), ['animation']);
  assert.deepEqual(nlePictureEffects({ ...picture, look: { ...look, extra: true } }, stage), ['other']);
  assert.deepEqual(nlePictureEffects({ ...picture, look: { ...look, clip: 'circle(50%)' } }, stage), ['mask']);
  assert.deepEqual(nlePictureEffects({ ...picture, look: undefined, styled: true }, stage), ['unknown']);
  assert.deepEqual(nlePictureEffects({ kind: 'page', facts: null, styled: true }, stage), [], 'HTML is rendered in both modes');
});

test('native placement keeps rotation and cover alignment; a crop within the canvas is reported explicitly', () => {
  assert.deepEqual(nlePictureMotion(picture, stage), { cropped: false, motion: { scale: 50, center: { h: 0, v: 0 } } });
  const rotated = nlePictureMotion({ ...picture, box: { x: 0, y: 0, w: 320, h: 180, r: 30 } }, stage);
  assert.equal(rotated.motion.rotation, 30);
  const square = { ...picture, facts: { w: 640, h: 640 }, look: { ...look, fit: 'cover', position: '50% 0%' } };
  assert.deepEqual(nlePictureEffects(square, stage), [], 'the canvas clips a full-frame cover without baking');
  assert.deepEqual(nlePictureMotion(square, stage).motion.center, { h: 0, v: 0.388889 });
  assert.deepEqual(nlePictureEffects({ ...square, box: { x: 0, y: 0, w: 160, h: 90 } }, stage), ['crop']);
  assert.deepEqual(nlePictureEffects({ ...picture, look: { ...look, position: 'right 12px bottom 0px' } }, stage), ['geometry']);
});

function film() {
  const pictures = [
    { id: 'slow', at: 0, end: 2, from: 2, speed: 0.5, look: { ...look, filter: 'saturate(1.1)' } },
    { id: 'tinted', at: 2, end: 4, from: 4, speed: 1, look: { ...look, filter: 'contrast(1.1)' } },
    { id: 'fast', at: 4, end: 6, from: 0, speed: 2, look },
  ].map((clip) => ({ ...picture, ...clip, src: `${clip.id === 'fast' ? 'alias' : 'take'}.mp4`, path: '/p/take.mp4', track: 0, hidden: false }));
  return { stage, duration: 6, pictures, sounds: pictures.map((p) => ({
    ...p, to: p.from + (p.end - p.at) * p.speed, picture: p.id, volume: 0.5, enabled: true, role: 'footage',
  })) };
}

const options = { title: 'Film', fps: 25, audio: 'clips', media: 'copy', mediaDir: '/out/media' };

test('appearance is the default, baking only affected pictures; source mode shares one full-length recording', () => {
  const appearance = planNleTimeline(film(), options);
  assert.deepEqual(appearance, planNleTimeline(film(), { ...options, visuals: 'effects' }));
  assert.equal(appearance.files.filter((f) => f.job.kind === 'render').length, 2);
  assert.equal(appearance.video[0].clips[2].speed, 2, 'an ordinary speed change uses native parameters');
  const source = planNleTimeline(film(), { ...options, visuals: 'source' });
  assert.equal(source.files.length, 1, 'aliases and each clip’s audio share the same source path');
  assert.equal(source.files[0].durationFrames, 300, 'the 12-second recording survives the 6-second edit');
  assert.equal(source.files[0].job.kind, 'copy');
  assert.deepEqual(source.video[0].clips.map((c) => [c.start, c.end, c.in, c.out, c.speed ?? 1]), [
    [0, 50, 50, 75, 0.5], [50, 100, 100, 150, 1], [100, 150, 0, 100, 2],
  ]);
  assert.deepEqual(source.audio[0].clips.map((c) => [c.fileId, c.in, c.out, c.speed, c.linkGroup]),
    source.video[0].clips.map((c) => [c.fileId, c.in, c.out, c.speed, c.linkGroup]), 'native picture and sound stay in sync');
  const stems = planNleTimeline(film(), { ...options, visuals: 'source', audio: 'stems', stems: ['footage'] });
  assert.equal(stems.files.find((f) => f.video).durationFrames, 300);
  assert.equal(stems.audio[0].clips.length, 1);
});

test('Jianying and CapCut reuse full library media with source trims, speed materials and native rotation', () => {
  const source = film();
  source.pictures[0].box = { x: 0, y: 0, w: 320, h: 180, r: 15 };
  const timeline = planNleTimeline(source, { ...options, visuals: 'source' });
  for (const app of ['jianying', 'capcut']) {
    const { info, meta } = jianyingDraft(timeline, { app, name: 'Film', folder: '/out', root: '/' });
    const clips = info.tracks[0].segments;
    assert.equal(info.materials.videos.length, 1);
    assert.equal(info.materials.videos[0].duration, 12_000_000);
    assert.equal(meta.draft_materials.find((g) => g.type === 0).value.length, 1);
    assert.deepEqual(clips.map((c) => c.source_timerange), [
      { start: 2_000_000, duration: 1_000_000 }, { start: 4_000_000, duration: 2_000_000 }, { start: 0, duration: 4_000_000 },
    ]);
    assert.deepEqual(clips.map((c) => c.target_timerange.duration), [2_000_000, 2_000_000, 2_000_000]);
    assert.deepEqual(clips.map((c) => c.speed), [0.5, 1, 2]);
    for (const c of clips) assert.equal(info.materials.speeds.find((s) => c.extra_material_refs.includes(s.id)).speed, c.speed);
    assert.equal(clips[0].clip.rotation, 15);
    assert.equal(info.tracks.length, 1, 'footage sound is folded into its video, without a duplicate track');
    assert.ok(clips.every((c) => c.volume === 0.5));
  }
});

test('XML stores true source positions alongside its retimed domain; FCP retimes components without shifting connections', () => {
  const source = film();
  source.pictures[0].box = { x: 0, y: 0, w: 320, h: 180, r: 15 };
  const timeline = planNleTimeline(source, { ...options, visuals: 'source', audioTracks: 'source' });
  const xml = xmemlDocument(timeline);
  const slow = xml.match(/<clipitem id="clipitem-1">[\s\S]*?<\/clipitem>/)[0];
  assert.match(slow, /<in>100<\/in>\s*<out>150<\/out>/, 'the retimed domain spans the 50-frame record duration');
  assert.match(slow, /<pproTicksIn>508032000000<\/pproTicksIn>/, 'the actual source in is 2 seconds');
  assert.match(slow, /<parameterid>speed<\/parameterid><name>speed<\/name><value>50<\/value>/);
  assert.match(slow, /<parameterid>rotation<\/parameterid><name>Rotation<\/name><value>15<\/value>/);
  const fcp = fcpxmlDocument(timeline);
  assert.match(fcp, /<timept time="0s" value="50\/25s" interp="linear"\/>/);
  assert.match(fcp, /<timept time="50\/25s" value="75\/25s" interp="linear"\/>/);
  assert.match(fcp, /<\/video>\s*<audio[^>]*name="slow"[^>]*offset="50\/25s" start="0\/25s" duration="50\/25s"/, 'retimed sound is a sibling, avoiding a second time map from its parent');
  assert.match(fcp, /rotation="-15"/);
  assert.match(fcp, /<clip[^>]*name="tinted"[^>]*offset="50\/25s" start="100\/25s" duration="50\/25s"/);
});
