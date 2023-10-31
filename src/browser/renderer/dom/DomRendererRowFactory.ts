/**
 * Copyright (c) 2018, 2023 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IBufferLine, ICellData, IColor } from 'common/Types';
import { INVERTED_DEFAULT_COLOR } from 'browser/renderer/shared/Constants';
import { WHITESPACE_CELL_CHAR, Attributes } from 'common/buffer/Constants';
import { CellData } from 'common/buffer/CellData';
import { ICoreService, IDecorationService, IInternalDecoration, IOptionsService } from 'common/services/Services';
import { color, rgba } from 'common/Color';
import { ICharacterJoinerService, ICoreBrowserService, IThemeService } from 'browser/services/Services';
import { JoinedCellData } from 'browser/services/CharacterJoinerService';
import { excludeFromContrastRatioDemands } from 'browser/renderer/shared/RendererUtils';
import { AttributeData } from 'common/buffer/AttributeData';
import { WidthCache } from 'browser/renderer/dom/WidthCache';
import { IColorContrastCache } from 'browser/Types';


export const enum RowCss {
  BOLD_CLASS = 'xterm-bold',
  DIM_CLASS = 'xterm-dim',
  ITALIC_CLASS = 'xterm-italic',
  UNDERLINE_CLASS = 'xterm-underline',
  OVERLINE_CLASS = 'xterm-overline',
  STRIKETHROUGH_CLASS = 'xterm-strikethrough',
  CURSOR_CLASS = 'xterm-cursor',
  CURSOR_BLINK_CLASS = 'xterm-cursor-blink',
  CURSOR_STYLE_BLOCK_CLASS = 'xterm-cursor-block',
  CURSOR_STYLE_OUTLINE_CLASS = 'xterm-cursor-outline',
  CURSOR_STYLE_BAR_CLASS = 'xterm-cursor-bar',
  CURSOR_STYLE_UNDERLINE_CLASS = 'xterm-cursor-underline'
}


export class DomRendererRowFactory {
  private _workCell: CellData = new CellData();

  private _selectionStart: [number, number] | undefined;
  private _selectionEnd: [number, number] | undefined;
  private _columnSelectMode: boolean = false;

  public defaultSpacing = 0;

  constructor(
    private readonly _document: Document,
    @ICharacterJoinerService private readonly _characterJoinerService: ICharacterJoinerService,
    @IOptionsService private readonly _optionsService: IOptionsService,
    @ICoreBrowserService private readonly _coreBrowserService: ICoreBrowserService,
    @ICoreService private readonly _coreService: ICoreService,
    @IDecorationService private readonly _decorationService: IDecorationService,
    @IThemeService private readonly _themeService: IThemeService
  ) {}

  public handleSelectionChanged(start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean): void {
    this._selectionStart = start;
    this._selectionEnd = end;
    this._columnSelectMode = columnSelectMode;
  }

  public createRow(
    lineData: IBufferLine,
    row: number,
    isCursorRow: boolean,
    cursorStyle: string | undefined,
    cursorInactiveStyle: string | undefined,
    cursorX: number,
    cursorBlink: boolean,
    cellWidth: number,
    widthCache: WidthCache,
    linkStart: number,
    linkEnd: number
  ): HTMLSpanElement[] {

    const charElements: HTMLSpanElement[] = [];
    const backgroundElements: HTMLSpanElement[] = [];
    const joinedRanges = this._characterJoinerService.getJoinedCharacters(row);
    const colors = this._themeService.colors;

    let lineLength = this._isRowInSelection(row) ? lineData.length : lineData.getNoBgTrimmedLength();
    if (isCursorRow && lineLength < cursorX + 1) {
      lineLength = cursorX + 1;
    }

    let charElement: HTMLSpanElement | undefined;
    let charCellAmount = 0;
    let charText = '';
    let backgroundElement: HTMLSpanElement | undefined;
    let backgroundCellAmount = 0;
    let oldBg = 0;
    let oldFg = 0;
    let oldExt = 0;
    let oldLinkHover: number | boolean = false;
    let oldSpacing = 0;
    let oldIsInSelection: boolean = false;
    let oldDecorations: IInternalDecoration[] = [];
    let spacing = 0;
    const classes: string[] = [];

    const hasHover = linkStart !== -1 && linkEnd !== -1;

    for (let x = 0; x < lineLength; x++) {
      lineData.loadCell(x, this._workCell);
      let width = this._workCell.getWidth();

      // The character to the left is a wide character, drawing is owned by the char at x-1
      if (width === 0) {
        continue;
      }

      // If true, indicates that the current character(s) to draw were joined.
      let isJoined = false;
      let lastCharX = x;

      // Process any joined character ranges as needed. Because of how the
      // ranges are produced, we know that they are valid for the characters
      // and attributes of our input.
      let cell = this._workCell;
      if (joinedRanges.length > 0 && x === joinedRanges[0][0]) {
        isJoined = true;
        const range = joinedRanges.shift()!;

        // We already know the exact start and end column of the joined range,
        // so we get the string and width representing it directly
        cell = new JoinedCellData(
          this._workCell,
          lineData.translateToString(true, range[0], range[1]),
          range[1] - range[0]
        );

        // Skip over the cells occupied by this range in the loop
        lastCharX = range[1] - 1;

        // Recalculate width
        width = cell.getWidth();
      }

      const isInSelection = this._isCellInSelection(x, row);
      const isCursorCell = isCursorRow && x === cursorX;
      const isLinkHover = hasHover && x >= linkStart && x <= linkEnd;

      let decorations: IInternalDecoration[] = [];
      this._decorationService.forEachDecorationAtCell(x, row, undefined, d => {
        decorations.push(d);
      });
      const isSameDecorations = this._isSameDecorations(decorations, oldDecorations);

      // get chars to render for this cell
      let chars = cell.getChars() || WHITESPACE_CELL_CHAR;
      if (chars === ' ' && (cell.isUnderline() || cell.isOverline())) {
        chars = '\xa0';
      }

      // lookup char render width and calc spacing
      spacing = width * cellWidth - widthCache.get(chars, cell.isBold(), cell.isItalic());

      /**
       * chars can only be merged on existing span if:
       * - existing span only contains mergeable chars (cellAmount != 0)
       * - bg did not change (or both are in selection)
       * - fg did not change (or both are in selection and selection fg is set)
       * - ext did not change
       * - underline from hover state did not change
       * - cell content renders to same letter-spacing
       * - cell is not cursor
       * - cell characters are not joined
       * - cell is not decorated
       */
      const canMergeCharacters = charElement
        && charCellAmount
        && (
          (isInSelection && oldIsInSelection && colors.selectionForeground)
          || cell.fg === oldFg
        )
        && cell.extended.ext === oldExt
        && isLinkHover === oldLinkHover
        && isSameDecorations
        && spacing === oldSpacing
        && !isCursorCell
        && !isJoined

      /**
       * background can only be merged on existing span if:
       * - existing span only contains mergeable chars (cellAmount != 0)
       * - bg did not change (or both are in selection)
       * - cell is not decorated
       */
      const canMergeBackground = backgroundElement
        && backgroundCellAmount
        && isSameDecorations
        && (
          (isInSelection && oldIsInSelection)
          || (!isInSelection && !oldIsInSelection && cell.bg === oldBg)
        );

      // if the background related cell attributes have not changed
      // from the previous cell then we simply extend the existing span
      if (canMergeBackground) {
        backgroundCellAmount += width;
      }

      // if the character related cell attributes have not changed
      // from the previous cell then we simply extend the existing span
      if (canMergeCharacters) {
        charText += chars;
        charCellAmount++;
      }

      // character / background attributes have changed - we need to do more work
      if (!canMergeCharacters || !canMergeBackground) {

        // preserve conditions for next merger eval round
        oldBg = cell.bg;
        oldFg = cell.fg;
        oldExt = cell.extended.ext;
        oldLinkHover = isLinkHover;
        oldSpacing = spacing;
        oldIsInSelection = isInSelection;
        oldDecorations = decorations;

        let fg = cell.getFgColor();
        let fgColorMode = cell.getFgColorMode();
        let bg = cell.getBgColor();
        let bgColorMode = cell.getBgColorMode();
        const isInverse = !!cell.isInverse();
        if (isInverse) {
          const temp = fg;
          fg = bg;
          bg = temp;
          const temp2 = fgColorMode;
          fgColorMode = bgColorMode;
          bgColorMode = temp2;
        }

        // Apply any decoration foreground/background overrides, this must happen after inverse has
        // been applied
        let bgOverride: IColor | undefined;
        let fgOverride: IColor | undefined;
        let isTop = false;
        this._decorationService.forEachDecorationAtCell(x, row, undefined, d => {
          if (d.options.layer !== 'top' && isTop) {
            return;
          }
          if (d.backgroundColorRGB) {
            bgColorMode = Attributes.CM_RGB;
            bg = d.backgroundColorRGB.rgba >> 8 & 0xFFFFFF;
            bgOverride = d.backgroundColorRGB;
          }
          if (d.foregroundColorRGB) {
            fgColorMode = Attributes.CM_RGB;
            fg = d.foregroundColorRGB.rgba >> 8 & 0xFFFFFF;
            fgOverride = d.foregroundColorRGB;
          }
          isTop = d.options.layer === 'top';
        });

        // Apply selection
        if (!isTop && isInSelection) {
          // If in the selection, force the element to be above the selection to improve contrast and
          // support opaque selections.
          bgOverride = this._coreBrowserService.isFocused ? colors.selectionBackgroundOpaque : colors.selectionInactiveBackgroundOpaque;
          bg = bgOverride.rgba >> 8 & 0xFFFFFF;
          bgColorMode = Attributes.CM_RGB;
          // Since an opaque selection is being rendered, the selection pretends to be a decoration to
          // ensure text is drawn above the selection.
          isTop = true;
          // Apply selection foreground if applicable
          if (colors.selectionForeground) {
            fgColorMode = Attributes.CM_RGB;
            fg = colors.selectionForeground.rgba >> 8 & 0xFFFFFF;
            fgOverride = colors.selectionForeground;
          }
        }

        // Background
        let resolvedBg: IColor;
        switch (bgColorMode) {
          case Attributes.CM_P16:
          case Attributes.CM_P256:
            resolvedBg = colors.ansi[bg];
            break;
          case Attributes.CM_RGB:
            resolvedBg = rgba.toColor(bg >> 16, bg >> 8 & 0xFF, bg & 0xFF);
            break;
          case Attributes.CM_DEFAULT:
          default:
            if (isInverse) {
              resolvedBg = colors.foreground;
            } else {
              resolvedBg = colors.background;
            }
        }

        // If there is no background override by now it's the original color, so apply dim if needed
        if (!bgOverride) {
          if (cell.isDim()) {
            bgOverride = color.multiplyOpacity(resolvedBg, 0.5);
          }
        }

        // create a new background span
        if (!canMergeBackground) {
          if (backgroundCellAmount) {
            backgroundElement!.style.width = `${backgroundCellAmount * cellWidth}px`;
          }
          backgroundElement = this._document.createElement('span');
          backgroundElement.classList.add('xterm-bg');
          backgroundElement.style.left = `${cellWidth * x}px`;
          backgroundCellAmount = 0;

          switch (bgColorMode) {
            case Attributes.CM_P16:
            case Attributes.CM_P256:
              backgroundElement.classList.add(`xterm-bg-${bg}`);
              break;
            case Attributes.CM_RGB:
              backgroundElement.style.backgroundColor = `#${padStart((bg >>> 0).toString(16), '0', 6)}`;
              break;
            case Attributes.CM_DEFAULT:
            default:
              if (isInverse) {
                backgroundElement.classList.add(`xterm-bg-${INVERTED_DEFAULT_COLOR}`);
              }
          }
          // exclude conditions for cell merging - never merge these
          backgroundCellAmount += width;
          backgroundElements.push(backgroundElement);
        }

        // character span
        if (!canMergeCharacters) {
          if (charCellAmount) {
            charElement!.textContent = charText;
          }
          charElement = this._document.createElement('span');
          charCellAmount = 0;
          charText = '';

          if (isJoined) {
            // The DOM renderer colors the background of the cursor but for ligatures all cells are
            // joined. The workaround here is to show a cursor around the whole ligature so it shows up,
            // the cursor looks the same when on any character of the ligature though
            if (cursorX >= x && cursorX <= lastCharX) {
              cursorX = x;
            }
          }

          // If it's a top decoration, render above the selection
          if (isTop) {
            classes.push('xterm-decoration-top');
          }

          if (!this._coreService.isCursorHidden && isCursorCell && this._coreService.isCursorInitialized) {
            classes.push(RowCss.CURSOR_CLASS);
            if (this._coreBrowserService.isFocused) {
              if (cursorBlink) {
                classes.push(RowCss.CURSOR_BLINK_CLASS);
              }
              classes.push(
                cursorStyle === 'bar'
                  ? RowCss.CURSOR_STYLE_BAR_CLASS
                  : cursorStyle === 'underline'
                    ? RowCss.CURSOR_STYLE_UNDERLINE_CLASS
                    : RowCss.CURSOR_STYLE_BLOCK_CLASS
              );
            } else {
              if (cursorInactiveStyle) {
                switch (cursorInactiveStyle) {
                  case 'outline':
                    classes.push(RowCss.CURSOR_STYLE_OUTLINE_CLASS);
                    break;
                  case 'block':
                    classes.push(RowCss.CURSOR_STYLE_BLOCK_CLASS);
                    break;
                  case 'bar':
                    classes.push(RowCss.CURSOR_STYLE_BAR_CLASS);
                    break;
                  case 'underline':
                    classes.push(RowCss.CURSOR_STYLE_UNDERLINE_CLASS);
                    break;
                  default:
                    break;
                }
              }
            }
          }

          if (cell.isBold()) {
            classes.push(RowCss.BOLD_CLASS);
          }

          if (cell.isItalic()) {
            classes.push(RowCss.ITALIC_CLASS);
          }

          if (cell.isDim()) {
            classes.push(RowCss.DIM_CLASS);
          }

          if (cell.isInvisible()) {
            charText = WHITESPACE_CELL_CHAR;
          } else {
            charText = cell.getChars() || WHITESPACE_CELL_CHAR;
          }

          if (cell.isUnderline()) {
            classes.push(`${RowCss.UNDERLINE_CLASS}-${cell.extended.underlineStyle}`);
            if (charText === ' ') {
              charText = '\xa0'; // = &nbsp;
            }
            if (!cell.isUnderlineColorDefault()) {
              if (cell.isUnderlineColorRGB()) {
                charElement.style.textDecorationColor = `rgb(${AttributeData.toColorRGB(cell.getUnderlineColor()).join(',')})`;
              } else {
                let fg = cell.getUnderlineColor();
                if (this._optionsService.rawOptions.drawBoldTextInBrightColors && cell.isBold() && fg < 8) {
                  fg += 8;
                }
                charElement.style.textDecorationColor = colors.ansi[fg].css;
              }
            }
          }

          if (cell.isOverline()) {
            classes.push(RowCss.OVERLINE_CLASS);
            if (charText === ' ') {
              charText = '\xa0'; // = &nbsp;
            }
          }

          if (cell.isStrikethrough()) {
            classes.push(RowCss.STRIKETHROUGH_CLASS);
          }

          // apply link hover underline late, effectively overrides any previous text-decoration
          // settings
          if (isLinkHover) {
            charElement.style.textDecoration = 'underline';
          }

          // Foreground
          switch (fgColorMode) {
            case Attributes.CM_P16:
            case Attributes.CM_P256:
              if (cell.isBold() && fg < 8 && this._optionsService.rawOptions.drawBoldTextInBrightColors) {
                fg += 8;
              }
              if (!this._applyMinimumContrast(charElement, resolvedBg, colors.ansi[fg], cell, bgOverride, undefined)) {
                classes.push(`xterm-fg-${fg}`);
              }
              break;
            case Attributes.CM_RGB:
              const color = rgba.toColor(
                (fg >> 16) & 0xFF,
                (fg >> 8) & 0xFF,
                (fg) & 0xFF
              );
              if (!this._applyMinimumContrast(charElement, resolvedBg, color, cell, bgOverride, fgOverride)) {
                charElement.style.color = `#${padStart(fg.toString(16), '0', 6)}`;
              }
              break;
            case Attributes.CM_DEFAULT:
            default:
              if (!this._applyMinimumContrast(charElement, resolvedBg, colors.foreground, cell, bgOverride, fgOverride)) {
                if (isInverse) {
                  classes.push(`xterm-fg-${INVERTED_DEFAULT_COLOR}`);
                }
              }
          }

          // apply CSS classes
          // slightly faster than using classList by omitting
          // checks for doubled entries (code above should not have doublets)
          if (classes.length) {
            charElement.className = classes.join(' ');
            classes.length = 0;
          }

          // exclude conditions for cell merging - never merge these
          if (!isCursorCell && !isJoined) {
            charCellAmount++;
          } else {
            charElement.textContent = charText;
          }
          // apply letter-spacing rule
          if (spacing !== this.defaultSpacing) {
            charElement.style.letterSpacing = `${spacing}px`;
          }

          charElements.push(charElement);
          x = lastCharX;
        }

      }

    }

    // postfix text of last merged span
    if (charElement && charCellAmount) {
      charElement.textContent = charText;
    }
    if (backgroundElement && backgroundCellAmount) {
      backgroundElement.style.width = `${backgroundCellAmount * cellWidth}px`;
    }

    return [...backgroundElements, ...charElements];
  }

  private _applyMinimumContrast(element: HTMLElement, bg: IColor, fg: IColor, cell: ICellData, bgOverride: IColor | undefined, fgOverride: IColor | undefined): boolean {
    if (this._optionsService.rawOptions.minimumContrastRatio === 1 || excludeFromContrastRatioDemands(cell.getCode())) {
      return false;
    }

    // Try get from cache first, only use the cache when there are no decoration overrides
    const cache = this._getContrastCache(cell);
    let adjustedColor: IColor | undefined | null = undefined;
    if (!bgOverride && !fgOverride) {
      adjustedColor = cache.getColor(bg.rgba, fg.rgba);
    }

    // Calculate and store in cache
    if (adjustedColor === undefined) {
      // Dim cells only require half the contrast, otherwise they wouldn't be distinguishable from
      // non-dim cells
      const ratio = this._optionsService.rawOptions.minimumContrastRatio / (cell.isDim() ? 2 : 1);
      adjustedColor = color.ensureContrastRatio(bgOverride || bg, fgOverride || fg, ratio);
      cache.setColor((bgOverride || bg).rgba, (fgOverride || fg).rgba, adjustedColor ?? null);
    }

    if (adjustedColor) {
      element.style.color = adjustedColor.css;
      return true;
    }

    return false;
  }

  private _getContrastCache(cell: ICellData): IColorContrastCache {
    if (cell.isDim()) {
      return this._themeService.colors.halfContrastCache;
    }
    return this._themeService.colors.contrastCache;
  }

  private _isRowInSelection(y: number): boolean {
    const start = this._selectionStart;
    const end = this._selectionEnd;
    if (!start || !end) {
      return false;
    }
    return y >= start[1] && y <= end[1];
  }

  private _isCellInSelection(x: number, y: number): boolean {
    const start = this._selectionStart;
    const end = this._selectionEnd;
    if (!start || !end) {
      return false;
    }
    if (this._columnSelectMode) {
      if (start[0] <= end[0]) {
        return x >= start[0] && y >= start[1] &&
          x < end[0] && y <= end[1];
      }
      return x < start[0] && y >= start[1] &&
        x >= end[0] && y <= end[1];
    }
    return (y > start[1] && y < end[1]) ||
        (start[1] === end[1] && y === start[1] && x >= start[0] && x < end[0]) ||
        (start[1] < end[1] && y === end[1] && x < end[0]) ||
        (start[1] < end[1] && y === start[1] && x >= start[0]);
  }

  private _isSameDecorations(decos1: IInternalDecoration[], decos2: IInternalDecoration[]): boolean {
    const decos1Length = decos1.length;
    const decos2Length = decos2.length;
    if (!decos1Length && !decos2Length) {
      return true;
    }
    if (decos1Length !== decos2Length) {
      return false;
    }
    for (let i = 0; i < decos1Length; i++) {
      if (decos1[i] !== decos2[i]) {
        return false;
      }
    }
    return true;
  }

}

function padStart(text: string, padChar: string, length: number): string {
  while (text.length < length) {
    text = padChar + text;
  }
  return text;
}
