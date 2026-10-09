/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { ACubismMotion } from '@framework/motion/acubismmotion';
import { CubismWebGLOffscreenManager } from '@framework/rendering/cubismoffscreenmanager';

import * as LAppDefine from './lappdefine';
import { LAppModel } from './lappmodel';
import { LAppPal } from './lapppal';
import { LAppSubdelegate } from './lappsubdelegate';

/**
 * サンプルアプリケーションにおいてCubismModelを管理するクラス
 * モデル生成と破棄、タップイベントの処理、モデル切り替えを行う。
 */
export class LAppLive2DManager {
  /**
   * 現在のシーンで保持しているすべてのモデルを解放する
   */
  private releaseAllModel(): void {
    for (const model of this._models) {
      model.release();
    }
    this._models.length = 0;
  }

  public getModel(): LAppModel | null {
    return this._models[0] ?? null;
  }
  public getObservedParameters() { return this.getModel()?.getObservedParameters() ?? null; }
  public stop(): void {
    const model = this.getModel();
    if (!model) return;
    model.stopLipSync();
    model.setManualMouthOpen(0);
    model.clearExpression();
  }
  private _hitProjection = new CubismMatrix44();
  public hitAtClient(x: number, y: number): string | null {
    const canvas=this._subdelegate.getCanvas(), m=this.getModel();
    if(!m?.isRendererReady() || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const nx=2*x/canvas.clientWidth-1, ny=1-2*y/canvas.clientHeight;
    const wx=this._hitProjection.invertTransformX(nx), wy=this._hitProjection.invertTransformY(ny);
    return m.hitTest(LAppDefine.HitAreaNameHead,wx,wy)?'head':m.hitTest(LAppDefine.HitAreaNameBody,wx,wy)?'body':null;
  }

  public reloadModel(): void {
    this.changeScene(this._sceneIndex);
  }

  public setMood(_mood: string): void { this._models[0]?.setRandomExpression(); }
  public poke(): void {
    this._models[0]?.startRandomMotion(LAppDefine.MotionGroupTapBody, LAppDefine.PriorityNormal, this.finishedMotion, this.beganMotion);
  }
  public command(command: { type?: string; value?: number; x?: number; y?: number; name?: string }): void {
    const model = this._models[0];
    if (!model) return;
    if (command.type === 'mouth') model.setManualMouthOpen(Number(command.value));
    else if (command.type === 'look') model.setDragging(Number(command.x) || 0, Number(command.y) || 0);
    else if (command.type === 'expression' && command.name) {
      if (command.name === 'neutral') model.clearExpression(); else model.setRandomExpression();
    }
    else if (command.type === 'motion' && command.name) {
      const group = command.name === 'idle' ? LAppDefine.MotionGroupIdle : LAppDefine.MotionGroupTapBody;
      model.startRandomMotion(group, LAppDefine.PriorityNormal, this.finishedMotion, this.beganMotion);
    }
    else if (command.type === 'neutral' || command.type === 'stop') {
      model.stopLipSync();
      model.setManualMouthOpen(0);
      model.clearExpression();
    }
  }

  public setOffscreenSize(width: number, height: number): void {
    for (let i = 0; i < this._models.length; i++) {
      const model: LAppModel = this._models[i];
      model?.setRenderTargetSize(width, height);
    }
  }

  /**
   * 画面をドラッグした時の処理
   *
   * @param x 画面のX座標
   * @param y 画面のY座標
   */
  public onDrag(x: number, y: number): void {
    const model: LAppModel = this._models[0];
    if (model) {
      model.setDragging(x, y);
    }
  }

  /**
   * 画面をタップした時の処理
   *
   * @param x 画面のX座標
   * @param y 画面のY座標
   */
  public onTap(x: number, y: number): void {
    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(
        `[APP]tap point: {x: ${x.toFixed(2)} y: ${y.toFixed(2)}}`
      );
    }

    const model: LAppModel = this._models[0];

    if (model.hitTest(LAppDefine.HitAreaNameHead, x, y)) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit area: [${LAppDefine.HitAreaNameHead}]`);
      }
      model.setRandomExpression();
    } else if (model.hitTest(LAppDefine.HitAreaNameBody, x, y)) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit area: [${LAppDefine.HitAreaNameBody}]`);
      }
      model.startRandomMotion(
        LAppDefine.MotionGroupTapBody,
        LAppDefine.PriorityNormal,
        this.finishedMotion,
        this.beganMotion
      );
    }
  }

  /**
   * 画面を更新するときの処理
   * モデルの更新処理及び描画処理を行う
   */
  public onUpdate(): void {
    // 全てのモデルの描画処理開始前に、フレームごとのリセットフラグをクリアする
    const gl = this._subdelegate.getGl();
    CubismWebGLOffscreenManager.getInstance().beginFrameProcess(gl);

    const { width, height } = this._subdelegate.getCanvas();

    const projection: CubismMatrix44 = new CubismMatrix44();
    const model: LAppModel = this._models[0];

    if (model.getModel()) {
      if (model.getModel().getCanvasWidth() > 1.0 && width < height) {
        // 横に長いモデルを縦長ウィンドウに表示する際モデルの横サイズでscaleを算出する
        model.getModelMatrix().setWidth(2.0);
        projection.scale(1.0, width / height);
      } else {
        projection.scale(height / width, 1.0);
      }

      // 必要があればここで乗算
      if (this._viewMatrix != null) {
        projection.multiplyByMatrix(this._viewMatrix);
      }
    }

    model.update();
    this._hitProjection.getArray().set(projection.getArray());
    model.draw(projection); // 参照渡しなのでprojectionは変質する。

    // モデルで使用するオフスクリーン管理の終了処理
    CubismWebGLOffscreenManager.getInstance().endFrameProcess(gl);
    // もし余っているオフスクリーンのリソースを解放したい場合行う処理
    CubismWebGLOffscreenManager.getInstance().releaseStaleRenderTextures(gl);
  }

  /**
   * 次のシーンに切りかえる
   * サンプルアプリケーションではモデルセットの切り替えを行う。
   */
  public nextScene(): void {
    const no: number = (this._sceneIndex + 1) % LAppDefine.ModelDirSize;
    this.changeScene(no);
  }

  /**
   * シーンを切り替える
   * サンプルアプリケーションではモデルセットの切り替えを行う。
   * @param index
   */
  private changeScene(index: number): void {
    this._sceneIndex = index;

    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(`[APP]model index: ${this._sceneIndex}`);
    }

    // ModelDir[]に保持したディレクトリ名から
    // model3.jsonのパスを決定する。
    // ディレクトリ名とmodel3.jsonの名前を一致させておくこと。
    const model: string = LAppDefine.ModelDir[index];
    let modelPath: string = LAppDefine.ResourcesPath + model + '/';
    let modelJsonName: string = model + '.model3.json';
    if (this._modelURL) {
      const slash = this._modelURL.lastIndexOf('/');
      modelPath = this._modelURL.slice(0, slash + 1);
      modelJsonName = this._modelURL.slice(slash + 1);
    }

    this.releaseAllModel();
    const instance = new LAppModel();
    instance.setSubdelegate(this._subdelegate);
    if (this._shaderURL) instance.setShaderPath(this._shaderURL);
    instance.loadAssets(modelPath, modelJsonName);
    this._models.push(instance);
  }

  public setViewMatrix(m: CubismMatrix44) {
    for (let i = 0; i < 16; i++) {
      this._viewMatrix.getArray()[i] = m.getArray()[i];
    }
  }

  /**
   * モデルの追加
   */
  public addModel(sceneIndex: number = 0): void {
    this._sceneIndex = sceneIndex;
    this.changeScene(this._sceneIndex);
  }

  /**
   * コンストラクタ
   */
  public constructor() {
    this._subdelegate = null;
    this._viewMatrix = new CubismMatrix44();
    this._models = new Array<LAppModel>();
    this._sceneIndex = 0;
  }

  /**
   * 解放する。
   */
  public release(): void { this.releaseAllModel(); }

  /**
   * 初期化する。
   * @param subdelegate
   */
  public initialize(subdelegate: LAppSubdelegate, options: { modelURL?: string; shaderURL?: string } = {}): void {
    this._subdelegate = subdelegate;
    this._modelURL = options.modelURL || '';
    this._shaderURL = options.shaderURL || '';
    this.changeScene(this._sceneIndex);
  }

  /**
   * 自身が所属するSubdelegate
   */
  private _subdelegate: LAppSubdelegate;

  _viewMatrix: CubismMatrix44; // モデル描画に用いるview行列
  _models: Array<LAppModel>; // モデルインスタンスのコンテナ
  private _sceneIndex: number; // 表示するシーンのインデックス値
  private _modelURL = '';
  private _shaderURL = '';

  // モーション再生開始のコールバック関数
  beganMotion = (self: ACubismMotion): void => {
    LAppPal.printMessage('Motion Began:');
    console.log(self);
  };
  // モーション再生終了のコールバック関数
  finishedMotion = (self: ACubismMotion): void => {
    LAppPal.printMessage('Motion Finished:');
    console.log(self);
  };
}
