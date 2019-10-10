/**
 * Copyright (c) 2016 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Disposable } from 'common/Lifecycle';
import { addDisposableDomListener } from 'browser/Lifecycle';
import { IColorSet, IViewport } from 'browser/Types';
import { ICharSizeService, IRenderService } from 'browser/services/Services';
import { IBufferService } from 'common/services/Services';
import { isWindows } from 'common/Platform';

const FALLBACK_SCROLL_BAR_WIDTH = 15;

/**
 * Represents the viewport of a terminal, the visible area within the larger buffer of output.
 * Logic for the virtual scroll bar is included in this object.
 */
export class Viewport extends Disposable implements IViewport {
  public scrollBarWidth: number = 0;
  private _currentRowHeight: number = 0;
  private _lastRecordedBufferLength: number = 0;
  private _lastRecordedViewportHeight: number = 0;
  private _lastRecordedBufferHeight: number = 0;
  private _lastTouchY: number = 0;
  private _lastScrollTop: number = 0;

  // Stores a partial line amount when scrolling, this is used to keep track of how much of a line
  // is scrolled so we can "scroll" over partial lines and feel natural on touchpads. This is a
  // quick fix and could have a more robust solution in place that reset the value when needed.
  private _wheelPartialScroll: number = 0;

  private _refreshAnimationFrame: number | null = null;
  private _ignoreNextScrollEvent: boolean = false;

  constructor(
    private readonly _scrollLines: (amount: number, suppressEvent: boolean) => void,
    private readonly _viewportElement: HTMLElement,
    private readonly _scrollArea: HTMLElement,
    @IBufferService private readonly _bufferService: IBufferService,
    @ICharSizeService private readonly _charSizeService: ICharSizeService,
    @IRenderService private readonly _renderService: IRenderService
  ) {
    super();

    // Measure the width of the scrollbar. If it is 0 we can assume it's an OSX overlay scrollbar.
    // Unfortunately the overlay scrollbar would be hidden underneath the screen element in that case,
    // therefore we account for a standard amount to make it visible
    this.scrollBarWidth = (this._viewportElement.offsetWidth - this._scrollArea.offsetWidth) || FALLBACK_SCROLL_BAR_WIDTH;
    this.register(addDisposableDomListener(this._viewportElement, 'scroll', this._onScroll.bind(this)));

    // Perform this async to ensure the ICharSizeService is ready.
    setTimeout(() => this.syncScrollArea(), 0);
  }

  public onThemeChange(colors: IColorSet): void {
    this._viewportElement.style.backgroundColor = colors.background.css;
  }

  /**
   * Refreshes row height, setting line-height, viewport height and scroll area height if
   * necessary.
   */
  private _refresh(): void {
    if (this._refreshAnimationFrame === null) {
      this._refreshAnimationFrame = requestAnimationFrame(() => this._innerRefresh());
    }
  }

  private _innerRefresh(): void {
    if (this._charSizeService.height > 0) {
      this._currentRowHeight = this._renderService.dimensions.scaledCellHeight / window.devicePixelRatio;
      this._lastRecordedViewportHeight = this._viewportElement.offsetHeight;
      const newBufferHeight = Math.round(this._currentRowHeight * this._lastRecordedBufferLength) + (this._lastRecordedViewportHeight - this._renderService.dimensions.canvasHeight);
      if (this._lastRecordedBufferHeight !== newBufferHeight) {
        this._lastRecordedBufferHeight = newBufferHeight;
        this._scrollArea.style.height = this._lastRecordedBufferHeight + 'px';
      }
    }

    // Sync scrollTop
    const scrollTop = this._bufferService.buffer.ydisp * this._currentRowHeight;
    if (this._viewportElement.scrollTop !== scrollTop) {
      // Ignore the next scroll event which will be triggered by setting the scrollTop as we do not
      // want this event to scroll the terminal
      this._ignoreNextScrollEvent = true;
      this._viewportElement.scrollTop = scrollTop;
    }

    this._refreshAnimationFrame = null;
  }

  /**
   * Updates dimensions and synchronizes the scroll area if necessary.
   */
  public syncScrollArea(): void {
    // If buffer height changed
    if (this._lastRecordedBufferLength !== this._bufferService.buffer.lines.length) {
      this._lastRecordedBufferLength = this._bufferService.buffer.lines.length;
      this._refresh();
      return;
    }

    // If viewport height changed
    if (this._lastRecordedViewportHeight !== this._renderService.dimensions.canvasHeight) {
      this._refresh();
      return;
    }

    // If the buffer position doesn't match last scroll top
    const newScrollTop = this._bufferService.buffer.ydisp * this._currentRowHeight;
    if (this._lastScrollTop !== newScrollTop) {
      this._refresh();
      return;
    }

    // If element's scroll top changed, this can happen when hiding the element
    if (this._lastScrollTop !== this._viewportElement.scrollTop) {
      this._refresh();
      return;
    }

    // If row height changed
    if (this._renderService.dimensions.scaledCellHeight / window.devicePixelRatio !== this._currentRowHeight) {
      this._refresh();
      return;
    }
  }

  /**
   * Handles scroll events on the viewport, calculating the new viewport and requesting the
   * terminal to scroll to it.
   * @param ev The scroll event.
   */
  private _onScroll(ev: Event): void {
    // Record current scroll top position
    this._lastScrollTop = this._viewportElement.scrollTop;

    // Don't attempt to scroll if the element is not visible, otherwise scrollTop will be corrupt
    // which causes the terminal to scroll the buffer to the top
    if (!this._viewportElement.offsetParent) {
      return;
    }

    // Ignore the event if it was flagged to ignore (when the source of the event is from Viewport)
    if (this._ignoreNextScrollEvent) {
      this._ignoreNextScrollEvent = false;
      return;
    }

    const newRow = Math.round(this._lastScrollTop / this._currentRowHeight);
    const diff = newRow - this._bufferService.buffer.ydisp;
    this._scrollLines(diff, true);
  }

  /**
   * Handles bubbling of scroll event in case the viewport has reached top or bottom
   * @param ev The scroll event.
   * @param amount The amount scrolled
   */
  private _bubbleScroll(ev: Event, amount: number): boolean {
    const scrollPosFromTop = this._viewportElement.scrollTop + this._lastRecordedViewportHeight;
    if ((amount < 0 && this._viewportElement.scrollTop !== 0) ||
        (amount > 0 &&  scrollPosFromTop < this._lastRecordedBufferHeight)) {
      if (ev.cancelable) {
        ev.preventDefault();
      }
      return false;
    }
    return true;
  }

  /**
   * Handles mouse wheel events by adjusting the viewport's scrollTop and delegating the actual
   * scrolling to `onScroll`, this event needs to be attached manually by the consumer of
   * `Viewport`.
   * @param ev The mouse wheel event.
   */
  public onWheel(ev: WheelEvent): boolean {
    const amount = this._getPixelsScrolled(ev);
    if (amount === 0) {
      return false;
    }
    this._viewportElement.scrollTop += amount;
    return this._bubbleScroll(ev, amount);
  }

  private _getPixelsScrolled(ev: WheelEvent): number {
    // Do nothing if it's not a vertical scroll event
    if (ev.deltaY === 0) {
      return 0;
    }

    // Fallback to WheelEvent.DOM_DELTA_PIXEL
    let amount = ev.deltaY;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      amount *= this._currentRowHeight;
    } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      amount *= this._currentRowHeight * this._bufferService.rows;
    }
    else {
      if (isWindows) {
        // Windows doesn't scale the delta by the pixel ratio, so normalize it
        amount /= window.devicePixelRatio;

        const wheelDeltaY = (ev as any).wheelDeltaY;
        if (wheelDeltaY !== undefined) {
          // https://developer.mozilla.org/en-US/docs/Web/API/Element/mousewheel_event#Chrome
          // https://devblogs.microsoft.com/oldnewthing/20130123-00/?p=5473
          // If the wheelDeltaY is evenly divisible by 120, then assume this is a physical mouse
          if (wheelDeltaY % 120 === 0) {
            // With a scale factor of 1
            // With Windows set to scroll 1 line per "notch", deltaY will be ~33.33
            // With Windows set to scroll 2 lines per "notch", deltaY will be ~66.66
            // With Windows set to scroll 3 lines per "notch", deltaY will be 100
            // ...
            // So divide the deltaY by 33.33 to get the number of lines scrolled in the "notch"
            amount = this._currentRowHeight * Math.round(amount / (100 / 3));
          }
        }
      }
    }
    return amount;
  }

  /**
   * Gets the number of pixels scrolled by the mouse event taking into account what type of delta
   * is being used.
   * @param ev The mouse wheel event.
   */
  public getLinesScrolled(ev: WheelEvent): number {
    // Do nothing if it's not a vertical scroll event
    if (ev.deltaY === 0) {
      return 0;
    }

    // Fallback to WheelEvent.DOM_DELTA_LINE
    let amount = ev.deltaY;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
      amount /= this._currentRowHeight + 0.0; // Prevent integer division
      this._wheelPartialScroll += amount;
      amount = Math.floor(Math.abs(this._wheelPartialScroll)) * (this._wheelPartialScroll > 0 ? 1 : -1);
      this._wheelPartialScroll %= 1;
    } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      amount *= this._bufferService.rows;
    }
    return amount;
  }

  /**
   * Handles the touchstart event, recording the touch occurred.
   * @param ev The touch event.
   */
  public onTouchStart(ev: TouchEvent): void {
    this._lastTouchY = ev.touches[0].pageY;
  }

  /**
   * Handles the touchmove event, scrolling the viewport if the position shifted.
   * @param ev The touch event.
   */
  public onTouchMove(ev: TouchEvent): boolean {
    const deltaY = this._lastTouchY - ev.touches[0].pageY;
    this._lastTouchY = ev.touches[0].pageY;
    if (deltaY === 0) {
      return false;
    }
    this._viewportElement.scrollTop += deltaY;
    return this._bubbleScroll(ev, deltaY);
  }
}
