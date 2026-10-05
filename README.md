# GravWell

3D convex rigid-body **contact queries** in TypeScript. Geometry only: no
time integration, no collision response, no world management.

## API

```ts
import { createHull, contact } from "gravwell";
```

### `createHull(points): Hull`

Builds a reusable convex body from an unordered point cloud given in local
coordinates. Duplicate, interior and coplanar non-extreme points are
discarded; boxes are defined simply by their 8 corners. The input must span
a non-degenerate 3D volume.

### `contact(hullA, poseA, hullB, poseB): ContactResult`

A pose is a translation plus a unit quaternion `[x, y, z, w]`. The result is
expressed in world coordinates:

- `distance` — signed distance.
  - Separated: the shortest euclidean distance between the bodies.
  - Penetrating: negative; its absolute value is the minimal translation
    length applied to B (A stays fixed) that removes the interior
    intersection. Full containment follows the same definition. Translating
    B by `-distance * normal` exactly eliminates the overlap.
- `normal` — unit vector; points from `pointA` toward `pointB` when
  separated.
- `pointA`, `pointB` — witness points on the surfaces of A and B.

The results always satisfy `pointB - pointA === distance * normal`. When the
optimum is not unique any valid solution may be returned.

## Method

- `createHull`: incremental beneath-beyond 3D convex hull.
- `contact`: GJK distance algorithm when separated (barycentric witnesses),
  EPA (expanding polytope) on the Minkowski difference when penetrating;
  the EPA boundary point closest to the origin gives the minimal
  translation for B, its direction the normal, and its barycentric
  combination the witness points.

## Build & test

Requires only Node.js. All tooling is in `devDependencies`.

```sh
npm install
npm test        # compiles with tsc and runs the node:test suite
```
