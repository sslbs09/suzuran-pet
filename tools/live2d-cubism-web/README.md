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

Provision into the application's actual test user directory (for the direct
launcher this is `<outer-profile>/body-userdata`), so assets resolve beneath
`<test-user-directory>/assets`. A sibling outer-profile asset directory is not
the application's asset root.

The display alpha cache is filled after each completed draw, before READY.
Pointer queries read the cached image at any client coordinate. Its reusable
RGBA buffer is bound to the renderer owner, CSS rectangle, and actual drawing
buffer dimensions; failed reads and context loss invalidate the contour.
Alpha admission and Cubism logical hits remain separate. The original native
clickability controller and drag owner are unchanged.

Build r8 and its native Windows input were exercised in the isolated product
Body. The closure report under the explicit E: work directory records the
runtime, Chibi/P0 wall, performance measurements, exact bundle hash and limits.
This remains a locally provisioned TEST/SAMPLE mode, with no vendor model or
Core payload committed and no production Sussurro assets supplied.

For targeted checks, set `TASK1_BUNDLE` to the exact bundle produced by the
explicit build above, then run the three tests; an obsolete cached bundle is
never selected implicitly:

```powershell
$env:TASK1_BUNDLE = '<absolute-path-to-current-live2d-runtime.js>'
node --test tools/live2d-cubism-web/test/task1.test.mjs tools/live2d-cubism-web/test/texture-origin.test.mjs tools/live2d-cubism-web/test/alpha-frame.test.mjs
```
