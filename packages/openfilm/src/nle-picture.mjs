// @ts-check
import { pictureRect } from './film-doc.mjs';

/**
 * @typedef {{ fit?: string, position?: string, radius?: string, opacity?: string, blend?: string,
 *   clip?: string, filter?: string, extra?: boolean, animated?: boolean }} NleLook
 * @typedef {{ kind: string, box?: import('./film-doc.mjs').FilmBox, facts: { w?: number, h?: number } | null,
 *   look?: NleLook, styled?: boolean, faded?: boolean }} NlePictureLook
 * @typedef {{ scale: number, center: { h: number, v: number }, rotation?: number }} NleMotion
 */

const round = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6 || 0;

/** Source pixels placed as the browser places them; shared by the export dialog and the media planner.
 * @param {NlePictureLook} picture @param {{ w: number, h: number }} stage
 * @returns {{ motion?: NleMotion, cropped: boolean } | null}
 */
export function nlePictureMotion(picture, stage) {
  const w = picture.facts?.w ?? 0, h = picture.facts?.h ?? 0;
  if (!(w > 0 && h > 0)) return null;
  const rect = pictureRect('video', { w, h }, stage, picture.box);
  const fit = picture.look?.fit ?? 'contain';
  if (!['contain', 'cover', 'none', 'scale-down'].includes(fit)) return null;
  const contain = Math.min(rect.w / w, rect.h / h);
  const scale = fit === 'cover' ? Math.max(rect.w / w, rect.h / h) : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
  const position = (picture.look?.position ?? '50% 50%').split(/\s+/);
  if (position.length !== 2 || !position.every((p) => /^-?[\d.]+%$/.test(p))) return null;
  const x = (rect.w - w * scale) * parseFloat(position[0]) / 100;
  const y = (rect.h - h * scale) * parseFloat(position[1]) / 100;
  const rotation = rect.r;
  const angle = rotation * Math.PI / 180;
  const dx = x + w * scale / 2 - rect.w / 2, dy = y + h * scale / 2 - rect.h / 2;
  const center = {
    h: round((rect.x + rect.w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - stage.w / 2) / stage.w),
    v: round((rect.y + rect.h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - stage.h / 2) / stage.h),
  };
  // shortcut: cropping inside the canvas needs rendering until every adapter has native crop support.
  const overflow = x < -1e-4 || y < -1e-4 || x + w * scale > rect.w + 1e-4 || y + h * scale > rect.h + 1e-4;
  const coversCanvas = rotation === 0 && rect.x <= 0 && rect.y <= 0 && rect.x + rect.w >= stage.w && rect.y + rect.h >= stage.h;
  return {
    cropped: overflow && !coversCanvas,
    ...(Math.abs(scale - 1) > 1e-6 || center.h || center.v || rotation ? {
      motion: { scale: round(scale * 100), center, ...(rotation ? { rotation } : {}) },
    } : {}),
  };
}

/** Effects which cannot be carried over as editable parameters. Pages are rendered in both modes.
 * @param {NlePictureLook} picture @param {{ w: number, h: number }} stage @returns {string[]}
 */
export function nlePictureEffects(picture, stage) {
  if (picture.kind === 'page') return [];
  const effects = [];
  const look = picture.look;
  if (!look && picture.styled) effects.push('unknown');
  if (look?.filter && look.filter !== 'none') effects.push('filter');
  if (look?.blend && look.blend !== 'normal') effects.push('blend');
  if ((look?.clip && look.clip !== 'none') || (look?.radius && /[1-9]/.test(look.radius))) effects.push('mask');
  if (look?.opacity !== undefined && Math.abs(Number(look.opacity) - 1) > 1e-6) effects.push('opacity');
  if (picture.faded) effects.push('fade');
  if (look?.animated) effects.push('animation');
  if (look?.extra) effects.push('other');
  const placement = nlePictureMotion(picture, stage);
  if (!placement) effects.push('geometry');
  else if (placement.cropped) effects.push('crop');
  return effects;
}
