// Meshing generalized cylinders: sweeping (circular or arbitrary) cross sections along a 3d spine,
// with tangent-continuous end-caps.  Ports sweep_surface.py.

import { TriMesh, Face } from './mesh';
import { tracePoint } from './distanceField';
import { Diffuser } from './spine';
import {
    Vec2, Vec3, add, sub, scale, addScaled, dot, mag, dir, cross, lerp,
    orthogonal, rotate, axisAngleRotation, kEps,
} from './vec';

export const kNumCircleSamples = 20;
export const kNumSphereCapSlices = 5;
export const kNoPinchTraceDt = 3e-2;
const kTraceEps = 1e-3;

// numpy.linspace()
export function linspace( start: number, stop: number, num: number ): number[] {
    if( num === 1 ) return [ start ];
    const step = ( stop - start ) / ( num - 1 );
    const result: number[] = [];
    for( let i = 0; i < num; ++i ) result.push( i * step + start );
    result[ num - 1 ] = stop;
    return result;
}

export type Frame = [ Vec3, Vec3, Vec3 ];

// path_frames(): a minimally rotating frame (x, y, tangent) at every vertex of an open 3d path.
export function pathFrames( path: Vec3[] ): Frame[] {
    const tangents: Vec3[] = [];
    for( let i = 0; i + 1 < path.length; ++i ) tangents.push( dir( sub( path[i + 1], path[i] ) ) );
    tangents.push( tangents[ tangents.length - 1 ] );

    const ortho0 = orthogonal( tangents[0] );
    const frames: Frame[] = [ [ ortho0, cross( tangents[0], ortho0 ), tangents[0] ] ];
    for( let i = 1; i < path.length; ++i ) {
        const [ axis, radians ] = axisAngleRotation( tangents[i - 1], tangents[i] );
        const prev = frames[ frames.length - 1 ];
        frames.push( [ rotate( prev[0], axis, radians ), rotate( prev[1], axis, radians ), tangents[i] ] );
    }
    return frames;
}

// circle_from_point_and_gradient(): the circle centered on the x axis through (x,y) with slope y_prime.
function circleFromPointAndGradient( x: number, y: number, yPrime: number ): [ number, number ] {
    return [ x + y * yPrime, y * Math.sqrt( 1 + yPrime * yPrime ) ];
}

export type CapStyle = [ 'spherical' ] | [ 'hemisphere' ] | [ 'spherical-clipped' ] | [ 'flat' ] | [ 'fixed', number ];

// generate_cap(): ( x, radius ) samples continuing a sweep beyond its end, ending at radius 0.
export function generateCap( radius0: number, radius0Prime: number, cap: CapStyle, capSegments: number ): [ number, number ][] {
    const style = cap[0];
    if( style === 'flat' ) return [ [ 0, 0 ] ];

    const result: [ number, number ][] = [];
    if( style === 'hemisphere' || style === 'spherical' || style === 'spherical-clipped' ) {
        let [ c, r ] = circleFromPointAndGradient( 0, radius0, radius0Prime );
        if( style === 'hemisphere' || ( style === 'spherical-clipped' && c > 0 ) ) {
            c = 0;
            r = radius0;
        }
        // sqrt() the linear spacing so the rings don't bunch up.
        for( const s of linspace( 0, 1, capSegments + 2 ).slice( 1, -1 ) ) {
            const t = Math.sqrt( s );
            const x = ( r + c ) * t;
            result.push( [ x, Math.sqrt( r * r - ( x - c ) ** 2 ) ] );
        }
        result.push( [ r + c, 0 ] );
    } else {
        // The paper's cubic Bezier end-cap, which falls to radius 0 at the cap protrusion.
        let capRadius = cap[1];
        if( capRadius <= kEps ) return [ [ capRadius, 0 ] ];

        const y0: Vec2 = [ 0, radius0 ];
        let y0Prime: Vec2 = [ 1, radius0Prime ];
        const y1: Vec2 = [ capRadius, 0 ];
        let y1Prime: Vec2 = [ 0, -1 ];

        // Intersect the line through y0 with tangent y0Prime with the x = capRadius line.
        y0Prime = scale( y0Prime, capRadius );
        y1Prime[1] = -( y0[1] + y0Prime[1] );
        y0Prime = scale( y0Prime, 0.5 );
        y1Prime = scale( y1Prime, 0.5 );
        // Clamp so that y0 + y0Prime doesn't cross the x axis.
        if( y1Prime[1] > 0 ) {
            y1Prime[1] = 0;
            y0Prime = scale( y0Prime, -y0[1] / y0Prime[1] );
            capRadius = y0Prime[0];
            y1[0] = capRadius;
        }

        const P = [ y0, add( y0, y0Prime ), sub( y1, y1Prime ), y1 ];
        for( const t of linspace( 0, 1, capSegments + 2 ).slice( 1, -1 ) ) {
            const b = [ ( 1 - t ) ** 3, 3 * ( 1 - t ) ** 2 * t, 3 * ( 1 - t ) * t ** 2, t ** 3 ];
            const x = b[0] * P[0][0] + b[1] * P[1][0] + b[2] * P[2][0] + b[3] * P[3][0];
            const y = b[0] * P[0][1] + b[1] * P[1][1] + b[2] * P[2][1] + b[3] * P[3][1];
            result.push( [ x, y ] );
        }
        result.push( [ capRadius, 0 ] );
    }
    return result;
}

export type Caps = [ CapStyle, CapStyle ];

// path_and_radii_with_caps(): extends a path and its radii with end-cap samples.
export function pathAndRadiiWithCaps( sweepPath: Vec3[], sweepRadii: number[], caps: Caps, capSegments: number )
    : { path: Vec3[], radii: number[], startCapPt: Vec3, endCapPt: Vec3 } {
    let path = sweepPath.map( p => [ p[0], p[1], p[2] ] as Vec3 );
    let radii = sweepRadii.slice();

    let startCapPt: Vec3;
    if( radii[0] < kEps ) {
        startCapPt = path[0];
        path = path.slice( 1 );
        radii = radii.slice( 1 );
    } else {
        const y = radii[0];
        const yPrime = ( radii[0] - radii[1] ) / mag( sub( path[0], path[1] ) );
        const xrs = generateCap( y, yPrime, caps[0], capSegments );
        const axis = dir( sub( path[0], path[1] ) );
        const origin = path[0];
        for( const [ x, r ] of xrs.slice( 0, -1 ) ) {
            path.unshift( addScaled( origin, x, axis ) );
            radii.unshift( r );
        }
        startCapPt = addScaled( origin, xrs[ xrs.length - 1 ][0], axis );
    }

    let endCapPt: Vec3;
    const last = () => path.length - 1;
    if( radii[ last() ] < kEps ) {
        endCapPt = path[ last() ];
        path = path.slice( 0, -1 );
        radii = radii.slice( 0, -1 );
    } else {
        const y = radii[ last() ];
        const yPrime = ( radii[ last() ] - radii[ last() - 1 ] ) / mag( sub( path[ last() ], path[ last() - 1 ] ) );
        const xrs = generateCap( y, yPrime, caps[1], capSegments );
        const axis = dir( sub( path[ last() ], path[ last() - 1 ] ) );
        const origin = path[ last() ];
        for( const [ x, r ] of xrs.slice( 0, -1 ) ) {
            path.push( addScaled( origin, x, axis ) );
            radii.push( r );
        }
        endCapPt = addScaled( origin, xrs[ xrs.length - 1 ][0], axis );
    }

    return { path, radii, startCapPt, endCapPt };
}

// A cross section is a frame x-vector and a 2d line loop in the ( x-vector, tangent x x-vector ) plane.
export type CrossSection = [ Vec3, Vec2[] ];

// path_and_cross_sections_with_caps(): extends a path and its cross sections with end-cap samples,
// blending the end cross sections towards circles.
function pathAndCrossSectionsWithCaps( sweepPath: Vec3[], sections: CrossSection[], caps: Caps, capSegments: number )
    : { path: Vec3[], sections: CrossSection[], startCapPt: Vec3, endCapPt: Vec3 } {
    const path = sweepPath.map( p => [ p[0], p[1], p[2] ] as Vec3 );
    const xs = sections.slice();
    const avgMag = ( loop: Vec2[] ) => loop.reduce( ( s, p ) => s + mag( p ), 0 ) / loop.length;

    const r0 = avgMag( xs[0][1] );
    const r1 = avgMag( xs[1][1] );
    const startXrs = generateCap( r0, ( r0 - r1 ) / mag( sub( path[0], path[1] ) ), caps[0], capSegments );
    const startAxis = dir( sub( path[0], path[1] ) );
    const startOrigin = path[0];
    const xs0 = xs[0];
    for( const [ x, ri ] of startXrs.slice( 0, -1 ) ) {
        const t = x / startXrs[ startXrs.length - 1 ][0];
        path.unshift( addScaled( startOrigin, x, startAxis ) );
        xs.unshift( [ xs0[0], xs0[1].map( pt => lerp( scale( pt, ri / r0 ), scale( dir( pt ), ri ), t ) ) ] );
    }
    const startCapPt = addScaled( startOrigin, startXrs[ startXrs.length - 1 ][0], startAxis );

    const n = path.length;
    const rn1 = avgMag( xs[ n - 1 ][1] );
    const rn2 = avgMag( xs[ n - 2 ][1] );
    const endXrs = generateCap( rn1, ( rn1 - rn2 ) / mag( sub( path[ n - 1 ], path[ n - 2 ] ) ), caps[1], capSegments );
    const endAxis = dir( sub( path[ n - 1 ], path[ n - 2 ] ) );
    const endOrigin = path[ n - 1 ];
    const xsn1 = xs[ n - 1 ];
    for( const [ x, ri ] of endXrs.slice( 0, -1 ) ) {
        const t = x / endXrs[ endXrs.length - 1 ][0];
        path.push( addScaled( endOrigin, x, endAxis ) );
        xs.push( [ xsn1[0], xsn1[1].map( pt => lerp( scale( pt, ri / rn1 ), scale( dir( pt ), ri ), t ) ) ] );
    }
    const endCapPt = addScaled( endOrigin, endXrs[ endXrs.length - 1 ][0], endAxis );

    return { path, sections: xs, startCapPt, endCapPt };
}

// stitch_cross_sections() + face_stitch_pattern.c: connects consecutive loops with quads (two triangles each).
function stitchCrossSections( loops: Vec3[][] ): TriMesh {
    const mesh = new TriMesh();
    if( loops.length === 0 ) return mesh;
    const m = loops[0].length;
    for( let csi = 0; csi < loops.length - 1; ++csi ) {
        for( let vi = 0; vi < m; ++vi ) {
            const v00 = csi * m + vi;
            const v10 = csi * m + ( ( vi + 1 ) % m );
            const v01 = ( csi + 1 ) * m + vi;
            const v11 = ( csi + 1 ) * m + ( ( vi + 1 ) % m );
            mesh.faces.push( [ v00, v10, v11 ], [ v00, v11, v01 ] );
        }
    }
    for( const loop of loops ) for( const v of loop ) mesh.vs.push( v );
    return mesh;
}

// Closes the first and last loops of a stitched mesh with fans to the two cap points.
function addCapFans( mesh: TriMesh, startCount: number, endCount: number, startCapPt: Vec3, endCapPt: Vec3 ): void {
    const endRimOffset = mesh.vs.length - endCount;
    mesh.vs.push( startCapPt );
    const s = mesh.vs.length - 1;
    for( let i = 0; i < startCount; ++i ) mesh.faces.push( [ i, s, ( i + 1 ) % startCount ] as Face );
    mesh.vs.push( endCapPt );
    const e = mesh.vs.length - 1;
    for( let i = 0; i < endCount; ++i ) mesh.faces.push( [ e, endRimOffset + i, endRimOffset + ( ( i + 1 ) % endCount ) ] as Face );
}

// mesh_from_sweep_circles(): circular cross sections placed perpendicular to the spine.
export function meshFromSweepCircles( sweepPath: Vec3[], sweepRadii: number[], caps: Caps ): TriMesh {
    const { path, radii, startCapPt, endCapPt } = pathAndRadiiWithCaps( sweepPath, sweepRadii, caps, kNumSphereCapSlices );
    const frames = pathFrames( path );
    const thetas = linspace( 0, 2 * Math.PI, kNumCircleSamples + 1 ).slice( 0, -1 );
    const loops = frames.map( ( [ f0, f1 ], i ) => thetas.map( theta =>
        add( path[i], add( scale( f0, radii[i] * Math.cos( theta ) ), scale( f1, radii[i] * Math.sin( theta ) ) ) ) ) );
    const mesh = stitchCrossSections( loops );
    addCapFans( mesh, kNumCircleSamples, kNumCircleSamples, startCapPt, endCapPt );
    return mesh;
}

// mesh_from_sweep_circles_no_pinch(): like meshFromSweepCircles(), but each vertex is placed by
// tracing from the spine through the smoothed distance field, so that the surface doesn't pinch
// or self-intersect where the spine curves tightly.
export function meshFromSweepCirclesNoPinch( sweepPath: Vec3[], sweepRadii: number[], caps: Caps ): TriMesh {
    const { path, radii, startCapPt, endCapPt } = pathAndRadiiWithCaps( sweepPath, sweepRadii, caps, kNumSphereCapSlices );
    const frames = pathFrames( path );
    const thetas = linspace( 0, 2 * Math.PI, kNumCircleSamples + 1 ).slice( 0, -1 );

    // Start each vertex just off the spine; each traces outward by its cross section's radius.
    const loops = frames.map( ( [ f0, f1 ], i ) => thetas.map( theta =>
        add( path[i], scale( add( scale( f0, Math.cos( theta ) ), scale( f1, Math.sin( theta ) ) ), kTraceEps ) ) ) );
    const mesh = stitchCrossSections( loops );
    addCapFans( mesh, kNumCircleSamples, kNumCircleSamples, startCapPt, endCapPt );

    const n = path.length;
    const startCapVec = sub( startCapPt, path[0] );
    const endCapVec = sub( endCapPt, path[ n - 1 ] );
    const startCapMag = mag( startCapVec );
    const endCapMag = mag( endCapVec );
    const startCapDir = startCapMag > kEps ? scale( startCapVec, 1 / startCapMag ) : startCapVec;
    const endCapDir = endCapMag > kEps ? scale( endCapVec, 1 / endCapMag ) : endCapVec;
    mesh.vs[ mesh.vs.length - 2 ] = addScaled( path[0], kTraceEps, startCapDir );
    mesh.vs[ mesh.vs.length - 1 ] = addScaled( path[ n - 1 ], kTraceEps, endCapDir );

    const distances: number[] = [];
    for( const r of radii ) for( let k = 0; k < kNumCircleSamples; ++k ) distances.push( r );
    distances.push( startCapMag, endCapMag );

    for( let i = 0; i < mesh.vs.length; ++i ) {
        mesh.vs[i] = tracePoint( mesh.vs[i], path, distances[i], kNoPinchTraceDt );
    }
    return mesh;
}

// mesh_from_sweep_cross_sections(): arbitrary (dense) cross sections along the spine.
export function meshFromSweepCrossSections( sweepPath: Vec3[], sections: CrossSection[], caps: Caps, noPinch: boolean ): TriMesh {
    const ext = pathAndCrossSectionsWithCaps( sweepPath, sections, caps, kNumSphereCapSlices );
    const path = ext.path;
    const n = path.length;

    const tangents: Vec3[] = [];
    for( let i = 0; i + 1 < n; ++i ) tangents.push( dir( sub( path[i + 1], path[i] ) ) );
    tangents.push( tangents[ tangents.length - 1 ] );

    const loops: Vec3[][] = ext.sections.map( ( [ xvec, loop ], i ) => {
        const f0 = dir( xvec );
        const f1 = dir( cross( tangents[i], xvec ) );
        return loop.map( p => add( path[i], add( scale( f0, p[0] ), scale( f1, p[1] ) ) ) );
    } );

    if( noPinch ) {
        for( let i = 0; i < n; ++i ) {
            const spinePoint = path[i];
            loops[i] = loops[i].map( v => {
                const off = sub( v, spinePoint );
                const offMag = mag( off );
                return tracePoint( addScaled( spinePoint, kTraceEps / offMag, off ), path, offMag, kNoPinchTraceDt );
            } );
        }
    }

    const mesh = stitchCrossSections( loops );
    addCapFans( mesh, ext.sections[0][1].length, ext.sections[ n - 1 ][1].length, ext.startCapPt, ext.endCapPt );
    return mesh;
}

// smooth_orthogonal_vectors_from_constraints(): interpolates sparse vectors orthogonal to a path
// by diffusing their angles relative to the path's frames.
export function smoothOrthogonalVectors( frames: Frame[], sparse: [ number, Vec3 ][], diffuser: Diffuser ): Vec3[] {
    const angles = sparse.map( ( [ i, v ] ) => {
        const u = dir( v );
        return Math.atan2( dot( u, frames[i][1] ), dot( u, frames[i][0] ) );
    } );
    // Unwrap each angle so it is within pi of its predecessor.
    for( let i = 1; i < angles.length; ++i ) {
        const last = angles[i - 1];
        let cur = angles[i];
        cur += 2 * Math.PI * Math.floor( ( last - cur ) / ( 2 * Math.PI ) );
        while( Math.abs( last - cur ) > Math.PI ) cur += 2 * Math.PI;
        angles[i] = cur;
    }
    const dense = diffuser( sparse.map( ( [ i ], k ) => [ i, [ angles[k] ] ] ) );
    return dense.map( ( [ angle ], i ) => add( scale( frames[i][0], Math.cos( angle ) ), scale( frames[i][1], Math.sin( angle ) ) ) );
}
