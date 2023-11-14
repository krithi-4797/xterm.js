/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { UNDERLINE_CURLY_SEGMENT_SIZE } from 'browser/renderer/shared/Constants';
import { IDimensions, IRenderDimensions } from 'browser/renderer/shared/Types';
import { TwoKeyMap } from 'common/MultiKeyMap';

export function throwIfFalsy<T>(value: T | undefined | null): T {
  if (!value) {
    throw new Error('value must not be falsy');
  }
  return value;
}

export function isPowerlineGlyph(codepoint: number): boolean {
  // Only return true for Powerline symbols which require
  // different padding and should be excluded from minimum contrast
  // ratio standards
  return 0xE0A4 <= codepoint && codepoint <= 0xE0D6;
}

export function isRestrictedPowerlineGlyph(codepoint: number): boolean {
  return 0xE0B0 <= codepoint && codepoint <= 0xE0B7;
}

function isBoxOrBlockGlyph(codepoint: number): boolean {
  return 0x2500 <= codepoint && codepoint <= 0x259F;
}

export function excludeFromContrastRatioDemands(codepoint: number): boolean {
  return isPowerlineGlyph(codepoint) || isBoxOrBlockGlyph(codepoint);
}

export function createRenderDimensions(): IRenderDimensions {
  return {
    css: {
      canvas: createDimension(),
      cell: createDimension()
    },
    device: {
      canvas: createDimension(),
      cell: createDimension(),
      char: {
        width: 0,
        height: 0,
        left: 0,
        top: 0
      }
    }
  };
}

function createDimension(): IDimensions {
  return {
    width: 0,
    height: 0
  };
}

export function computeNextVariantOffset(cellWidth: number, lineWidth: number, currentOffset: number = 0): number {
  return (cellWidth - (Math.round(lineWidth) * 2 - currentOffset)) % (Math.round(lineWidth) * 2);
}

// TwoKeyMap
// eslint-disable-next-line @typescript-eslint/naming-convention
const _curlyVariantCache = new TwoKeyMap();

export function getCurlyVariant(cellWidth: number, lineWidth: number, offset: number): string {
  if (_curlyVariantCache.get(cellWidth, lineWidth)) {
    const curlyVariants = _curlyVariantCache.get(cellWidth, lineWidth) as any[];
    if (curlyVariants.length > 0) {
      if (!curlyVariants[offset]) {
        return curlyVariants[0];
      }
      return curlyVariants[offset];
    }
  }
  return '';
}

export function getCurlyVariantOffset(x: number, cellWidth: number, lineWidth: number): number {
  if (!_curlyVariantCache.get(cellWidth, lineWidth)) {
    const curlyVariants = createDrawCurlyPlan(cellWidth, lineWidth);
    _curlyVariantCache.set(cellWidth, lineWidth, curlyVariants);
    return x % curlyVariants.length;
  }
  if (_curlyVariantCache.get(cellWidth, lineWidth)) {
    const curlyVariants = _curlyVariantCache.get(cellWidth, lineWidth) as any[];
    return x % curlyVariants.length;
  }
  return 0;
}

export function createDrawCurlyPlan(cellWidth: number, lineWidth: number): any[] {
  const defaultFullSegmentWidth = UNDERLINE_CURLY_SEGMENT_SIZE * lineWidth * 2;

  if (lineWidth === 2) {
    // 12 look better
    return createVariantSequences(cellWidth, 12, lineWidth, 4);
  }

  if (lineWidth === 3) {
    return createVariantSequences(cellWidth, 16, lineWidth, 5);
  }

  return createVariantSequences(cellWidth, defaultFullSegmentWidth , lineWidth, 3 * lineWidth);
}

function createVariantSequences(cellWidth: number, fullSegmentWidth: number, point: number, line: number, cellNum: number = 0, vague: boolean = false): string[] {
  let countPx = cellWidth * ((cellNum !== 0 ? cellNum : fullSegmentWidth));
  const result: any[] = [];
  let midOrLine: 0 | 1 = 0;
  let waitHandleLinePx = 0;
  let upOrDown: 0 | 1 = 0;
  let lastUpOrDown: 0 | 1 = 0;
  while (countPx > 0) {
    const cellResult: any[] = [];
    let cellCurrentWidth = cellWidth;
    while (cellCurrentWidth > 0) {
      if (midOrLine === 0) {
        let tag = vague ? 'M' : upOrDown === 0 ? 'A' : 'B';
        if (waitHandleLinePx > 0) {
          // right
          tag = lastUpOrDown === 0 ? 'M' : 'P';
          cellResult.push(`${tag}${waitHandleLinePx}`);
          cellCurrentWidth -= waitHandleLinePx;
          waitHandleLinePx = 0;
          midOrLine = 1;
        } else {
          // left
          tag = lastUpOrDown === 0 ? 'Z' : 'Q';
          const usingWidth = point;
          if (usingWidth > cellCurrentWidth) {
            cellResult.push(`${tag}${cellCurrentWidth}`);
            waitHandleLinePx = usingWidth - cellCurrentWidth;
            cellCurrentWidth = 0;
          } else {
            if (upOrDown === 0) {
              cellResult.push(`Y${point}`);
              cellCurrentWidth -= point;
              midOrLine = 1;
            } else if (upOrDown === 1) {
              cellResult.push(`B${point}`);
              cellCurrentWidth -= point;
              midOrLine = 1;
            }
          }
        }
      } else if (midOrLine === 1) {
        if (waitHandleLinePx > 0) {
          const tag = upOrDown === 0 ? 'U' : 'D';
          cellResult.push(`${tag}${waitHandleLinePx}`);
          cellCurrentWidth -= waitHandleLinePx;
          waitHandleLinePx = 0;
          midOrLine = 0;
          lastUpOrDown = upOrDown;
          upOrDown = upOrDown === 0 ? 1 : 0;
        } else {
          const usingWidth = line;
          if (usingWidth > cellCurrentWidth) {
            const tag = upOrDown === 0 ? 'U' : 'D';
            cellResult.push(`${tag}${cellCurrentWidth}`);
            waitHandleLinePx = usingWidth - cellCurrentWidth;
            cellCurrentWidth = 0;
          } else {
            const tag = upOrDown === 0 ? 'U' : 'D';
            cellResult.push(`${tag}${line}`);
            cellCurrentWidth -= line;
            midOrLine = 0;
            lastUpOrDown = upOrDown;
            upOrDown = upOrDown === 0 ? 1 : 0;
          }
        }
      }
    }
    countPx -= cellWidth;
    result.push(cellResult.join(' '));
  }
  return result;
}
