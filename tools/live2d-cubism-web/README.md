# WhiteMoon Cubism Web R5 product source

This directory is the small first-party build boundary for the product
renderer. It contains only the modified official R5 sample adapter files that
the runtime imports. SDK Framework source, Core, Haru, textures, and generated
bundle stay outside Git and are supplied explicitly at build/provision time.

Rebuild with existing dependencies and explicit paths:

```powershell
node tools/live2d-cubism-web/build-product.mjs `
  --sdk-root E:\WhiteMoon\work\live2d-sussurro-2026\phase1-runtime-decision\sdk `
  --work-dir E:\WhiteMoon\work\live2d-sussurro-2026\phase1-runtime-decision\product-build-task1 `
  --tool-root E:\WhiteMoon\work\live2d-sussurro-2026\phase1-runtime-decision\l0.1
```

For a branch-local rebuild, `--tool-root` may point to this directory after
copying `r5-shader-generation-patch.mjs` there. The script performs TypeScript
`noCheck=false` validation and a Vite IIFE build, then writes only to the
explicit work directory. Provisioning is separate and non-overwriting:

```powershell
node tools/live2d-cubism-web/provision-product-web.mjs --sdk-root <sdk> --runtime-dir <runtime-dir> --model-dir <Haru-dir> --profile-dir <new-profile>
```

The actual application UI/Host validation is owned by Task 2 and remains
`NOT RUN` for this Task 1 source package.
