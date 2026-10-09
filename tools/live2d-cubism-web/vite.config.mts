import { defineConfig } from 'vite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sdkRoot = process.env.WM_SDK_ROOT;
const workDir = process.env.WM_WORK_DIR;
const toolRoot = process.env.WM_TOOL_ROOT;
const sourceRoot = process.env.WM_SOURCE_ROOT;
if (!sdkRoot || !workDir || !toolRoot || !sourceRoot) throw new Error('WM_SDK_ROOT, WM_WORK_DIR, WM_TOOL_ROOT and WM_SOURCE_ROOT are required');
const { patchR5Shader } = await import(pathToFileURL(path.join(toolRoot, 'r5-shader-generation-patch.mjs')).href);
const frameworkRoot = path.resolve(sdkRoot, 'web-r5/CubismSdkForWeb-5-r.5/Framework/src');

export default defineConfig({
  plugins: [{
    name: 'whitemoon-r5-shader-generation-fence',
    enforce: 'pre',
    transform(source, id) {
      if (id.replaceAll('\\', '/').endsWith('CubismSdkForWeb-5-r.5/Framework/src/rendering/cubismshader_webgl.ts')) {
        return { code: patchR5Shader(source), map: null };
      }
      return undefined;
    }
  }],
  resolve: { alias: { '@framework': frameworkRoot } },
  build: {
    target: 'es2022',
    lib: { entry: path.resolve(sourceRoot, 'src/runtime.ts'), name: 'Live2DRuntime', formats: ['iife'], fileName: () => 'live2d-runtime.js' },
    outDir: path.resolve(workDir, 'dist/live2d-runtime'),
    emptyOutDir: true,
    sourcemap: true
  }
});
