// Editing operations on primitives and annotations, used by the interactive tools.
// Ports editing methods of annotations_sweep.SweepShape and annotations_ellipsoid.AnnotationData,
// and wx_annotate_collection.GarbageCollectMetaAnnotations().

import { Cylinder, TMap } from './cylinder';
import { Ellipsoid } from './ellipsoid';
import { Scene, Annotation, Connection } from './scene';
import { t2edgeIndex, t2vertexIndex, vertexIndex2s } from './spine';
import { smoothOpenStroke } from './curves';
import { Vec2, Vec3, add, sub, scale, dot, mag, mag2, dir, cross, clamp, kEps } from './vec';

// Python's modulo (the result has the sign of the divisor).
export function pyMod( a: number, m: number ): number { return ( ( a % m ) + m ) % m; }

// helpers.asin_periodic(): asin, continued periodically beyond [-1,1].
export function asinPeriodic( x: number ): number {
    const shifted = pyMod( x + 1, 2 ) - 1;
    return Math.asin( clamp( shifted, -1, 1 ) ) + Math.PI * Math.floor( ( x + 1 ) * 0.5 );
}

// The line loop sampling a tilted circle (helpers.line_loop_from_tilted_circle()).
export function tiltedCircleLoop( center: Vec3, radius: number, normal: Vec3, samples = 40 ): Vec3[] {
    // Rotate (0,0,1) to the normal.
    const n = dir( normal );
    let u: Vec3, v: Vec3;
    const axis = cross( [ 0, 0, 1 ], n );
    const s = mag( axis ), c = n[2];
    if( s < 1e-7 ) {
        // The normal is (anti)parallel to z.
        u = [ 1, 0, 0 ];
        v = c >= 0 ? [ 0, 1, 0 ] : [ 0, -1, 0 ];
    } else {
        // Rodrigues' rotation of the x and y axes about 'axis' by the angle between z and n.
        const k = scale( axis, 1 / s );
        const rot = ( p: Vec3 ): Vec3 => add( add( scale( p, c ), scale( cross( k, p ), s ) ), scale( k, dot( k, p ) * ( 1 - c ) ) );
        u = rot( [ 1, 0, 0 ] );
        v = rot( [ 0, 1, 0 ] );
    }
    const result: Vec3[] = [];
    for( let i = 0; i < samples - 1; ++i ) {
        const theta = 2 * Math.PI * i / ( samples - 1 );
        result.push( add( center, add( scale( u, radius * Math.cos( theta ) ), scale( v, radius * Math.sin( theta ) ) ) ) );
    }
    return result;
}

// ---- Cylinders -------------------------------------------------------------------------------

// SweepShape.set_spine2d(): replaces the spine, optionally remapping the t's of all attributes.
// Returns false (and changes nothing) if attributes would collide on the new, shorter spine.
export function setSpine2d( shape: Cylinder, spine: Vec2[], tMap?: Map<number, number> ): boolean {
    const n = spine.length;
    if( n < 2 ) return false;
    const map = <T>( m: TMap<T> ) => tMap ? m.remap( t => tMap.get( t ) ?? t ) : m;
    const tilts = map( shape.tilts ), radii = map( shape.radii ), xs = map( shape.crossSections ), sym = map( shape.symmetry );
    for( const ts of [ tilts.keys(), radii.keys(), xs.keys(), sym.keys() ] ) {
        if( new Set( ts.map( t => t2edgeIndex( t, n ) ) ).size !== ts.length && n < shape.spine2d.length ) return false;
    }
    shape.spine2d = spine.map( p => [ p[0], p[1] ] );
    shape.tilts = tilts; shape.radii = radii; shape.crossSections = xs; shape.symmetry = sym;
    shape.changed( 'spine' );
    return true;
}

// SweepShape.resample(): resamples the spine to 'n' vertices, preserving attributes' positions.
export function resampleSpine( shape: Cylinder, n: number ): void {
    if( n === shape.n ) return;
    const newSpine = smoothOpenStroke( shape.spine2d, 10, n );
    const N = newSpine.length;
    const tMap = new Map<number, number>();
    for( const t of shape.allParticularTs() ) {
        const vi = Math.max( 0, Math.min( N - 1, Math.round( t2vertexIndex( t, shape.n ) * ( N - 1 ) / ( shape.n - 1 ) ) ) );
        tMap.set( t, vertexIndex2s( vi, newSpine ) );
    }
    setSpine2d( shape, newSpine, tMap );
}

// SweepShape.smooth_spine2d()
export function smoothSpine( shape: Cylinder, iterations = 10 ): void {
    const newSpine = smoothOpenStroke( shape.spine2d, iterations, shape.n );
    const tMap = new Map<number, number>();
    for( const t of shape.allParticularTs() ) tMap.set( t, vertexIndex2s( t2vertexIndex( t, shape.n ), newSpine ) );
    setSpine2d( shape, newSpine, tMap );
}

export function straightenSpine( shape: Cylinder ): void {
    const a = shape.spine2d[0], b = shape.spine2d[ shape.n - 1 ];
    setSpine2d( shape, shape.spine2d.map( ( _, i ) => add( a, scale( sub( b, a ), i / ( shape.n - 1 ) ) ) ) );
}

// The number of spine samples per unit length for new strokes.
export const kSamplesPerUnitDistance = 20;

// SpineDrawer.doStrokeFinished(): a new cylinder from a stroke.
export function cylinderFromStroke( id: string, stroke: Vec2[], radius: number, zoom: number, straight: boolean ): Cylinder | null {
    if( stroke.length < 3 ) return null;
    let length = 0;
    for( let i = 1; i < stroke.length; ++i ) length += mag( sub( stroke[i], stroke[i - 1] ) );
    const n = Math.max( 3, Math.ceil( kSamplesPerUnitDistance * zoom * length ) );
    const spine = straight
        ? Array.from( { length: n }, ( _, i ) => add( stroke[0], scale( sub( stroke[ stroke.length - 1 ], stroke[0] ), i / ( n - 1 ) ) ) )
        : smoothOpenStroke( stroke, 10, n );
    return new Cylinder( id, {
        spine,
        tilts: [ [ 0, 0 ], [ 1, 0 ] ],
        radii: [ [ 0, radius ], [ 1, radius ] ],
        symmetry: [ [ 0.5, -0.5 * Math.PI ] ],
        crossSections: [],
        capRadii: [ null, null ],
    } );
}

// The 2d points on the outline perpendicular to the spine at t (right turn first).
export function boundaryPerpendicular( shape: Cylinder, t: number ): [ Vec2, Vec2 ] {
    const p = shape.spine2dAtT( t );
    const r = shape.radiusAtT( t );
    const tan = shape.tangent2dAtT( t );
    const perp = dir( [ tan[1], -tan[0] ] as Vec2 );
    return [ add( p, scale( perp, r ) ), sub( p, scale( perp, r ) ) ];
}

// SweepShape.compute_tilt_radians_from_point_at_t()
export function tiltFromPoint( shape: Cylinder, t: number, point: Vec2 ): number {
    const center = shape.spine2dAtT( t );
    const unitTangent = dir( shape.tangent2dAtT( t ) );
    const x = dot( sub( point, center ), unitTangent ) / shape.radiusAtT( t );
    return Math.asin( clamp( x, -1, 1 ) );
}

// SweepShape.tilt_radians_at_t()
export function tiltAt( shape: Cylinder, t: number ): number {
    const n = shape.tangent3dAtT( t );
    return -Math.atan( n[2] / mag( [ n[0], n[1] ] ) );
}

// SymmetryPlaneManip: the symmetry angle for a dragged point.
export function symmetryFromPoint( shape: Cylinder, t: number, point: Vec2, periodic: boolean ): number {
    const center = shape.spine2dAtT( t );
    const radius = shape.radiusAtT( t );
    const perp = sub( boundaryPerpendicular( shape, t )[0], center );
    const x = dot( sub( point, center ), perp ) / ( radius * radius );
    return periodic ? pyMod( asinPeriodic( x ) - Math.PI, 2 * Math.PI ) - Math.PI : Math.asin( clamp( x, -1, 1 ) );
}

// SweepShape.symmetry_radians_at_t()
export function symmetryAt( shape: Cylinder, t: number ): number {
    const v = shape.symmetry.get( t );
    if( v !== undefined ) return v;
    const vi = shape.vertexIndexAtT( t );
    const [ ups, normals ] = shape.frameComponents();
    const d = dir( shape.symmetryDirections[vi] );
    return Math.atan2( dot( d, normals[vi] ), dot( d, ups[vi] ) );
}

// The 3d unit direction in which a cross section's tilt handle lies (perpendicular to the spine,
// in the plane containing the spine tangent and the view direction).
export function tiltDirection( shape: Cylinder, t: number ): Vec3 {
    const t3 = shape.tangent3dAtT( t );
    return dir( cross( cross( t3, [ 0, 0, 1 ] ), t3 ) );
}

// The 3d line loop of the cross section at t (SweepShape.cross_section_line_loop3d_at_t()).
export function crossSectionLoop3d( shape: Cylinder, t: number ): Vec3[] {
    const center = shape.spine3dAtT( t );
    const radius = shape.radiusAtT( t );
    if( shape.denseCrossSections.length === 0 ) return tiltedCircleLoop( center, radius, shape.tangent3dAtT( t ) );
    const loop = shape.crossSections.get( t ) ?? shape.denseCrossSections[ shape.vertexIndexAtT( t ) ];
    const xvec = dir( shape.symmetryDirections[ shape.vertexIndexAtT( t ) ] );
    const zvec = dir( shape.tangent3dAtT( t ) );
    const yvec = cross( zvec, xvec );
    return loop.map( p => add( center, scale( add( scale( xvec, p[0] ), scale( yvec, p[1] ) ), radius ) ) );
}

// The cross section loop (normalized) at t, for editing.
export function crossSectionAt( shape: Cylinder, t: number ): Vec2[] {
    const xs = shape.crossSections.get( t );
    if( xs ) return xs;
    if( shape.denseCrossSections.length > 0 ) return shape.denseCrossSections[ shape.vertexIndexAtT( t ) ];
    return Array.from( { length: 21 }, ( _, i ) => [ Math.cos( 2 * Math.PI * i / 21 ), Math.sin( 2 * Math.PI * i / 21 ) ] as Vec2 );
}

// ---- Ellipsoids ------------------------------------------------------------------------------

// helpers.solve_for_fixed_points(): the similarity transform mapping src0 -> dst0 and src1 -> dst1, applied to 'points'.
export function similarityTransform( points: Vec2[], src: [ Vec2, Vec2 ], dst: [ Vec2, Vec2 ] ): Vec2[] {
    const [ s0, s1 ] = src, [ d0, d1 ] = dst;
    // Solve [ a -b tx ; b a ty ] mapping.
    const ds = sub( s1, s0 ), dd = sub( d1, d0 );
    const den = mag2( ds );
    const a = ( dd[0] * ds[0] + dd[1] * ds[1] ) / den;
    const b = ( dd[1] * ds[0] - dd[0] * ds[1] ) / den;
    const tx = d0[0] - ( a * s0[0] - b * s0[1] );
    const ty = d0[1] - ( b * s0[0] + a * s0[1] );
    return points.map( p => [ tx + a * p[0] - b * p[1], ty + b * p[0] + a * p[1] ] );
}

export type EllipsoidHandle = 'move' | 'axis0+' | 'axis0-' | 'axis1+' | 'axis1-' | 'tilt';

// The ellipsoid handles' drag behaviors (AnnotationData._GenHandles()).
export function dragEllipsoidHandle( e: Ellipsoid, handle: EllipsoidHandle, offset: Vec2 ): void {
    const tip2 = (): Vec2 => [ e.center[0] + e.axes[2][0], e.center[1] + e.axes[2][1] ];
    if( handle === 'move' ) {
        e.center = [ e.center[0] + offset[0], e.center[1] + offset[1], e.center[2] ];
        e.setCrossSectionFromPoint( 1, tip2() );
        return;
    }
    if( mag2( offset ) < kEps ) return;
    if( handle === 'axis0+' || handle === 'axis0-' ) {
        const sign = handle === 'axis0+' ? 1 : -1;
        const c2: Vec2 = [ e.center[0], e.center[1] ];
        const tip: Vec2 = [ c2[0] + sign * e.axes[0][0], c2[1] + sign * e.axes[0][1] ];
        const pts: Vec2[] = [ 0, 1, 2 ].map( i => [ c2[0] + e.axes[i][0], c2[1] + e.axes[i][1] ] as Vec2 );
        const xformed = similarityTransform( [ ...pts, c2 ], [ c2, tip ], [ c2, add( tip, offset ) ] );
        const nc = xformed[3];
        e.center = [ nc[0], nc[1], e.center[2] ];
        for( let i = 0; i < 3; ++i ) e.axes[i] = [ xformed[i][0] - nc[0], xformed[i][1] - nc[1], e.axes[i][2] ];
        e.setCrossSectionFromPoint( 1, tip2() );
        return;
    }
    if( handle === 'axis1+' || handle === 'axis1-' ) {
        const old = scale( e.axes[1], handle === 'axis1+' ? 1 : -1 );
        const moved: Vec3 = [ old[0] + offset[0], old[1] + offset[1], old[2] ];
        const s = dot( moved, old ) / mag2( old );
        if( s < kEps ) return;
        e.axes[1] = scale( e.axes[1], s );
        // Axis 0 must remain the long axis.
        if( mag2( e.axes[1] ) > mag2( e.axes[0] ) ) e.axes[1] = scale( e.axes[1], Math.sqrt( mag2( e.axes[0] ) / mag2( e.axes[1] ) ) );
        e.setCrossSectionFromPoint( 1, tip2() );
        return;
    }
    // Tilt: drag the projection of axis 2's tip.
    const t = tip2();
    e.setCrossSectionFromPoint( 1, [ t[0] + offset[0], t[1] + offset[1] ] );
}

// ---- Annotations -----------------------------------------------------------------------------

// GarbageCollectMetaAnnotations(): removes annotations (and annotation items) that refer to
// shapes or handles that no longer exist.  Same-length connection indices are updated.
export function garbageCollect( scene: Scene ): void {
    const has = ( id: string ) => scene.shapes.some( s => s.id === id );
    const shape = ( id: string ) => scene.shape( id );
    const connectionBetween = ( a: string, b: string ) => scene.connections().some( c => c.shapes.includes( a ) && c.shapes.includes( b ) && a !== b );

    const keep = ( a: Annotation ): boolean => {
        switch( a.type ) {
            case 'connection': return a.shapes.every( has );
            case 'sameTilt':
                a.items = a.items.filter( i => {
                    const s = shape( i.shape );
                    if( !s ) return false;
                    return s instanceof Ellipsoid || ( i.t !== undefined && s.tilts.has( i.t ) );
                } );
                a.masters = a.masters.filter( m => m < a.items.length );
                return a.items.length >= 2;
            case 'sameScale':
                a.items = a.items.filter( i => {
                    const s = shape( i.shape );
                    if( !s ) return false;
                    return s instanceof Ellipsoid || ( i.t !== undefined && s.radii.has( i.t ) );
                } );
                a.masters = a.masters.filter( m => m < a.items.length );
                return a.items.length >= 2;
            case 'sameLength':
                a.items = a.items.filter( i => has( i.shape ) );
                a.masters = a.masters.filter( m => m < a.items.length );
                return a.items.length >= 2;
            case 'mirror': return has( a.shape ) && has( a.parent ) && connectionBetween( a.shape, a.parent );
            case 'align': return a.shapes.every( has ) && has( a.parent );
        }
    };

    // Connections first, since mirror annotations depend on them.
    const old = scene.annotations;
    const keptConnections = new Set( old.filter( a => a.type === 'connection' && keep( a ) ) );
    scene.annotations = old.filter( a => a.type !== 'connection' || keptConnections.has( a ) );
    scene.annotations = scene.annotations.filter( a => a.type === 'connection' || keep( a ) );

    // Re-index same-length references to connections.
    const newIndex = new Map<Annotation, number>();
    scene.annotations.forEach( ( a, i ) => newIndex.set( a, i ) );
    for( const a of scene.annotations ) {
        if( a.type !== 'sameLength' ) continue;
        for( const item of a.items ) {
            if( item.connection === null ) continue;
            const con = old[ item.connection ] as Connection | undefined;
            item.connection = con && newIndex.has( con ) ? newIndex.get( con )! : null;
        }
    }
}

// Removes a shape and everything that refers to it.
export function removeShape( scene: Scene, id: string ): void {
    scene.shapes = scene.shapes.filter( s => s.id !== id );
    garbageCollect( scene );
}

// Removes an annotation, keeping same-length connection references valid.
export function removeAnnotation( scene: Scene, ann: Annotation ): void {
    const old = scene.annotations;
    scene.annotations = old.filter( a => a !== ann );
    const newIndex = new Map<Annotation, number>();
    scene.annotations.forEach( ( a, i ) => newIndex.set( a, i ) );
    for( const a of scene.annotations ) {
        if( a.type !== 'sameLength' ) continue;
        for( const item of a.items ) {
            if( item.connection === null ) continue;
            const con = old[ item.connection ];
            item.connection = newIndex.has( con ) ? newIndex.get( con )! : null;
        }
    }
    garbageCollect( scene );
}

// The shapes connected to 'id' (wx_annotate_collection.neighbors()).
export function neighbors( scene: Scene, id: string ): Set<string> {
    const result = new Set<string>();
    for( const c of scene.connections() ) if( c.shapes.includes( id ) ) c.shapes.forEach( s => result.add( s ) );
    result.delete( id );
    return result;
}

// Whether 'b' is reachable from 'a' through connections.
export function connected( scene: Scene, a: string, b: string ): boolean {
    const seen = new Set<string>( [ a ] );
    const stack = [ a ];
    while( stack.length ) {
        const s = stack.pop()!;
        if( s === b ) return true;
        for( const n of neighbors( scene, s ) ) if( !seen.has( n ) ) { seen.add( n ); stack.push( n ); }
    }
    return false;
}

export function newId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${ Date.now() }-${ Math.random().toString( 36 ).slice( 2 ) }`;
}

