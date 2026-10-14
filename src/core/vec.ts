// Small vector helpers.  Vectors are plain arrays so that 2d and 3d code can share functions,
// following the NumPy style of the original implementation (myarray.py, vecutil.py).

export type Vec2 = [ number, number ];
export type Vec3 = [ number, number, number ];
export type Vec = number[];

export const kEps = 1e-5;

export function add<T extends Vec>( a: T, b: Vec ): T {
    return a.map( ( x, i ) => x + b[i] ) as T;
}
export function sub<T extends Vec>( a: T, b: Vec ): T {
    return a.map( ( x, i ) => x - b[i] ) as T;
}
export function scale<T extends Vec>( a: T, s: number ): T {
    return a.map( x => x * s ) as T;
}
// a + s*b
export function addScaled<T extends Vec>( a: T, s: number, b: Vec ): T {
    return a.map( ( x, i ) => x + s * b[i] ) as T;
}
export function lerp<T extends Vec>( a: T, b: Vec, t: number ): T {
    return a.map( ( x, i ) => x + t * ( b[i] - x ) ) as T;
}
export function dot( a: Vec, b: Vec ): number {
    let result = 0;
    for( let i = 0; i < a.length; ++i ) result += a[i] * b[i];
    return result;
}
export function mag2( a: Vec ): number { return dot( a, a ); }
export function mag( a: Vec ): number { return Math.sqrt( dot( a, a ) ); }
// Named after myarray.dir(): the unit vector in the direction of 'a'.
export function dir<T extends Vec>( a: T ): T { return scale( a, 1 / mag( a ) ); }
export function cross( a: Vec, b: Vec ): Vec3 {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}
export function to3( a: Vec, z = 0 ): Vec3 { return [ a[0], a[1], a.length > 2 ? a[2] : z ]; }
export function to2( a: Vec ): Vec2 { return [ a[0], a[1] ]; }
export function dist2( a: Vec, b: Vec ): number {
    let result = 0;
    for( let i = 0; i < a.length; ++i ) result += ( a[i] - b[i] ) ** 2;
    return result;
}
export function dist( a: Vec, b: Vec ): number { return Math.sqrt( dist2( a, b ) ); }
export function clamp( x: number, lo: number, hi: number ): number { return Math.max( lo, Math.min( hi, x ) ); }

// vecutil.rotate(): 'vec' rotated about 'axis' by 'radians'.
export function rotate( vec: Vec3, axis: Vec3, radians: number ): Vec3 {
    const u = dir( axis );
    const par = scale( u, dot( vec, u ) );
    const perp = sub( vec, par );
    return add( add( par, scale( perp, Math.cos( radians ) ) ), scale( cross( u, perp ), Math.sin( radians ) ) );
}

// vecutil.orthogonal(): an arbitrary (deterministic) unit vector orthogonal to 'vec'.
export function orthogonal( vec: Vec3 ): Vec3 {
    let mini = 0;
    if( Math.abs( vec[1] ) < Math.abs( vec[mini] ) ) mini = 1;
    if( Math.abs( vec[2] ) < Math.abs( vec[mini] ) ) mini = 2;
    const orth: Vec3 = [ vec[0], vec[1], vec[2] ];
    orth[mini] += 1;
    return dir( cross( vec, orth ) );
}

// vecutil.get_axis_angle_rotation(): the ( axis, radians ) rotating 'start' to point along 'end'.
export function axisAngleRotation( start: Vec3, end: Vec3 ): [ Vec3, number ] {
    const startn = dir( start );
    const endn = dir( end );
    let axis = cross( startn, endn );
    const cosAngle = dot( startn, endn );
    if( mag2( axis ) < 1e-7 ) axis = orthogonal( startn );
    axis = dir( axis );
    return [ axis, Math.acos( clamp( cosAngle, -1, 1 ) ) ];
}

// vecutil.get_rotation_matrix(): a row-major 3x3 rotation matrix.
export function rotationMatrix( axis: Vec3, radians: number ): number[][] {
    const [ u1, u2, u3 ] = dir( axis );
    const U = [ [ u1 * u1, u1 * u2, u1 * u3 ], [ u2 * u1, u2 * u2, u2 * u3 ], [ u3 * u1, u3 * u2, u3 * u3 ] ];
    const S = [ [ 0, -u3, u2 ], [ u3, 0, -u1 ], [ -u2, u1, 0 ] ];
    const c = Math.cos( radians ), s = Math.sin( radians );
    return U.map( ( row, i ) => row.map( ( x, j ) => x + ( ( i === j ? 1 : 0 ) - x ) * c + S[i][j] * s ) );
}

export function matVec( M: number[][], v: Vec ): Vec3 {
    return [ dot( M[0], v ), dot( M[1], v ), dot( M[2], v ) ];
}

export type Plane = [ Vec3, Vec3 ];

// vecutil.project_point_to_plane()
export function projectPointToPlane( point: Vec3, plane: Plane ): Vec3 {
    const n = dir( plane[1] );
    const toPoint = sub( point, plane[0] );
    return add( plane[0], sub( toPoint, scale( n, dot( toPoint, n ) ) ) );
}

// vecutil.reflect_point_across_plane()
export function reflectPointAcrossPlane( point: Vec3, plane: Plane ): Vec3 {
    const onPlane = projectPointToPlane( point, plane );
    return addScaled( point, 2, sub( onPlane, point ) );
}

// helpers.line_strip_seg_lengths()
export function segLengths( pts: Vec[] ): number[] {
    const result: number[] = [];
    for( let i = 0; i + 1 < pts.length; ++i ) result.push( dist( pts[i], pts[i + 1] ) );
    return result;
}

// helpers.line_strip_length()
export function lineStripLength( pts: Vec[] ): number {
    return segLengths( pts ).reduce( ( a, b ) => a + b, 0 );
}

// helpers.normalize_vectors(): vectors with magnitude below 'eps' are returned unchanged.
export function normalizeVector<T extends Vec>( v: T, eps = 1e-8 ): T {
    const m = mag( v );
    return m < eps ? ( v.slice() as T ) : scale( v, 1 / m );
}

// helpers.tangents_and_normals_along_line_strip_2d(): unit tangents and right-turn normals per edge.
// For 3d input, tangents are 3d and normals are the 90-degree clockwise rotation about z (keeping z).
export function tangentsAndNormals<T extends Vec>( lineStrip: T[] ): [ T[], T[] ] {
    const tangents: T[] = [];
    const normals: T[] = [];
    for( let i = 0; i + 1 < lineStrip.length; ++i ) {
        const t = normalizeVector( sub( lineStrip[i + 1], lineStrip[i] ) );
        tangents.push( t );
        const n = t.slice() as T;
        n[0] = t[1];
        n[1] = -t[0];
        normals.push( n );
    }
    return [ tangents, normals ];
}

export function average<T extends Vec>( pts: T[], weights?: number[] ): T {
    const result = pts[0].map( () => 0 ) as T;
    let total = 0;
    pts.forEach( ( p, i ) => {
        const w = weights ? weights[i] : 1;
        total += w;
        for( let c = 0; c < result.length; ++c ) result[c] += w * p[c];
    } );
    return scale( result, 1 / total );
}
