# Structured Annotations for 2D-to-3D Modeling — web port

A browser port of the desktop program in the parent directory, which implements the SIGGRAPH Asia 2009
paper *Structured Annotations for 2D-to-3D Modeling* by Yotam Gingold, Takeo Igarashi, and Denis Zorin
(`../paper.tex`). It is a TypeScript rewrite: the 2D annotation view is an HTML canvas and the 3D
preview uses three.js. It runs entirely in the browser.

## Running

    npm install
    npm run dev        # development server
    npm run build      # static site in dist/ (relative paths; can be hosted from any directory)
    npm test           # unit tests, and comparisons against the desktop app (see Testing)

Open a scene from the *Example* menu (or with `?scene=<file>.json` in the URL), start a new one, or open
a saved `.json` file. *Guide Image…* sets the image to trace; it is embedded in saved scenes.
*Export OBJ* writes the 3D model, one object per primitive (and per mirrored copy).

## Tools

The paper's primitives and annotations, with the desktop app's interactions:

| Tool | Key | |
|---|---|---|
| Select | V | Click a shape to show its handles. Drag tilt handles to lift the shape out of the image plane, scale handles to stretch the outline (Alt: scale symmetrically), end handles to set the end-cap size, the symmetry handle to orient the symmetry sheet. Drag the spine to deform it (Alt: add a tilt handle); drag the outline to add a scale handle. Click a cross section to edit its shape. Shift-click adds to the selection, Cmd/Ctrl-drag moves the selection. Right-click for more (over-sketch, smooth, resample, straighten, add/delete handles, lock). Delete removes selected shapes. |
| Cylinder | C | Draw a spine (Shift: straight). |
| Ellipsoid | E | Draw an outline; an ellipse is fit to it. |
| Connect | K | Drag where two overlapping shapes should meet; this places them in depth. Right-click for front/back attachment, drawing the curve, or disconnecting. |
| Same tilt / length / scale | T / L / R | Click a cross section, spine, or diameter to start or choose a group, then click others to add them. Delete removes the item under the mouse. |
| Mirror | M | Click a shape, then a connected shape to mirror it (and what's attached to it) across. |
| Align / Center | A / X | Align two shapes symmetrically across a shape both are connected to, or center one on a connected shape's symmetry sheet. |
| Pan / Zoom | H / Z | Also: scroll to zoom, middle-drag or Space-drag to pan. |

Undo/redo with Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z.

## Code

- `src/core/` — the modeling code, independent of the UI:
  - `cylinder.ts`, `spine.ts`, `sweepSurface.ts`, `distanceField.ts`: generalized cylinders (the 3D spine
    from cross section tilts, smooth interpolation of attributes along the spine, sweeping cross sections
    with end caps, and the smoothed distance field that keeps the surface from pinching).
  - `ellipsoid.ts`: ellipsoids.
  - `solve.ts`: applying annotations in the paper's order (same tilt, same scale, connections, same
    length, alignment, mirroring).
  - `scene.ts`: the scene model and its JSON format (documented at the top of the file).
  - `edit.ts`, `curves.ts`, `intersections.ts`: editing operations and 2D curve utilities used by the tools.
- `src/ui/` — the views, tools, and application.
- `tools/` — Python scripts run with the desktop app's environment:
  - `annscene2json.py` converts desktop `.annscene` scenes to JSON (`public/scenes/` holds the 47 scenes
    from `../scenes/collection`, excluding autosave `sessions/` folders).
  - `golden.py` records reference geometry from the desktop implementation for testing.

The port follows the desktop code closely; comments name the Python functions each part ports.

## Testing

`test/golden.test.ts` builds every converted scene and compares the primitives' geometry (3D spines,
radii, symmetry directions, cross sections, outlines, meshes) and the solved model (after all
annotations, including mirrored copies) against geometry recorded from the desktop app. The reference
data is large, so it isn't committed; generate it from the repository root with

    find scenes/collection -name '*.annscene' -not -path '*/sessions/*' -print0 \
        | xargs -0 venv/bin/python web/tools/golden.py web/test/golden

The comparison tolerance is 1e-3 (in image-width units of 2). The 3D spine solve is badly conditioned
(condition numbers up to ~1e16, from its 1e7-weighted soft constraints), so both implementations differ
from the exact solution by up to ~1e-4 in places, in different ways; everything else agrees to rounding.

## Differences from the desktop app

- Only the paper's features are ported. Not ported: cuboids, FiberMesh-style "rotund" shapes, the
  symmetry cross section shapes, oblique projection, and "Redraw Silhouette" (disabled in the desktop app).
- One converted scene (`090424-the-civilian`) had a same-length annotation referring to a deleted
  connection; it now refers to the live connection between the same shapes, so its solved model
  differs slightly from the desktop app's (its test is skipped).
- Annotation group colors are derived from the group's position in the list rather than chosen randomly.
- Locked shapes, as in the desktop app, are not saved with the scene.
