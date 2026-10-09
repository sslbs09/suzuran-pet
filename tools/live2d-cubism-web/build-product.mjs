import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function required(name) {
  const value = arg(name);
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

const sdkRoot = required('--sdk-root');
const workDir = required('--work-dir');
const toolRoot = required('--tool-root');
const here = path.dirname(fileURLToPath(import.meta.url));
const sdkFramework = path.join(sdkRoot, 'web-r5/CubismSdkForWeb-5-r.5/Framework/src');
if (!fs.existsSync(sdkFramework)) throw new Error(`SDK Framework not found: ${sdkFramework}`);
if (!fs.existsSync(path.join(toolRoot, 'r5-shader-generation-patch.mjs'))) throw new Error('shader patch not found under --tool-root');
fs.mkdirSync(workDir, { recursive: true });

const template = JSON.parse(fs.readFileSync(path.join(here, 'tsconfig.product.json'), 'utf8'));
template.compilerOptions.paths['@framework/*'] = [path.join(sdkFramework, '*').replaceAll('\\', '/')];
delete template.compilerOptions.types;
template.include = [path.join(here, 'src/**/*.ts').replaceAll('\\', '/')];
const generatedTsconfig = path.join(workDir, 'tsconfig.product.generated.json');
fs.writeFileSync(generatedTsconfig, JSON.stringify(template, null, 2));

const dependencyRoot = fs.existsSync(path.join(here, 'node_modules', '.bin'))
  ? path.join(here, 'node_modules')
  : path.join(here, '..', '..', 'node_modules');
const moduleEntry = (name) => path.join(dependencyRoot, name === 'tsc' ? 'typescript/bin/tsc' : 'vite/bin/vite.js');
const runTool = (name, args) => execFileSync(process.execPath, [moduleEntry(name), ...args], { cwd: here, env, stdio: 'inherit' });
const env = { ...process.env, WM_SDK_ROOT: sdkRoot, WM_WORK_DIR: workDir, WM_TOOL_ROOT: toolRoot, WM_SOURCE_ROOT: here };
runTool('tsc', ['-p', generatedTsconfig, '--noEmit']);
runTool('vite', ['build', '--config', path.join(here, 'vite.config.mts')]);
console.log(`product bundle: ${path.join(workDir, 'dist/live2d-runtime/live2d-runtime.js')}`);
