// Intersection curves between triangle meshes, used to display connection curves
// (ports the use of surface_intersections.mesh_mesh_intersection_lines_info() and tritri.c).

import { TriMesh } from './mesh';
import { Vec3, sub, cross, dot, add, scale } from './vec';

export interface IntersectionSegment {
    a: Vec3;
    b: Vec3;
    // The intersecting faces of the first and second mesh.
    faces: [ number, number ];
}

type Box = [ number, number, number, number, number, number ];

function triBox( vs: Vec3[], f: number[] ): Box {
    const a = vs[f[0]], b = vs[f[1]], c = vs[f[2]];
    return [
        Math.min( a[0], b[0], c[0] ), Math.min( a[1], b[1], c[1] ), Math.min( a[2], b[2], c[2] ),
        Math.max( a[0], b[0], c[0] ), Math.max( a[1], b[1], c[1] ), Math.max( a[2], b[2], c[2] ),
    ];
}

function boxesOverlap( p: Box, q: Box ): boolean {
    return p[0] <= q[3] && q[0] <= p[3] && p[1] <= q[4] && q[1] <= p[4] && p[2] <= q[5] && q[2] <= p[5];
}

// The segment where triangle (a,b,c) crosses the plane ( n . x = d ), as two points, or null.
function triPlaneSegment( tri: Vec3[], n: Vec3, d: number ): [ Vec3, Vec3 ] | null {
    const s = tri.map( p => dot( n, p ) - d );
    const pts: Vec3[] = [];
    for( let i = 0; i < 3; ++i ) {
        const j = ( i + 1 ) % 3;
        if( s[i] === 0 ) pts.push( tri[i] );
        if( ( s[i] < 0 && s[j] > 0 ) || ( s[i] > 0 && s[j] < 0 ) ) {
            const t = s[i] / ( s[i] - s[j] );
            pts.push( add( tri[i], scale( sub( tri[j], tri[i] ), t ) ) );
        }
    }
    if( pts.length < 2 ) return null;
    return [ pts[0], pts[ pts.length - 1 ] ];
}

// The intersection segment of two triangles, or null.
export function triTriSegment( t1: Vec3[], t2: Vec3[] ): [ Vec3, Vec3 ] | null {
    const n1 = cross( sub( t1[1], t1[0] ), sub( t1[2], t1[0] ) );
    const n2 = cross( sub( t2[1], t2[0] ), sub( t2[2], t2[0] ) );
    const s1 = triPlaneSegment( t1, n2, dot( n2, t2[0] ) );
    if( !s1 ) return null;
    const s2 = triPlaneSegment( t2, n1, dot( n1, t1[0] ) );
    if( !s2 ) return null;
    // Both segments lie on the planes' intersection line; intersect their extents along it.
    const dirLine = cross( n1, n2 );
    if( dot( dirLine, dirLine ) === 0 ) return null;
    const proj = ( p: Vec3 ) => dot( dirLine, p );
    let [ a0, a1 ] = [ proj( s1[0] ), proj( s1[1] ) ];
    let [ p0, p1 ] = s1;
    if( a0 > a1 ) { [ a0, a1 ] = [ a1, a0 ]; [ p0, p1 ] = [ p1, p0 ]; }
    let [ b0, b1 ] = [ proj( s2[0] ), proj( s2[1] ) ];
    let [ q0, q1 ] = s2;
    if( b0 > b1 ) { [ b0, b1 ] = [ b1, b0 ]; [ q0, q1 ] = [ q1, q0 ]; }
    const lo = Math.max( a0, b0 ), hi = Math.min( a1, b1 );
    if( lo >= hi ) return null;
    const start = a0 >= b0 ? p0 : q0;
    const end = a1 <= b1 ? p1 : q1;
    return [ start, end ];
}

export function meshMeshIntersections( m1: TriMesh, m2: TriMesh ): IntersectionSegment[] {
    const boxes2 = m2.faces.map( f => triBox( m2.vs, f ) );
    // Bin the second mesh's faces in a uniform xy grid.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for( const b of boxes2 ) { minX = Math.min( minX, b[0] ); minY = Math.min( minY, b[1] ); maxX = Math.max( maxX, b[3] ); maxY = Math.max( maxY, b[4] ); }
    const G = 32;
    const cellW = ( maxX - minX ) / G || 1, cellH = ( maxY - minY ) / G || 1;
    const cell = ( x: number, lo: number, w: number ) => Math.max( 0, Math.min( G - 1, Math.floor( ( x - lo ) / w ) ) );
    const grid: number[][] = Array.from( { length: G * G }, () => [] );
    boxes2.forEach( ( b, fi ) => {
        for( let i = cell( b[0], minX, cellW ); i <= cell( b[3], minX, cellW ); ++i )
            for( let j = cell( b[1], minY, cellH ); j <= cell( b[4], minY, cellH ); ++j ) grid[ i * G + j ].push( fi );
    } );

    const result: IntersectionSegment[] = [];
    const seen = new Set<number>();
    m1.faces.forEach( ( f1, fi1 ) => {
        const b1 = triBox( m1.vs, f1 );
        if( b1[3] < minX || b1[0] > maxX || b1[4] < minY || b1[1] > maxY ) return;
        seen.clear();
        const t1 = f1.map( i => m1.vs[i] );
        for( let i = cell( b1[0], minX, cellW ); i <= cell( b1[3], minX, cellW ); ++i ) {
            for( let j = cell( b1[1], minY, cellH ); j <= cell( b1[4], minY, cellH ); ++j ) {
                for( const fi2 of grid[ i * G + j ] ) {
                    if( seen.has( fi2 ) ) continue;
                    seen.add( fi2 );
                    if( !boxesOverlap( b1, boxes2[fi2] ) ) continue;
                    const seg = triTriSegment( t1, m2.faces[fi2].map( k => m2.vs[k] ) );
                    if( seg ) result.push( { a: seg[0], b: seg[1], faces: [ fi1, fi2 ] } );
                }
            }
        }
    } );
    return result;
}

export function faceNormalZ( mesh: TriMesh, fi: number ): number {
    const [ a, b, c ] = mesh.faces[fi].map( i => mesh.vs[i] );
    return cross( sub( b, a ), sub( c, a ) )[2];
}

// The parts of the intersection curve between two connected shapes' meshes that lie on the
// attached (front or back facing) surfaces.
export function connectionIntersection( m1: TriMesh, m2: TriMesh, attachFront: [ boolean, boolean ] ): IntersectionSegment[] {
    return meshMeshIntersections( m1, m2 ).filter( s =>
        ( faceNormalZ( m1, s.faces[0] ) > 0 ) === attachFront[0] &&
        ( faceNormalZ( m2, s.faces[1] ) > 0 ) === attachFront[1] );
}
