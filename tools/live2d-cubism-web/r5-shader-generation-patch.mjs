// Narrow R5 build compatibility patch. The original SDK source/archive stays unchanged.
export function patchR5Shader(source) {
  const changes=[
    ['export class CubismShader_WebGL {','export class CubismShader_WebGL {\n  private _l01Disposed = false;'],
    ['  public releaseShaderProgram(): void {','  public releaseShaderProgram(): void {\n    this._l01Disposed = true;'],
    ['      this.gl.deleteProgram(this._shaderSets[i].shaderProgram);','      if (!this._shaderSets[i]) continue;\n      this.gl.deleteProgram(this._shaderSets[i].shaderProgram);'],
    ['  public generateShaders(): void {','  public generateShaders(): void {\n    if (this._l01Disposed) return;'],
    ['        this.registerShader(); // 通常シェーダーの登録','        if (this._l01Disposed) return;\n        this.registerShader(); // 通常シェーダーの登録']
  ];
  for(const [from,to] of changes){if(source.split(from).length!==2)throw Error('R5 shader lifecycle patch target changed');source=source.replace(from,to);}
  return source;
}
