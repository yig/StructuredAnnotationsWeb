// Spine parameterization, depth solve, and smooth interpolation along spines.
// Ports annotations_sweep.py (t <-> index helpers), sweep_spine.py, and the energy in Eline_ad.cpp.

import { Matrix, LU } from './linalg';
import { Vec, Vec3, dist, mag, clamp } from './vec';

// Python 3's round(), which rounds halves to the nearest even integer.
export function roundHalfEven( x: number ): number {
    const r = Math.round( x );
    if( Math.abs( x % 1 ) === 0.5 && r % 2 !== 0 ) return r - 1;
    return r;
}

// The index of the edge in a line strip with 'n' points that 't' lies in.
export function t2edgeIndex( t: number, n: number ): number {
    t = clamp( t, 0, 1 );
    return Math.min( Math.floor( t * ( n - 1 ) ), n - 2 );
}

// The index of the vertex in a line strip with 'n' points closest to 't'.
export function t2vertexIndex( t: number, n: number ): number {
    t = clamp( t, 0, 1 );
    return roundHalfEven( t * ( n - 1 ) );
}

// Maps the first edge to 0 and the last edge to 1.
export function edgeIndex2t( edgeIndex: number, n: number ): number {
    return edgeIndex / ( n - 2 );
}

// Maps the first vertex to 0 and the last vertex to 1.
export function vertexIndex2t( vertexIndex: number, n: number ): number {
    return vertexIndex / ( n - 1 );
}

// The arc length parameter (normalized to [0,1]) of vertex 'vertexIndex'.
export function vertexIndex2s( vertexIndex: number, lineStrip: Vec[] ): number {
    if( vertexIndex === 0 ) return 0;
    let total = 0;
    const cumulative: number[] = [];
    for( let i = 0; i + 1 < lineStrip.length; ++i ) {
        total += dist( lineStrip[i], lineStrip[i + 1] );
        cumulative.push( total );
    }
    return cumulative[ vertexIndex - 1 ] / total;
}

export const kMaxAbsTiltRadians = 0.5 * Math.PI * 0.9;

// The 3d spine tangent implied by tilting a cross section by 'tiltRadians' at an edge with 2d tangent 'tangent2d'.
export function tiltRadiansToTangent3d( tiltRadians: number, tangent2d: Vec ): Vec3 {
    tiltRadians = clamp( tiltRadians, -kMaxAbsTiltRadians, kMaxAbsTiltRadians );
    return [ tangent2d[0], tangent2d[1], Math.tan( -tiltRadians ) * mag( [ tangent2d[0], tangent2d[1] ] ) ];
}

// The Hessian (for one scalar coordinate) of the Laplacian editing energy in Eline_ad.cpp,
// Elaplacian_editing_and_derivatives_undeformed(), summed over interior vertices.
// For vertex i with undeformed edge lengths a = |u_{i+1} - u_i| and b = |u_{i-1} - u_i|,
// the energy is | (a+b) p_i - a p_{i-1} - b p_{i+1} |^2 / (a+b).
// (sweep_spine.kEndpoints is False, so endpoints contribute nothing.)
export function laplacianHessian( undeformed: Vec[] ): Matrix {
    const n = undeformed.length;
    const H = new Matrix( n, n );
    for( let i = 1; i < n - 1; ++i ) {
        const a = dist( undeformed[i + 1], undeformed[i] );
        const b = dist( undeformed[i - 1], undeformed[i] );
        const area = a + b;
        const idx = [ i - 1, i, i + 1 ];
        const w = [ -a, area, -b ];
        for( let r = 0; r < 3; ++r ) for( let c = 0; c < 3; ++c ) {
            H.addTo( idx[r], idx[c], 2 * w[r] * w[c] / area );
        }
    }
    return H;
}

// SweepShape.gen_spine3d(): solves for z values along a 2d spine so that the spine's edges
// match the out-of-image-plane tilts (soft constraints), while minimizing the Laplacian.
// 'tilts' is a list of [ t, tilt radians ] pairs.  The first vertex is fixed at z = 0.
export function solveSpine3d( spine2d: Vec[], tilts: [ number, number ][] ): Vec3[] {
    const n = spine2d.length;
    // The undeformed spine is the spine with all z = 0 (there is never a previous solution;
    // see the comments in the port notes), so the Laplacian uses 2d edge lengths.
    const z = new Float64Array( n );
    const H = laplacianHessian( spine2d );

    // Soft constraints z[e+1] - z[e] = zdiff with weight 1e7, as in Elinear_lsq_constraints().
    // That function returns E = |Cx-r|^2 but its gradient and Hessian without the factor of 2,
    // so the effective energy is .5 * 1e7 * |Cx - r|^2.
    const kWeight = 1e7;
    const A = H.clone();
    const grad = new Float64Array( n );
    for( let i = 0; i < n; ++i ) {
        let s = 0;
        for( let j = 0; j < n; ++j ) s += H.get( i, j ) * z[j];
        grad[i] = s;
    }
    for( const [ t, tiltRadians ] of tilts ) {
        const e = t2edgeIndex( t, n );
        const tangent2d = [ spine2d[e + 1][0] - spine2d[e][0], spine2d[e + 1][1] - spine2d[e][1] ];
        const zdiff = tiltRadiansToTangent3d( tiltRadians, tangent2d )[2];
        const diff = z[e + 1] - z[e] - zdiff;
        grad[e + 1] += kWeight * diff;
        grad[e] -= kWeight * diff;
        A.addTo( e + 1, e + 1, kWeight );
        A.addTo( e, e, kWeight );
        A.addTo( e + 1, e, -kWeight );
        A.addTo( e, e + 1, -kWeight );
    }
    // Fix the first point's z.
    A.setIdentityRow( 0 );
    grad[0] = 0;

    // The system is linear, so a single Newton step solves it.
    const step = new LU( A ).solve( grad );
    return spine2d.map( ( p, i ) => [ p[0], p[1], z[i] - step[i] ] as Vec3 );
}

// sweep_spine.diffuse_values_along_sweep_spine_factored(): given a spine, returns a function
// that smoothly interpolates sparse values (any dimension) along the spine, by minimizing the
// Laplacian editing energy with the values fixed at their vertices.
export type Diffuser = ( constraints: [ number, number[] ][] ) => number[][];

export function makeDiffuser( spine: Vec[] ): Diffuser {
    const H = laplacianHessian( spine );
    const n = spine.length;

    return ( constraints ) => {
        if( constraints.length === 0 ) throw new Error( 'Diffuser: no constraints' );
        const K = constraints[0][1].length;

        // With only one constraint, all values are identical.
        if( constraints.length === 1 ) {
            return Array.from( { length: n }, () => constraints[0][1].slice() );
        }

        const A = H.clone();
        const b: Float64Array[] = Array.from( { length: K }, () => new Float64Array( n ) );
        for( const [ index, val ] of constraints ) {
            A.setIdentityRow( index );
            for( let k = 0; k < K; ++k ) b[k][index] = val[k];
        }

        const lu = new LU( A );
        const columns = b.map( bk => lu.solve( bk ) );
        return Array.from( { length: n }, ( _, i ) => columns.map( col => col[i] ) );
    };
}
