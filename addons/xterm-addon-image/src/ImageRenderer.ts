/**
 * Copyright (c) 2020 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { toRGBA8888 } from 'sixel';
import { IDisposable } from 'xterm';
import { ICellSize, ICoreTerminal, IImageSpec, IRenderDimensions, IRenderService } from './Types';


const PLACEHOLDER_LENGTH = 4096;
const PLACEHOLDER_HEIGHT = 24;

/**
 * ImageRenderer - terminal frontend extension:
 * - provide primitives for canvas, ImageData, Bitmap (static)
 * - add canvas layer to DOM (browser only for now)
 * - draw image tiles onRender
 *
 * FIXME: needs overload of Terminal.setOption('fontSize')
 */
export class ImageRenderer implements IDisposable {
  public canvas: HTMLCanvasElement | undefined;
  private _ctx: CanvasRenderingContext2D | null | undefined;
  private _placeholder: HTMLCanvasElement | undefined;
  private _placeholderBitmap: ImageBitmap | undefined;
  private _optionsRefresh: IDisposable | undefined;
  private _oldOpen: ((parent: HTMLElement) => void) | undefined;
  private _rs: IRenderService | undefined;
  private _oldSetRenderer: ((renderer: any) => void) | undefined;

  // drawing primitive - canvas
  public static createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width | 0;
    canvas.height = height | 0;
    return canvas;
  }

  // drawing primitive - ImageData
  public static createImageData(ctx: CanvasRenderingContext2D, width: number, height: number): ImageData {
    if (typeof ImageData !== 'function') {
      return ctx.createImageData(width, height);
    }
    return new ImageData(width, height);
  }

  // drawing primitive - ImageBitmap
  public static createImageBitmap(img: ImageBitmapSource): Promise<ImageBitmap | undefined> {
    if (typeof createImageBitmap !== 'function') {
      return new Promise(res => res(undefined));
    }
    return createImageBitmap(img);
  }


  constructor(private _terminal: ICoreTerminal, private _showPlaceholder: boolean) {
    this._oldOpen = this._terminal._core.open;
    this._terminal._core.open = (parent: HTMLElement): void => {
      this._oldOpen?.call(this._terminal._core, parent);
      this._open();
    };
    if (this._terminal._core.screenElement) {
      this._open();
    }
    // hack to spot fontSize changes
    this._optionsRefresh = this._terminal._core.optionsService.onOptionChange(option => {
      if (option === 'fontSize') {
        this.rescaleCanvas();
        this._rs?.refreshRows(0, this._terminal.rows);
      }
    });
  }


  public dispose(): void {
    this._optionsRefresh?.dispose();
    this._removeLayerFromDom();
    if (this._terminal._core && this._oldOpen) {
      this._terminal._core.open = this._oldOpen;
      this._oldOpen = undefined;
    }
    if (this._rs && this._oldSetRenderer) {
      this._rs.setRenderer = this._oldSetRenderer;
      this._oldSetRenderer = undefined;
    }
    this._rs = undefined;
    this.canvas = undefined;
    this._ctx = undefined;
    this._placeholderBitmap?.close();
    this._placeholderBitmap = undefined;
    this._placeholder = undefined;
  }

  /**
   * Enable the placeholder (shown on next screen update).
   */
  public showPlaceholder(value: boolean): void {
    if (value) {
      if (!this._placeholder && this.cellSize.height !== -1) {
        this._createPlaceHolder(Math.max(this.cellSize.height + 1, PLACEHOLDER_HEIGHT));
      }
    } else {
      this._placeholderBitmap?.close();
      this._placeholderBitmap = undefined;
      this._placeholder = undefined;
    }
  }

  /**
   * Dimensions of the terminal.
   * Forwarded from internal render service.
   */
  public get dimensions(): IRenderDimensions | undefined {
    return this._rs?.dimensions;
  }

  /**
   * Rounded current cell size.
   */
  public get cellSize(): ICellSize {
    return {
      width: Math.round(this.dimensions?.actualCellWidth || -1),
      height: Math.round(this.dimensions?.actualCellHeight || -1)
    };
  }

  /**
   * Clear a region of the image layer canvas.
   */
  public clearLines(start: number, end: number): void {
    this._ctx?.clearRect(
      0,
      start * (this.dimensions?.actualCellHeight || 0),
      this.dimensions?.canvasWidth || 0,
      (++end - start) * (this.dimensions?.actualCellHeight || 0)
    );
  }

  /**
   * Clear whole image canvas.
   */
  public clearAll(): void {
    this._ctx?.clearRect(0, 0, this.canvas?.width || 0, this.canvas?.height || 0);
  }

  /**
   * Draw neighboring tiles on the image layer canvas.
   */
  public draw(imgSpec: IImageSpec, tileId: number, col: number, row: number, count: number = 1): void {
    if (!this._ctx) {
      return;
    }
    const { width, height } = this.cellSize;
    this._rescaleImage(imgSpec, width, height);
    const img = imgSpec.bitmap || imgSpec.actual!;
    const cols = Math.ceil(img.width / width);
    this._ctx.drawImage(
      img,
      (tileId % cols) * width,
      Math.floor(tileId / cols) * height,
      width * count,
      height,
      col * width,
      row * height,
      width * count,
      height
    );
  }

  /**
   * Draw a line with placeholder on the image layer canvas.
   */
  public drawPlaceholder(col: number, row: number, count: number = 1): void {
    if ((this._placeholderBitmap || this._placeholder) && this._ctx) {
      const { width, height } = this.cellSize;
      if (height >= this._placeholder!.height) {
        this._createPlaceHolder(height + 1);
      }
      this._ctx.drawImage(
        this._placeholderBitmap || this._placeholder!,
        col * width,
        (row * height) % 2 ? 0 : 1,  // needs %2 offset correction
        width * count,
        height,
        col * width,
        row * height,
        width * count,
        height
      );
    }
  }

  /**
   * Rescale image layer canvas if needed.
   * Checked once from `ImageStorage.render`.
   */
  public rescaleCanvas(): void {
    if (!this.canvas) {
      return;
    }
    if (this.canvas.width !== this.dimensions?.canvasWidth || this.canvas.height !== this.dimensions.canvasHeight) {
      this.canvas.width = this.dimensions?.canvasWidth || 0;
      this.canvas.height = this.dimensions?.canvasHeight || 0;
    }
  }

  /**
   * Rescale image in storage if needed.
   *
   * FIXME: Currently rescaled images are not accounted on storage size.
   * This might create memory issues if the font size get enlarged alot.
   * (Doubling the font size will increase image memory 5 times!)
   */
  private _rescaleImage(is: IImageSpec, cw: number, ch: number): void {
    const { width: aw, height: ah } = is.actualCellSize;
    if (cw === aw && ch === ah) {
      return;
    }
    const { width: ow, height: oh } = is.origCellSize;
    if (cw === ow && ch === oh) {
      is.actual = is.orig;
      is.actualCellSize.width = ow;
      is.actualCellSize.height = oh;
      is.bitmap?.close();
      is.bitmap = undefined;
      ImageRenderer.createImageBitmap(is.actual!).then((bitmap) => is.bitmap = bitmap);
      return;
    }
    const canvas = ImageRenderer.createCanvas(
      Math.ceil(is.orig!.width * cw / ow),
      Math.ceil(is.orig!.height * ch / oh)
    );
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(is.orig!, 0, 0, canvas.width, canvas.height);
      is.actual = canvas;
      is.actualCellSize.width = cw;
      is.actualCellSize.height = ch;
      is.bitmap?.close();
      is.bitmap = undefined;
      ImageRenderer.createImageBitmap(canvas).then((bitmap) => is.bitmap = bitmap);
    }
  }

  /**
   * Lazy init for the renderer.
   */
  private _open(): void {
    this._rs = this._terminal._core._renderService;
    this._oldSetRenderer = this._rs.setRenderer.bind(this._rs);
    this._rs.setRenderer = (renderer: any) => {
      this._removeLayerFromDom();
      this._oldSetRenderer?.call(this._rs, renderer);
      this._insertLayerToDom();
    };
    this._insertLayerToDom();
    if (this._showPlaceholder) {
      this._createPlaceHolder();
    }
  }

  private _insertLayerToDom(): void {
    this.canvas = ImageRenderer.createCanvas(this.dimensions?.canvasWidth || 0, this.dimensions?.canvasHeight || 0);
    this.canvas.classList.add('xterm-image-layer');
    this._terminal._core.screenElement.appendChild(this.canvas);
    this._ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
  }

  private _removeLayerFromDom(): void {
    this.canvas?.parentNode?.removeChild(this.canvas);
  }

  private _createPlaceHolder(height: number = PLACEHOLDER_HEIGHT): void {
    this._placeholderBitmap?.close();
    this._placeholderBitmap = undefined;

    // create blueprint to fill placeholder with
    const bWidth = 32;  // must be 2^n
    const blueprint = ImageRenderer.createCanvas(bWidth, height);
    const ctx = blueprint.getContext('2d', {alpha: false});
    if (!ctx) return;
    const imgData = ImageRenderer.createImageData(ctx, bWidth, height);
    const d32 = new Uint32Array(imgData.data.buffer);
    const black = toRGBA8888(0, 0, 0);
    const white = toRGBA8888(255, 255, 255);
    d32.fill(black);
    for (let y = 0; y < height; ++y) {
      const shift = y % 2;
      const offset = y * bWidth;
      for (let x = 0; x < bWidth; x += 2) {
        d32[offset + x + shift] = white;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // create placeholder line, width aligned to blueprint width
    const width = (screen.width + bWidth - 1) & ~(bWidth - 1) || PLACEHOLDER_LENGTH;
    this._placeholder = ImageRenderer.createCanvas(width, height);
    const ctx2 = this._placeholder.getContext('2d', {alpha: false});
    if (!ctx2) {
      this._placeholder = undefined;
      return;
    }
    for (let i = 0; i < width; i += bWidth) {
      ctx2.drawImage(blueprint, i, 0);
    }

    ImageRenderer.createImageBitmap(this._placeholder).then(bitmap => this._placeholderBitmap = bitmap);
  }
}
