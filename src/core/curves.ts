// 2d curve utilities used by the interactive tools: resampling, smoothing, picking,
// ellipse fitting, Laplacian curve editing, and over-sketching.
// Ports parts of helpers.py, vecutil.py, fitellipse.py, laplacian_curve_editing.py, and
// curve_oversketching.py.

import { Matrix, LU } from './linalg';
import { makeDiffuser, edgeIndex2t } from './spine';
import { Vec2, add, sub, scale, dot, mag, mag2, dist, lerp } from './vec';

// helpers.get_point_on_path() for many t's: points evenly spaced by arc length.
export function resampleLineStrip( curve: Vec2[], n: number ): Vec2[] {
    if( curve.length < 2 ) return curve.map( p => [ p[0], p[1] ] );
    n = Math.max( 2, n );
    const lengths = [ 0 ];
    for( let i = 1; i < curve.length; ++i ) lengths.push( lengths[i - 1] + dist( curve[i - 1], curve[i] ) );
    const total = lengths[ lengths.length - 1 ];
    const result: Vec2[] = [];
    let seg = 0;
    for( let i = 0; i < n; ++i ) {
        const target = total === 0 ? 0 : ( i / ( n - 1 ) ) * total;
        while( seg < curve.length - 2 && lengths[seg + 1] < target ) ++seg;
        const segLen = lengths[seg + 1] - lengths[seg];
        const u = segLen > 0 ? Math.min( 1, Math.max( 0, ( target - lengths[seg] ) / segLen ) ) : 0;
        result.push( lerp( curve[seg], curve[seg + 1], u ) );
    }
    return result;
}

export function resampleLineLoop( curve: Vec2[], n: number ): Vec2[] {
    if( curve.length < 3 ) return curve.map( p => [ p[0], p[1] ] );
    return resampleLineStrip( [ ...curve, curve[0] ], Math.max( 3, n ) + 1 ).slice( 0, -1 );
}

// helpers.smooth_open_stroke(): resample, then repeatedly move interior points to their neighbors' midpoint.
export function smoothOpenStroke( curve: Vec2[], smooth = 10, resampleN: number | null = 100 ): Vec2[] {
    let c = resampleN !== null ? resampleLineStrip( curve, resampleN ) : curve.map( p => [ p[0], p[1] ] as Vec2 );
    for( let iter = 0; iter < smooth; ++iter ) {
        const next = c.slice();
        for( let i = 1; i < c.length - 1; ++i ) next[i] = scale( add( c[i - 1], c[i + 1] ), 0.5 );
        c = next;
    }
    return c;
}

// helpers.ft_smooth_periodic_function(): keeps the lowest frequencies containing (100 - percent)% of
// the total spectral magnitude.
function ftSmoothPeriodic( x: number[], percentDeviation: number ): number[] {
    const n = x.length;
    percentDeviation = Math.max( 0, Math.min( 100, percentDeviation ) );
    const m = Math.floor( n / 2 ) + 1;
    const re = new Float64Array( m ), im = new Float64Array( m );
    for( let k = 0; k < m; ++k ) {
        for( let j = 0; j < n; ++j ) {
            const a = -2 * Math.PI * k * j / n;
            re[k] += x[j] * Math.cos( a );
            im[k] += x[j] * Math.sin( a );
        }
    }
    const cumulative: number[] = [];
    let sum = 0;
    for( let k = 0; k < m; ++k ) { sum += Math.hypot( re[k], im[k] ); cumulative.push( sum ); }
    const target = ( ( 100 - percentDeviation ) / 100 ) * sum;
    let i = cumulative.findIndex( c => c >= target );
    if( i < 0 ) i = m - 1;
    const f = cumulative[i] > 0 ? ( target - ( i > 0 ? cumulative[i - 1] : 0 ) ) / cumulative[i] : 0;
    re[i] *= f; im[i] *= f;
    for( let k = i + 1; k < m; ++k ) { re[k] = 0; im[k] = 0; }
    // Inverse real DFT.
    const result: number[] = [];
    for( let j = 0; j < n; ++j ) {
        let s = re[0];
        for( let k = 1; k < m; ++k ) {
            const w = ( n % 2 === 0 && k === m - 1 ) ? 1 : 2;
            const a = 2 * Math.PI * k * j / n;
            s += w * ( re[k] * Math.cos( a ) - im[k] * Math.sin( a ) );
        }
        result.push( s / n );
    }
    return result;
}

// helpers.smooth_closed_stroke()
export function smoothClosedStroke( curve: Vec2[], smooth = 1, resampleN = 100 ): Vec2[] {
    let c = resampleLineLoop( curve, resampleN );
    c = removeContourSelfIntersections( c );
    c = resampleLineLoop( c, resampleN );
    const xs = ftSmoothPeriodic( c.map( p => p[0] ), Math.min( smooth, 90 ) );
    const ys = ftSmoothPeriodic( c.map( p => p[1] ), Math.min( smooth, 90 ) );
    return xs.map( ( x, i ) => [ x, ys[i] ] );
}

function segmentsIntersection( a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2 ): Vec2 | null {
    const d1 = sub( a1, a0 ), d2 = sub( b1, b0 );
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if( den === 0 ) return null;
    const w = sub( b0, a0 );
    const s = ( w[0] * d2[1] - w[1] * d2[0] ) / den;
    const t = ( w[0] * d1[1] - w[1] * d1[0] ) / den;
    if( s <= 0 || s >= 1 || t <= 0 || t >= 1 ) return null;
    return add( a0, scale( d1, s ) );
}

// helpers.remove_contour_self_intersections(): cuts self-intersections, keeping the longer loop.
export function removeContourSelfIntersections( contour: Vec2[] ): Vec2[] {
    let c = contour.slice();
    for( let guard = 0; guard < 1000; ++guard ) {
        let cut = false;
        const n = c.length;
        outer: for( let e0 = 0; e0 < n; ++e0 ) {
            for( let f0 = e0 + 2; f0 < n; ++f0 ) {
                if( e0 === 0 && f0 === n - 1 ) continue;
                const p = segmentsIntersection( c[e0], c[ ( e0 + 1 ) % n ], c[f0], c[ ( f0 + 1 ) % n ] );
                if( !p ) continue;
                const inner = [ p, ...c.slice( e0 + 1, f0 + 1 ) ];
                const outerLoop = [ ...c.slice( 0, e0 + 1 ), p, ...c.slice( f0 + 1 ) ];
                const len = ( loop: Vec2[] ) => loop.reduce( ( s, q, i ) => s + dist( q, loop[ ( i + 1 ) % loop.length ] ), 0 );
                c = len( inner ) > len( outerLoop ) ? inner : outerLoop;
                cut = true;
                break outer;
            }
        }
        if( !cut ) break;
    }
    return c;
}

// vecutil.closest_distsqr_and_point_and_edge_index_on_line_strip_to_point()
export function closestOnLineStrip( strip: Vec2[], pt: Vec2, closed = false ): { distSqr: number, point: Vec2, edgeIndex: number, u: number } {
    let best = { distSqr: Infinity, point: strip[0], edgeIndex: 0, u: 0 };
    const count = closed ? strip.length : strip.length - 1;
    if( strip.length === 1 ) return { distSqr: mag2( sub( pt, strip[0] ) ), point: strip[0], edgeIndex: 0, u: 0 };
    for( let i = 0; i < count; ++i ) {
        const a = strip[i], b = strip[ ( i + 1 ) % strip.length ];
        const ab = sub( b, a );
        const len2 = mag2( ab );
        const u = len2 > 0 ? Math.max( 0, Math.min( 1, dot( sub( pt, a ), ab ) / len2 ) ) : 0;
        const p = add( a, scale( ab, u ) );
        const d = mag2( sub( pt, p ) );
        if( d < best.distSqr ) best = { distSqr: d, point: p, edgeIndex: i, u };
    }
    return best;
}

// helpers.contour_contains(): point in polygon (even-odd rule).
export function contourContains( contour: Vec2[], pt: Vec2 ): boolean {
    let inside = false;
    for( let i = 0, j = contour.length - 1; i < contour.length; j = i++ ) {
        const a = contour[i], b = contour[j];
        if( ( a[1] > pt[1] ) !== ( b[1] > pt[1] ) && pt[0] < ( b[0] - a[0] ) * ( pt[1] - a[1] ) / ( b[1] - a[1] ) + a[0] ) inside = !inside;
    }
    return inside;
}

// Eigen-decomposition of a symmetric 3x3 matrix by Jacobi rotations; returns eigenvectors as columns.
function symmetricEigen3( A: number[][] ): { values: number[], vectors: number[][] } {
    const a = A.map( r => r.slice() );
    const v = [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ] ];
    for( let sweep = 0; sweep < 50; ++sweep ) {
        let off = 0;
        for( let p = 0; p < 3; ++p ) for( let q = p + 1; q < 3; ++q ) off += a[p][q] ** 2;
        if( off < 1e-30 ) break;
        for( let p = 0; p < 3; ++p ) for( let q = p + 1; q < 3; ++q ) {
            if( Math.abs( a[p][q] ) < 1e-300 ) continue;
            const theta = ( a[q][q] - a[p][p] ) / ( 2 * a[p][q] );
            const t = Math.sign( theta || 1 ) / ( Math.abs( theta ) + Math.sqrt( theta * theta + 1 ) );
            const c = 1 / Math.sqrt( t * t + 1 ), s = t * c;
            for( let k = 0; k < 3; ++k ) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
            }
            for( let k = 0; k < 3; ++k ) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
            }
            for( let k = 0; k < 3; ++k ) {
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    return { values: [ a[0][0], a[1][1], a[2][2] ], vectors: v };
}

// vecutil.lsq_ellipse() / fitellipse.fitellipse( 'linear' ): a least squares ellipse fit with the
// Bookstein constraint.  Returns [ center, long axis, short axis ], or null if no ellipse fits.
export function fitEllipse( pts: Vec2[] ): [ Vec2, Vec2, Vec2 ] | null {
    if( pts.length < 6 ) return null;
    const centroid: Vec2 = [ 0, 0 ];
    for( const p of pts ) { centroid[0] += p[0] / pts.length; centroid[1] += p[1] / pts.length; }
    // Rows of B: [ x, y, 1, x^2, sqrt(2) x y, y^2 ].
    const S = Array.from( { length: 6 }, () => new Array( 6 ).fill( 0 ) );
    for( const p of pts ) {
        const x = p[0] - centroid[0], y = p[1] - centroid[1];
        const row = [ x, y, 1, x * x, Math.SQRT2 * x * y, y * y ];
        for( let i = 0; i < 6; ++i ) for( let j = 0; j < 6; ++j ) S[i][j] += row[i] * row[j];
    }
    // Minimize |B [v; w]| with |w| = 1: w is the smallest eigenvector of the Schur complement
    // S22 - S21 S11^-1 S12, and v = -S11^-1 S12 w.
    const S11 = new Matrix( 3, 3 );
    for( let i = 0; i < 3; ++i ) for( let j = 0; j < 3; ++j ) S11.set( i, j, S[i][j] );
    let lu: LU;
    try { lu = new LU( S11 ); } catch { return null; }
    const S11invS12 = [ 0, 1, 2 ].map( j => lu.solve( [ S[0][3 + j], S[1][3 + j], S[2][3 + j] ] ) );
    const schur = [ 0, 1, 2 ].map( i => [ 0, 1, 2 ].map( j => S[3 + i][3 + j] - ( S[3 + i][0] * S11invS12[j][0] + S[3 + i][1] * S11invS12[j][1] + S[3 + i][2] * S11invS12[j][2] ) ) );
    const { values, vectors } = symmetricEigen3( schur );
    let k = 0;
    for( let i = 1; i < 3; ++i ) if( values[i] < values[k] ) k = i;
    const w = [ vectors[0][k], vectors[1][k], vectors[2][k] ];
    const v = [ 0, 1, 2 ].map( i => -( S11invS12[0][i] * w[0] + S11invS12[1][i] * w[1] + S11invS12[2][i] * w[2] ) );

    // conic2parametric(): x'Ax + b'x + c = 0.
    const A = [ [ w[0], w[1] / Math.SQRT2 ], [ w[1] / Math.SQRT2, w[2] ] ];
    const b = [ v[0], v[1] ];
    const c = v[2];
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    if( det <= 0 ) return null;
    const t: Vec2 = [ -0.5 * ( A[1][1] * b[0] - A[0][1] * b[1] ) / det, -0.5 * ( -A[1][0] * b[0] + A[0][0] * b[1] ) / det ];
    const ch = t[0] * ( A[0][0] * t[0] + A[0][1] * t[1] ) + t[1] * ( A[1][0] * t[0] + A[1][1] * t[1] ) + b[0] * t[0] + b[1] * t[1] + c;
    // Eigen-decomposition of the 2x2 symmetric A.
    const tr = A[0][0] + A[1][1];
    const disc = Math.sqrt( Math.max( 0, ( A[0][0] - A[1][1] ) ** 2 / 4 + A[0][1] ** 2 ) );
    const l0 = tr / 2 + disc, l1 = tr / 2 - disc;
    let e0: Vec2 = Math.abs( A[0][1] ) > 1e-300 ? [ l0 - A[1][1], A[0][1] ] : ( A[0][0] >= A[1][1] ? [ 1, 0 ] : [ 0, 1 ] );
    e0 = scale( e0, 1 / mag( e0 ) );
    const e1: Vec2 = [ -e0[1], e0[0] ];
    const a0 = Math.sqrt( -ch / l0 ), a1 = Math.sqrt( -ch / l1 );
    if( !isFinite( a0 ) || !isFinite( a1 ) ) return null;
    const center = add( t, centroid );
    const axisA = scale( e0, a0 ), axisB = scale( e1, a1 );
    return a1 > a0 ? [ center, axisB, axisA ] : [ center, axisA, axisB ];
}

// laplacian_curve_editing.new_curve_from_curve_and_constraints(): Laplacian curve editing with
// per-vertex similarity transforms [Sorkine et al. 2004].  'constraints' fixes vertex positions.
export function laplacianCurveEdit( curve: Vec2[], constraints: [ number, Vec2 ][] ): Vec2[] {
    const n = curve.length;
    const neighbors = ( i: number ) => i === 0 ? [ 1 ] : i === n - 1 ? [ n - 2 ] : [ i - 1, i + 1 ];
    const L = ( i: number ): Vec2 => {
        const nb = neighbors( i );
        const avg = nb.reduce( ( s, j ) => add( s, scale( curve[j], 1 / nb.length ) ), [ 0, 0 ] as Vec2 );
        return sub( curve[i], avg );
    };
    // Unknowns: x (n), y (n), a (n), w (n), tx (n), ty (n).
    const X = 0, Y = n, A = 2 * n, W = 3 * n, TX = 4 * n, TY = 5 * n;
    const N = 6 * n;
    const system = new Matrix( N, N );
    const rhs = new Float64Array( N );
    const addRow = ( row: Map<number, number>, weight: number, r = 0 ) => {
        const entries = [ ...row.entries() ];
        for( const [ i, ci ] of entries ) {
            for( const [ j, cj ] of entries ) system.addTo( i, j, weight * ci * cj );
            rhs[i] += weight * ci * r;
        }
    };
    const kE1 = 1e1, kE2 = 1e7, kE3 = 1e7;
    for( let i = 0; i < n; ++i ) {
        const l = L( i );
        const nb = neighbors( i );
        // T_i( delta_i ) - L(x) = 0, where T_i = [ a w; -w a ] plus translation.
        const rx = new Map<number, number>( [ [ A + i, l[0] ], [ W + i, l[1] ], [ TX + i, 1 ] ] );
        rx.set( X + i, ( rx.get( X + i ) ?? 0 ) - 1 );
        for( const j of nb ) rx.set( X + j, ( rx.get( X + j ) ?? 0 ) + 1 / nb.length );
        addRow( rx, kE1 );
        const ry = new Map<number, number>( [ [ A + i, l[1] ], [ W + i, -l[0] ], [ TY + i, 1 ] ] );
        ry.set( Y + i, ( ry.get( Y + i ) ?? 0 ) - 1 );
        for( const j of nb ) ry.set( Y + j, ( ry.get( Y + j ) ?? 0 ) + 1 / nb.length );
        addRow( ry, kE1 );
        // T_i should map the vertex and its neighbors' undeformed positions to their deformed positions.
        for( const v of [ i, ...nb ] ) {
            addRow( new Map( [ [ A + i, curve[v][0] ], [ W + i, curve[v][1] ], [ TX + i, 1 ], [ X + v, -1 ] ] ), kE3 );
            addRow( new Map( [ [ A + i, curve[v][1] ], [ W + i, -curve[v][0] ], [ TY + i, 1 ], [ Y + v, -1 ] ] ), kE3 );
        }
    }
    for( const [ index, pos ] of constraints ) {
        addRow( new Map( [ [ X + index, 1 ] ] ), kE2, pos[0] );
        addRow( new Map( [ [ Y + index, 1 ] ] ), kE2, pos[1] );
    }
    const x = new LU( system ).solve( rhs );
    return curve.map( ( _, i ) => [ x[X + i], x[Y + i] ] );
}

// curve_oversketching.membrane_smooth_curve_range_preserving_tangents(), in place.
function membraneSmoothRange( curve: Vec2[], start: number, end: number ): void {
    if( !( start + 1 < end - 1 ) ) return;
    const domain = curve.slice( start, end + 1 );
    const m = domain.length;
    const diffuse = makeDiffuser( domain );
    const result = diffuse( [ [ 0, domain[0] ], [ 1, domain[1] ], [ m - 2, domain[m - 2] ], [ m - 1, domain[m - 1] ] ] );
    for( let i = 0; i < m; ++i ) curve[ start + i ] = [ result[i][0], result[i][1] ];
}

// curve_oversketching.curve_from_base_curve_and_oversketch_curve(): replaces part of 'curve' with
// 'over' (if both of its ends are near the curve) or extends the curve (if one end is near it).
// Returns the new curve and remaps the parameters 'ts' (in place) to the new curve.
export function oversketch( curve: Vec2[], over: Vec2[], zoom: number, ts: number[] ): Vec2[] {
    const threshold = 0.05 / zoom;
    const kSmoothPercent = 20;
    let startInfo = closestOnLineStrip( curve, over[0] );
    let endInfo = closestOnLineStrip( curve, over[ over.length - 1 ] );
    const remap = ( mapT: ( t: number ) => number ) => {
        for( let i = 0; i < ts.length; ++i ) {
            const v = mapT( ts[i] );
            ts[i] = Math.max( 0, Math.min( 1, isFinite( v ) ? v : 0 ) );
        }
    };
    const pyRound = ( x: number ) => Math.round( x );

    if( startInfo.distSqr < threshold ** 2 && endInfo.distSqr < threshold ** 2 ) {
        if( startInfo.edgeIndex === endInfo.edgeIndex ) return curve;
        if( startInfo.edgeIndex > endInfo.edgeIndex ) {
            [ startInfo, endInfo ] = [ endInfo, startInfo ];
            over = over.slice().reverse();
        }
        const result = [ ...curve.slice( 0, startInfo.edgeIndex + 1 ), ...over, ...curve.slice( endInfo.edgeIndex + 1 ) ];
        const pc = pyRound( kSmoothPercent / 100 * curve.length );
        const po = pyRound( kSmoothPercent / 100 * over.length );
        const middle = startInfo.edgeIndex + 1 + Math.floor( over.length / 2 );
        membraneSmoothRange( result, Math.max( 0, startInfo.edgeIndex - 1 - pc ), Math.min( middle + 1, startInfo.edgeIndex + 2 + po ) );
        membraneSmoothRange( result,
            Math.max( middle, startInfo.edgeIndex + 1 + over.length - 2 - po ),
            Math.min( result.length - 1, startInfo.edgeIndex + 1 + over.length + 1 + pc ) );
        const oldStart = edgeIndex2t( startInfo.edgeIndex, curve.length );
        const newStart = edgeIndex2t( startInfo.edgeIndex, result.length );
        const oldEnd = edgeIndex2t( endInfo.edgeIndex, curve.length );
        const newEnd = edgeIndex2t( startInfo.edgeIndex + over.length, result.length );
        remap( t =>
            t < oldStart ? ( oldStart === 0 ? 0 : ( t / oldStart ) * newStart ) :
            t <= oldEnd ? ( oldEnd === oldStart ? newStart : ( ( t - oldStart ) / ( oldEnd - oldStart ) ) * ( newEnd - newStart ) + newStart ) :
            ( oldEnd === 1 ? newEnd : ( t - oldEnd ) / ( 1 - oldEnd ) * ( 1 - newEnd ) + newEnd ) );
        return result;
    }

    const close = [ startInfo, endInfo ].filter( info => info.distSqr < threshold ** 2 );
    if( close.length > 0 ) {
        const info = close[0];
        if( info === endInfo ) over = over.slice().reverse();
        let result: Vec2[], oldT: number, newT: number;
        const e = info.edgeIndex;
        if( dot( sub( curve[e + 1], curve[e] ), sub( over[1], over[0] ) ) > 0 ) {
            result = [ ...curve.slice( 0, e + 1 ), ...over ];
            oldT = edgeIndex2t( e, curve.length );
            newT = edgeIndex2t( e, result.length );
            const pc = kSmoothPercent / 100 * curve.length, po = kSmoothPercent / 100 * over.length;
            membraneSmoothRange( result, Math.max( 0, pyRound( e - 1 - pc ) ), Math.min( result.length - 1, pyRound( e + 2 + po ) ) );
        } else {
            result = [ ...over.slice().reverse(), ...curve.slice( e + 1 ) ];
            oldT = edgeIndex2t( e, curve.length );
            newT = edgeIndex2t( over.length - 1, result.length );
            const pc = pyRound( kSmoothPercent / 100 * curve.length ), po = pyRound( kSmoothPercent / 100 * over.length );
            membraneSmoothRange( result, Math.max( 0, over.length - 2 - po ), Math.min( result.length - 1, over.length + 1 + pc ) );
        }
        remap( t => t < oldT ? ( oldT === 0 ? 0 : ( t / oldT ) * newT ) : ( oldT === 1 ? newT : ( ( t - oldT ) / ( 1 - oldT ) ) * ( 1 - newT ) + newT ) );
        return result;
    }

    return over;
}

// annotations_sweep.normalize_arbitrary_cross_section(): centers a loop of samples, scales it so its
// farthest point is at distance 1, starts it at the x axis crossing, and orients it counter-clockwise.
export function normalizeCrossSection( xsection: Vec2[] ): Vec2[] {
    const n = xsection.length;
    const c: Vec2 = [ 0, 0 ];
    for( const p of xsection ) { c[0] += p[0] / n; c[1] += p[1] / n; }
    let pts = xsection.map( p => sub( p, c ) );
    const maxMag = Math.max( ...pts.map( p => mag( p ) ) );
    pts = pts.map( p => scale( p, 1 / maxMag ) );
    const crossings: number[] = [];
    for( let ei = 0; ei < n; ++ei ) if( pts[ei][1] < 0 && pts[ ( ei + 1 ) % n ][1] >= 0 ) crossings.push( ei );
    if( crossings.length > 0 ) {
        let best = crossings[0], bestKey = Infinity;
        for( const ei of crossings ) {
            const key = Math.min( ei + 1, n - 1 - ei );
            if( key < bestKey ) { bestKey = key; best = ei; }
        }
        pts = [ ...pts.slice( best + 1 ), ...pts.slice( 0, best + 1 ) ];
    }
    let area = 0;
    for( let i = 0; i < n; ++i ) area += pts[i][0] * pts[ ( i + 1 ) % n ][1] - pts[ ( i + 1 ) % n ][0] * pts[i][1];
    if( area < 0 ) pts.reverse();
    return pts;
}
