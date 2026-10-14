import { describe, it, expect } from 'vitest';
import { fitEllipse, laplacianCurveEdit, resampleLineStrip, normalizeCrossSection, smoothClosedStroke, contourContains } from '../src/core/curves';
import { triTriSegment } from '../src/core/intersections';
import { Vec2, Vec3, mag } from '../src/core/vec';

describe( 'curves', () => {
    it( 'fits an ellipse to points on an ellipse', () => {
        const angle = 0.3;
        const pts: Vec2[] = [];
        for( let i = 0; i < 40; ++i ) {
            const th = 2 * Math.PI * i / 40;
            const x = 0.5 * Math.cos( th ), y = 0.2 * Math.sin( th );
            pts.push( [ 0.1 + Math.cos( angle ) * x - Math.sin( angle ) * y, -0.3 + Math.sin( angle ) * x + Math.cos( angle ) * y ] );
        }
        const e = fitEllipse( pts )!;
        expect( e ).not.toBeNull();
        expect( e[0][0] ).toBeCloseTo( 0.1, 6 );
        expect( e[0][1] ).toBeCloseTo( -0.3, 6 );
        expect( mag( e[1] ) ).toBeCloseTo( 0.5, 6 );
        expect( mag( e[2] ) ).toBeCloseTo( 0.2, 6 );
        expect( Math.abs( e[1][1] / e[1][0] ) ).toBeCloseTo( Math.tan( angle ), 6 );
    } );

    it( 'Laplacian editing with constraints at the current positions leaves a curve unchanged', () => {
        const curve: Vec2[] = Array.from( { length: 12 }, ( _, i ) => [ i / 11, Math.sin( i / 3 ) * 0.2 ] );
        const out = laplacianCurveEdit( curve, [ [ 0, curve[0] ], [ 11, curve[11] ], [ 5, curve[5] ] ] );
        out.forEach( ( p, i ) => { expect( p[0] ).toBeCloseTo( curve[i][0], 5 ); expect( p[1] ).toBeCloseTo( curve[i][1], 5 ); } );
    } );

    it( 'Laplacian editing moves a constrained point', () => {
        const curve: Vec2[] = Array.from( { length: 12 }, ( _, i ) => [ i / 11, 0 ] );
        const out = laplacianCurveEdit( curve, [ [ 0, curve[0] ], [ 11, curve[11] ], [ 5, [ 5 / 11, 0.3 ] ] ] );
        // The constraint is soft (weighted like the rigidity term), as in the original.
        expect( out[5][1] ).toBeCloseTo( 0.3, 2 );
        expect( out[3][1] ).toBeGreaterThan( 0.05 );
    } );

    it( 'resamples evenly by arc length', () => {
        const out = resampleLineStrip( [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ] ], 5 );
        expect( out ).toEqual( [ [ 0, 0 ], [ 0.5, 0 ], [ 1, 0 ], [ 1, 0.5 ], [ 1, 1 ] ] );
    } );

    it( 'normalizes cross sections to be counter-clockwise with unit radius', () => {
        const cw: Vec2[] = Array.from( { length: 21 }, ( _, i ) => [ 2 + 3 * Math.cos( -2 * Math.PI * i / 21 ), 3 * Math.sin( -2 * Math.PI * i / 21 ) ] );
        const out = normalizeCrossSection( cw );
        let area = 0;
        for( let i = 0; i < out.length; ++i ) area += out[i][0] * out[ ( i + 1 ) % out.length ][1] - out[ ( i + 1 ) % out.length ][0] * out[i][1];
        expect( area ).toBeGreaterThan( 0 );
        expect( Math.max( ...out.map( p => mag( p ) ) ) ).toBeCloseTo( 1, 10 );
    } );

    it( 'smooths closed strokes without shrinking them much', () => {
        const loop: Vec2[] = Array.from( { length: 60 }, ( _, i ) => [ Math.cos( 2 * Math.PI * i / 60 ), Math.sin( 2 * Math.PI * i / 60 ) ] );
        const out = smoothClosedStroke( loop, 1, 21 );
        expect( out.length ).toBe( 21 );
        for( const p of out ) expect( mag( p ) ).toBeGreaterThan( 0.95 );
        expect( contourContains( out, [ 0, 0 ] ) ).toBe( true );
    } );

    it( 'intersects triangles', () => {
        const t1: Vec3[] = [ [ -1, -1, 0 ], [ 1, -1, 0 ], [ 0, 1, 0 ] ];
        const t2: Vec3[] = [ [ 0, -0.5, -1 ], [ 0, -0.5, 1 ], [ 0, 0.5, 0 ] ];
        const seg = triTriSegment( t1, t2 )!;
        expect( seg ).not.toBeNull();
        for( const p of seg ) { expect( p[0] ).toBeCloseTo( 0 ); expect( p[2] ).toBeCloseTo( 0 ); }
    } );
} );
