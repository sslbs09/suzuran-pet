# Foundation M3: Observed Body Truth

M3 adds one authenticated, request-scoped debug read. It does not change
Character State, M2 execution results, or animation completion semantics.

## Ownership and limits

| Fact | Existing source | Meaning |
| --- | --- | --- |
| `generation` | main `beginBodyDocument` and M1 LifecycleProjection | Current document identity, checked against the sender and main frame |
| `posture.sleeping` | M1 main canonical sleep truth (`walk.sleeping`) | Current accepted sleep state; independent of clip names |
| `posture.dragging` | Current drag session, matching renderer pause lease and external token | Admitted active drag interaction; pointerdown alone is insufficient |
| `posture.visual` | No physical pose observer exists | Always `unknown`; PostureSupport is semantic control state |
| `animation` | Current renderer Spine owner, applied TrackEntry after natural screen `postrender` | Finite rendered track facts, including mixing; other render modes are `unsupported` |
| `geometry` | Live `BrowserWindow.getBounds()` | Native bounds read at publication, never a commanded target |

`animation.status="observed"` proves that the current applied track was
sampled after its owner/stage rendered to the screen canvas. It does not prove
OS compositor presentation, user perception, continuous playback, physical
posture, movement, or natural completion. A `Move` clip alone does not prove
walking: that requires independent native displacement evidence.

## Pull contract

The existing loopback Agent API exposes `GET /observed-state`. A configured
Body Bearer credential is required. Empty credential configuration denies
this route instead of exposing it.
Successful responses contain:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "bodyImplementationId": "suzuran-desktop-agent-v0.1",
  "generation": { "docEpoch": 123, "bodyGeneration": 123 },
  "posture": { "visual": "unknown", "sleeping": false, "dragging": false },
  "animation": {
    "status": "observed", "mode": "spine", "clip": "Relax",
    "track": 0, "loop": true, "trackTime": 0.5,
    "mixingFrom": null, "mixTime": 0, "mixDuration": 0,
    "sampledAt": 1700000000000
  },
  "geometry": { "x": 7, "y": 8, "width": 260, "height": 200 },
  "observedAt": 1700000000001
}
```

The example identifiers and timestamps are illustrative. `sampledAt` records
the rendered animation sample; `observedAt` records final main publication.
The fields are sampled in sequence, not an atomic cross-process world state.

No renderer frame/ACK, unready owner, mode change, or timeout produces
`animation: { status: "unknown", mode, clip: null, sampledAt: null }` while
generation, canonical sleep/drag and readable native bounds remain available.
Known non-Spine renderer modes return `unsupported` with null clip/time.
No readable live window produces HTTP 503 with
`{ "ok": false, "reason": "unavailable" }` and no snapshot.

## Freshness and cleanup

Main issues a fresh correlation id, sends `pet:observed-body-request`, and
accepts `pet:observed-body-truth` only through the existing M1 exact identity,
current webContents/mainFrame check and the current accepted render mode.
Preload supplies its captured private document identity after caller fields.
Renderer also checks its existing local owner/generation and rejects offscreen
measurement renders. The final main generation/native read and response
publication run together without another await between them.

Main requests are limited to 16 with a 750ms timeout; renderer requests to 16
with a 500ms timeout. Reload, crash, owner/mode replacement, teardown and reply
clear pending listeners/timers. Nothing is cached or persisted as current truth.

The existing M1 counter is seeded once per process with a cryptographic 48-bit
safe integer, then increments at document boundaries. Identity is compared by
equality. It is not a cross-process ordering clock; random seed collision has
a very small nonzero probability. The Electron navigation listener consumes
the installed runtime's actual first details argument, so raw reload advances
that same authority.

## Consumers and verification

Adapter `getObservedBodyTruth()` validates and copies the finite facts into
`{ status: "available", snapshot }`, without Body `ok` or extra fields.
Unavailable, invalid or timed-out reads have `snapshot: null`. Host's new
`GET /observed-state` requires its master token and relays through the injected
Adapter. An M2 adapter lacking the optional method reports `unsupported`.
The route never calls Core `observe()` and never derives facts from Intent.

`npm run e2e:whitemoon-observed` runs real Electron + production Adapter + Host
in unique disposable data directories. It checks native bounds, an unapplied
animation request, actual Move frame plus native displacement, sleep/wake,
pointer candidate versus drag/release, raw reload, late old-generation reply,
restart freshness, unavailable Body, and unchanged Character persistence.
The unit suites cover delayed/no-op native commits and all request boundaries.

Natural animation completion and physical visual posture remain deferred.
Body engine replaceability is **NOT YET DEMONSTRATED**. M3 does not authorize M4.
