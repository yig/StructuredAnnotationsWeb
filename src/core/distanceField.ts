// Tracing points along the gradient of a smoothed distance field to a polyline, used to offset
// generalized cylinder cross sections without pinching (paper Section 5.1, after [Peng et al. 2004]).
// Ports edge_distances.cpp.

import { Vec3 } from './vec';

// The exponent of the smoothed minimum (a soft L-infinity norm of inverse distances).
const kLInfinity = 3;

// The gradient of the smoothed distance to the polyline 'lineStrip', at 'point'.
function smoothGradient( point: Vec3, lineStrip: Vec3[] ): Vec3 {
    const n = lineStrip.length;
    const distances = new Float64Array( n - 1 );
    const gradients: Vec3[] = new Array( n - 1 );

    let pbx = point[0] - lineStrip[0][0], pby = point[1] - lineStrip[0][1], pbz = point[2] - lineStrip[0][2];
    for( let i = 0; i < n - 1; ++i ) {
        const pax = pbx, pay = pby, paz = pbz;
        pbx = point[0] - lineStrip[i + 1][0];
        pby = point[1] - lineStrip[i + 1][1];
        pbz = point[2] - lineStrip[i + 1][2];

        const bax = lineStrip[i + 1][0] - lineStrip[i][0];
        const bay = lineStrip[i + 1][1] - lineStrip[i][1];
        const baz = lineStrip[i + 1][2] - lineStrip[i][2];
        const lenSq = bax * bax + bay * bay + baz * baz;
        const dx = bax / lenSq, dy = bay / lenSq, dz = baz / lenSq;
        const cond = pax * dx + pay * dy + paz * dz;

        let gx: number, gy: number, gz: number;
        if( cond < 0 ) {
            gx = pax; gy = pay; gz = paz;
        } else if( cond > 1 ) {
            gx = pbx; gy = pby; gz = pbz;
        } else {
            const Lx = pax - cond * bax, Ly = pay - cond * bay, Lz = paz - cond * baz;
            const LdotD = Lx * dx + Ly * dy + Lz * dz;
            distances[i] = Math.sqrt( Lx * Lx + Ly * Ly + Lz * Lz );
            gx = Lx - LdotD * bax; gy = Ly - LdotD * bay; gz = Lz - LdotD * baz;
            const inv = 1 / distances[i];
            gradients[i] = [ gx * inv, gy * inv, gz * inv ];
            continue;
        }
        distances[i] = Math.sqrt( gx * gx + gy * gy + gz * gz );
        const inv = 1 / distances[i];
        gradients[i] = [ gx * inv, gy * inv, gz * inv ];
    }

    let sumDistances = 0;
    for( let i = 0; i < n - 1; ++i ) sumDistances += Math.pow( distances[i], -kLInfinity );

    const coeff = ( -1 / kLInfinity ) * Math.pow( sumDistances, -1 / kLInfinity - 1 );
    const result: Vec3 = [ 0, 0, 0 ];
    for( let i = 0; i < n - 1; ++i ) {
        const w = coeff * ( -kLInfinity * Math.pow( distances[i], -kLInfinity - 1 ) );
        result[0] += w * gradients[i][0];
        result[1] += w * gradients[i][1];
        result[2] += w * gradients[i][2];
    }
    return result;
}

// Moves 'point' a total of 'distance' along the normalized gradient of the smoothed distance
// field to 'lineStrip', in steps of size 'dt'.
export function tracePoint( point: Vec3, lineStrip: Vec3[], distance: number, dt: number ): Vec3 {
    const trace: Vec3 = [ point[0], point[1], point[2] ];
    while( distance > 0 ) {
        const g = smoothGradient( trace, lineStrip );
        const norm = 1 / Math.sqrt( g[0] * g[0] + g[1] * g[1] + g[2] * g[2] );
        const step = Math.max( Math.min( distance, dt ), 0 ) * norm;
        trace[0] += step * g[0];
        trace[1] += step * g[1];
        trace[2] += step * g[2];
        distance -= dt;
    }
    return trace;
}
