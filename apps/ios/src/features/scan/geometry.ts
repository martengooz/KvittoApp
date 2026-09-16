import type { NormalizedQuad } from '../../../modules/kvitto-native/src';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampQuad(quad: NormalizedQuad): NormalizedQuad {
  return {
    topLeft: { x: clamp01(quad.topLeft.x), y: clamp01(quad.topLeft.y) },
    topRight: { x: clamp01(quad.topRight.x), y: clamp01(quad.topRight.y) },
    bottomRight: { x: clamp01(quad.bottomRight.x), y: clamp01(quad.bottomRight.y) },
    bottomLeft: { x: clamp01(quad.bottomLeft.x), y: clamp01(quad.bottomLeft.y) },
  };
}

export function rotateClockwise(rotation: 0 | 90 | 180 | 270): 0 | 90 | 180 | 270 {
  if (rotation === 0) return 90;
  if (rotation === 90) return 180;
  if (rotation === 180) return 270;
  return 0;
}
