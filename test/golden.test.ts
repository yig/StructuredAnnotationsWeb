// Compares the port's geometry against reference geometry recorded from the desktop Python app.
// Generate the reference data with (from the repository root):
//     venv/bin/python web/tools/golden.py web/test/golden scenes/collection/.../*.annscene
// Scenes without reference data are skipped.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Scene, SceneData } from '../src/core/scene';
import { Cylinder } from '../src/core/cylinder';
import { Ellipsoid } from '../src/core/ellipsoid';
import { TriMesh } from '../src/core/mesh';
import { solveScene } from '../src/core/solve';

const kScenesDir = join( __dirname, '..', 'public', 'scenes' );
const kGoldenDir = join( __dirname, 'golden' );

interface GoldenMesh { vs: number[][], faces: number[][] }
interface GoldenShape {
    spine3d?: number[][]; denseRadii?: number[]; symmetryDirections?: number[][];
    denseCrossSections?: number[][][]; boundary2d?: number[][]; spine2d?: number[][];
    center?: number[]; axes?: number[][]; ellipse?: number[][];
    mesh: GoldenMesh;
}
interface Golden { raw: Record<string, GoldenShape>, solved: Record<string, GoldenShape>, mirrored: GoldenMesh[] }

// Scenes whose JSON intentionally differs from the desktop app's data (see tools/annscene2json.py).
const kKnownSolvedDifferences = new Set( [ '090424-the-civilian' ] );

// The spine depth solve (a 1e7-weighted soft constraint) is badly conditioned (condition numbers
// up to ~1e16), so the desktop implementation and this port both deviate from the exact solution
// by up to ~1e-4 in places, in different ways.  Compare with a tolerance of 0.05% of the image width.
const kTol = 1e-3;

function maxAbsDiff( a: number[] | number[][], b: number[] | number[][] ): number {
    const fa = ( a as number[] ).flat( 2 ) as number[];
    const fb = ( b as number[] ).flat( 2 ) as number[];
    if( fa.length !== fb.length ) return Infinity;
    let m = 0;
    for( let i = 0; i < fa.length; ++i ) m = Math.max( m, Math.abs( fa[i] - fb[i] ) );
    return m;
}

function expectClose( actual: number[] | number[][], expected: number[] | number[][], what: string ): void {
    const d = maxAbsDiff( actual, expected );
    expect( d, `${ what }: max abs difference ${ d }` ).toBeLessThan( kTol );
}

function expectMesh( mesh: TriMesh, golden: GoldenMesh, what: string ): void {
    expect( mesh.faces, `${ what } faces` ).toEqual( golden.faces );
    expectClose( mesh.vs, golden.vs, `${ what } vertices` );
}

// The largest distance from a vertex of one point set to the nearest vertex of the other
// (the Hausdorff distance between the vertex sets), for comparing meshes whose components are
// in a different order.
function vertexSetDistance( a: number[][], b: number[][] ): number {
    const oneSided = ( p: number[][], q: number[][] ) => {
        let worst = 0;
        for( const u of p ) {
            let best = Infinity;
            for( const v of q ) best = Math.min( best, ( u[0] - v[0] ) ** 2 + ( u[1] - v[1] ) ** 2 + ( u[2] - v[2] ) ** 2 );
            worst = Math.max( worst, best );
        }
        return Math.sqrt( worst );
    };
    return Math.max( oneSided( a, b ), oneSided( b, a ) );
}

const sceneNames = existsSync( kGoldenDir )
    ? readdirSync( kGoldenDir ).filter( f => f.endsWith( '.golden.json' ) ).map( f => f.slice( 0, -'.golden.json'.length ) ).sort()
    : [];

describe.skipIf( sceneNames.length === 0 )( 'matches the desktop implementation', () => {
    for( const name of sceneNames ) {
        describe( name, () => {
            const data: SceneData = JSON.parse( readFileSync( join( kScenesDir, name + '.json' ), 'utf8' ) );
            const golden: Golden = JSON.parse( readFileSync( join( kGoldenDir, name + '.golden.json' ), 'utf8' ) );

            it( 'primitives', () => {
                const scene = Scene.fromData( data );
                for( const shape of scene.shapes ) {
                    const g = golden.raw[ shape.id ];
                    expect( g, `golden data for shape ${ shape.id }` ).toBeDefined();
                    if( shape instanceof Cylinder ) {
                        expectClose( shape.spine3d, g.spine3d!, `${ shape.id } spine3d` );
                        expectClose( shape.denseRadii, g.denseRadii!, `${ shape.id } dense radii` );
                        expectClose( shape.symmetryDirections, g.symmetryDirections!, `${ shape.id } symmetry directions` );
                        if( shape.crossSections.size > 0 ) expectClose( shape.denseCrossSections.flat(), g.denseCrossSections!.flat(), `${ shape.id } cross sections` );
                        expectClose( shape.boundary2d, g.boundary2d!, `${ shape.id } boundary` );
                        expectMesh( shape.mesh, g.mesh, `${ shape.id } mesh` );
                    } else {
                        expectMesh( shape.mesh, g.mesh, `${ shape.id } mesh` );
                    }
                }
            } );

            it.skipIf( kKnownSolvedDifferences.has( name ) )( 'annotations', () => {
                const scene = Scene.fromData( data );
                const solved = solveScene( scene );
                for( const [ id, shape ] of solved.shapes ) {
                    const g = golden.solved[ id ];
                    if( shape instanceof Cylinder ) {
                        expectClose( shape.spine2d, g.spine2d!, `${ id } solved spine2d` );
                        expectClose( shape.spine3d, g.spine3d!, `${ id } solved spine3d` );
                        expectMesh( shape.mesh, g.mesh, `${ id } solved mesh` );
                    } else if( shape instanceof Ellipsoid ) {
                        expectClose( shape.center, g.center!, `${ id } solved center` );
                        expectClose( shape.axes, g.axes!, `${ id } solved axes` );
                    }
                }
                expect( solved.mirrored.length ).toBe( golden.mirrored.length );
                solved.mirrored.forEach( ( { mesh }, i ) => {
                    expect( mesh.faces.length ).toBe( golden.mirrored[i].faces.length );
                    const d = vertexSetDistance( mesh.vs, golden.mirrored[i].vs );
                    expect( d, `mirrored mesh ${ i }: vertex set distance ${ d }` ).toBeLessThan( kTol );
                } );
            } );
        } );
    }
} );
