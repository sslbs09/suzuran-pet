/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppGlManager } from './lappglmanager';

/**
 * テクスチャ管理クラス
 * 画像読み込み、管理を行うクラス。
 */
export class LAppTextureManager {
  private _released = false;
  private _pending = new Set<() => void>();
  /**
   * コンストラクタ
   */
  public constructor() {
    this._textures = new Array<TextureInfo>();
  }

  /**
   * 解放する。
   */
  public release(): void {
    if (this._released) return;
    this._released = true;
    this.releaseTextures();
  }

  /**
   * 画像読み込み
   *
   * @param fileName 読み込む画像ファイルパス名
   * @param usePremultiply Premult処理を有効にするか
   * @return 画像情報、読み込み失敗時はnullを返す
   */
  public createTextureFromPngFile(
    fileName: string,
    usePremultiply: boolean,
    callback: (textureInfo: TextureInfo) => void,
    isCurrent: () => boolean = () => true
  ): void {
    if (this._released || !isCurrent()) return;
    const cached = this._textures.find(texture =>
      texture.fileName === fileName && texture.usePremultply === usePremultiply);
    if (cached) {
      queueMicrotask(() => {
        if (!this._released && isCurrent() && this._textures.includes(cached)) callback(cached);
      });
      return;
    }

    // The product document and its restricted pet-user protocol have different
    // origins. Read permitted bytes, then decode a document-owned Blob image;
    // direct protocol Image.src can taint the source of WebGL texImage2D.
    const controller = new AbortController();
    const img = new Image();
    let objectURL: string | null = null;
    let cancelled = false;
    const current = () => !cancelled && !this._released && isCurrent();
    const notifyFailure = (reason: string) => {
      if (current()) window.dispatchEvent(new CustomEvent('cubism-asset-error', { detail: { reason } }));
    };
    const cleanup = () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
      this._pending.delete(cancel);
    };
    const cancel = () => { cancelled = true; controller.abort(); cleanup(); };
    const onError = () => { notifyFailure('texture-image-decode-failed'); cleanup(); };
    const onLoad = () => {
      if (!current()) { cleanup(); return; }
      const gl = this._glManager.getGl();
      let tex: WebGLTexture | null = null;
      try {
        tex = gl.createTexture();
        if (!tex) throw new Error('texture allocation failed');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, usePremultiply ? 1 : 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, null);
        const info = new TextureInfo();
        Object.assign(info, { fileName, width: img.width, height: img.height, id: tex, img, usePremultply: usePremultiply });
        this._textures.push(info);
        callback(info);
      } catch {
        this._textures = this._textures.filter(texture => texture.id !== tex);
        if (tex) gl.deleteTexture(tex);
        notifyFailure('texture-upload-failed');
      } finally { cleanup(); }
    };
    img.addEventListener('load', onLoad, { passive: true });
    img.addEventListener('error', onError, { passive: true });
    this._pending.add(cancel);
    void (async () => {
      try {
        const response = await fetch(fileName, { signal: controller.signal });
        if (!current()) { cleanup(); return; }
        if (!response.ok) throw new Error('texture response unavailable');
        const bytes = await response.blob();
        if (!current()) { cleanup(); return; }
        objectURL = URL.createObjectURL(bytes);
        img.src = objectURL;
      } catch {
        notifyFailure('texture-bytes-load-failed');
        cleanup();
      }
    })();
  }

  /**
   * 画像の解放
   *
   * 配列に存在する画像全てを解放する。
   */
  public releaseTextures(): void {
    for (const cancel of [...this._pending]) cancel();
    for (let i = 0; i < this._textures.length; i++) {
      this._glManager.getGl().deleteTexture(this._textures[i].id);
      this._textures[i] = null;
    }

    this._textures.length = 0;
  }

  /**
   * 画像の解放
   *
   * 指定したテクスチャの画像を解放する。
   * @param texture 解放するテクスチャ
   */
  public releaseTextureByTexture(texture: WebGLTexture): void {
    for (let i = 0; i < this._textures.length; i++) {
      if (this._textures[i].id != texture) {
        continue;
      }

      this._glManager.getGl().deleteTexture(this._textures[i].id);
      this._textures[i] = null;
      this._textures.splice(i, 1);
      break;
    }
  }

  /**
   * 画像の解放
   *
   * 指定した名前の画像を解放する。
   * @param fileName 解放する画像ファイルパス名
   */
  public releaseTextureByFilePath(fileName: string): void {
    for (let i = 0; i < this._textures.length; i++) {
      if (this._textures[i].fileName == fileName) {
        this._glManager.getGl().deleteTexture(this._textures[i].id);
        this._textures[i] = null;
        this._textures.splice(i, 1);
        break;
      }
    }
  }

  /**
   * setter
   * @param glManager
   */
  public setGlManager(glManager: LAppGlManager): void {
    this._glManager = glManager;
  }

  _textures: Array<TextureInfo>;
  private _glManager: LAppGlManager;
}

/**
 * 画像情報構造体
 */
export class TextureInfo {
  img: HTMLImageElement; // 画像
  id: WebGLTexture = null; // テクスチャ
  width = 0; // 横幅
  height = 0; // 高さ
  usePremultply: boolean; // Premult処理を有効にするか
  fileName: string; // ファイル名
}
