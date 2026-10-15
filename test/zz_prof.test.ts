import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Scene } from '../src/core/scene';
import { solveScene } from '../src/core/solve';
import * as mesh from '../src/core/mesh';
it( 'prof', () => {
    const scene = Scene.fromData( JSON.parse( readFileSync( `public/scenes/kat-girl2.json`, 'utf8' ) ) );
    solveScene( scene );
    const proto = ( globalThis as any );
    const t0 = performance.now();
    solveScene( scene );
    console.log( 'total', ( performance.now() - t0 ).toFixed( 0 ) );
    void proto; void mesh;
} );
