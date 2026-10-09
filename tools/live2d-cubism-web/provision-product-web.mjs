import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function copyTree(source, destination) {
  await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

export async function provisionProductWeb({ sdkRoot, runtimeDir, modelDir, profileDir }) {
  for (const [name, value] of Object.entries({ sdkRoot, runtimeDir, modelDir, profileDir })) {
    if (!value || typeof value !== 'string') throw new Error(`${name} is required`);
  }
  const core = path.join(sdkRoot, 'Core', 'live2dcubismcore.js');
  const shaders = path.join(sdkRoot, 'Framework', 'Shaders', 'WebGL');
  const runtime = path.join(runtimeDir, 'live2d-runtime.js');
  const modelJson = path.join(modelDir, 'Haru.model3.json');
  for (const [name, value] of Object.entries({ core, shaders, runtime, modelJson })) {
    if (!await exists(value)) throw new Error(`missing ${name}: ${value}`);
  }
  const assetRoot = path.join(profileDir, 'assets');
  const runtimeTarget = path.join(assetRoot, 'live2d-runtime');
  const shaderTarget = path.join(runtimeTarget, 'Framework', 'Shaders', 'WebGL');
  const modelTarget = path.join(assetRoot, 'live2d', 'Haru');
  if (await exists(runtimeTarget) || await exists(modelTarget)) {
    throw new Error(`refusing to overwrite existing product assets under ${assetRoot}`);
  }
  await fs.mkdir(path.join(runtimeTarget, 'Framework', 'Shaders'), { recursive: true });
  await fs.mkdir(path.join(assetRoot, 'live2d'), { recursive: true });
  await fs.copyFile(core, path.join(runtimeTarget, 'live2dcubismcore.js'), fs.constants.COPYFILE_EXCL);
  await fs.copyFile(runtime, path.join(runtimeTarget, 'live2d-runtime.js'), fs.constants.COPYFILE_EXCL);
  await copyTree(shaders, shaderTarget);
  await copyTree(modelDir, modelTarget);
  return {
    provisioned: true,
    profileDir,
    coreURL: 'pet-user://live2d-runtime/live2dcubismcore.js',
    runtimeURL: 'pet-user://live2d-runtime/live2d-runtime.js',
    shaderURL: 'pet-user://live2d-runtime/Framework/Shaders/WebGL/',
    modelURL: 'pet-user://live2d/Haru/Haru.model3.json'
  };
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {
    sdkRoot: flag(args, '--sdk-root'),
    runtimeDir: flag(args, '--runtime-dir'),
    modelDir: flag(args, '--model-dir'),
    profileDir: flag(args, '--profile-dir')
  };
  provisionProductWeb(options).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
