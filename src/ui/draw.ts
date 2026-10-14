// Drawing primitives, handles, and annotations in the 2d view.
// Ports the drawing methods of wx_annotate_collection.AnnotateCanvasCollection.

import { Cylinder } from '../core/cylinder';
import { Ellipsoid } from '../core/ellipsoid';
import { Scene, Shape, Connection, SameTilt, SameScale, SameLength, Mirror, Align, Annotation } from '../core/scene';
import { crossSectionLoop3d, tiltedCircleLoop } from '../core/edit';
import { connectionIntersection } from '../core/intersections';
import { originRelativeTo } from '../core/solve';
import { segLengths } from '../core/vec';
import { View2D, Colors, rgba, RGB } from './view2d';
import { Part, CylinderPick, symmetryHandlePos, capHandlePos, tiltHandlePos, diameterSegment } from './pick';
import { Vec2, Vec3, add, sub, scale, dir, to2 } from '../core/vec';

export type Widgets = Record<string, HTMLImageElement>;

export function drawCylinder( v: View2D, shape: Cylinder, opts: { fill: boolean, locked: boolean } ): void {
    const W = v.lineWidth;
    if( opts.locked ) {
        v.stroke( shape.boundary2d, rgba( Colors.silhouette ), 1 / v.scale, true );
        return;
    }
    if( opts.fill ) v.fill( shape.boundary2d, 'rgba(255,255,255,0.9)' );
    v.stroke( shape.spine2d, rgba( Colors.spine ), W );
    for( const t of shape.radii.keys() ) v.stroke( diameterSegment( shape, t ), rgba( Colors.diameter ), 0.25 * W );
    for( const t of [ ...shape.tilts.keys(), ...shape.crossSections.keys() ] ) {
        const color = shape.crossSections.has( t ) ? Colors.symmetryXSection : Colors.circularXSection;
        v.strokeDepthFaded( crossSectionLoop3d( shape, t ), color, 0.75 * W );
    }
    v.stroke( shape.boundary2d, rgba( Colors.silhouette ), W, true );
}

export function drawEllipsoid( v: View2D, e: Ellipsoid, opts: { fill: boolean, locked: boolean } ): void {
    const W = v.lineWidth;
    const [ c, a, b ] = e.ellipse;
    if( opts.locked ) {
        v.ellipse( c, a, b, rgba( Colors.silhouette ), 1 / v.scale );
        return;
    }
    if( opts.fill ) {
        const pts: Vec2[] = [];
        for( let i = 0; i < 64; ++i ) { const th = 2 * Math.PI * i / 64; pts.push( add( c, add( scale( a, Math.cos( th ) ), scale( b, Math.sin( th ) ) ) ) ); }
        v.fill( pts, 'rgba(255,255,255,0.9)' );
    }
    v.ellipse( c, a, b, rgba( Colors.silhouette ), W );
    v.strokeDepthFaded( tiltedCircleLoop( e.center, e.getRadius(), e.axes[0] ), Colors.circularXSection, 0.75 * W );
}

export function drawShape( v: View2D, shape: Shape, opts: { fill: boolean, locked: boolean } ): void {
    if( shape instanceof Cylinder ) drawCylinder( v, shape, opts );
    else drawEllipsoid( v, shape, opts );
}

// DrawSweepShapeHandles()
export function drawCylinderHandles( v: View2D, shape: Cylinder, widgets: Widgets ): void {
    const W = 0.75 * v.lineWidth;
    const P = v.pointThreshold;
    const s3 = shape.spine3d;
    const dirs = shape.symmetryDirections.map( d => dir( d ) );
    const radii = shape.denseRadii;
    // The symmetry sheet's intersection with the surface (approximately): lines along the top and
    // bottom of the shape, and at its ends.
    const color = rgba( Colors.symmetrySheet );
    v.stroke( s3.map( ( p, i ) => add( p, scale( dirs[i], radii[i] ) ) ), color, W );
    v.stroke( s3.map( ( p, i ) => sub( p, scale( dirs[i], radii[i] ) ) ), color, W );
    for( const i of [ 0, s3.length - 1 ] ) v.stroke( [ add( s3[i], scale( dirs[i], radii[i] ) ), sub( s3[i], scale( dirs[i], radii[i] ) ) ], color, 1 / v.scale );

    for( const t of shape.symmetry.keys() ) {
        const tan = shape.tangent3dAtT( t );
        v.image( widgets.symmetry_plane_manip, symmetryHandlePos( shape, t ), [ -tan[1], tan[0] ], 4 * P );
    }
    for( const end of [ 0, 1 ] as const ) {
        v.image( widgets.cap_radius_manip, capHandlePos( shape, end ), shape.tangent2dAtT( end ), 6 * P, shape.capRadii[end] === null ? 0.5 : 1 );
    }
    for( const t of shape.tilts.keys() ) {
        v.image( widgets.cross_section_tilt, tiltHandlePos( shape, t ), shape.tangent3dAtT( t ), 4 * P );
    }
    for( const t of shape.radii.keys() ) {
        const c = shape.spine2dAtT( t );
        const n = shape.tangent3dAtT( t );
        const perp = scale( dir( [ n[1], -n[0] ] as Vec2 ), shape.radiusAtT( t ) );
        v.image( widgets.radius_manip, add( c, perp ), perp, 6 * P );
        v.image( widgets.radius_manip, sub( c, perp ), scale( perp, -1 ), 6 * P );
    }
}

// DrawEllipseHandles()
export function drawEllipsoidHandles( v: View2D, e: Ellipsoid, widgets: Widgets ): void {
    const P = v.pointThreshold;
    const sign = e.axes[0][2] >= 0 ? 1 : -1;
    v.image( widgets.ellipse_rotscale, add( e.center, scale( e.axes[0], sign ) ), scale( e.axes[0], sign ), 8 * P );
    if( Math.abs( e.axes[0][2] ) < 1e-5 ) v.image( widgets.ellipse_rotscale, sub( e.center, scale( e.axes[0], sign ) ), scale( e.axes[0], -sign ), 8 * P );
    v.image( widgets.radius_manip, add( e.center, e.axes[1] ), e.axes[1], 6 * P );
    v.image( widgets.radius_manip, sub( e.center, e.axes[1] ), scale( e.axes[1], -1 ), 6 * P );
    v.image( widgets.cross_section_tilt, add( e.center, e.axes[2] ), e.axes[0], 4 * P );
}

// DrawPickedSweepShapeHandle(): a highlight ("smart guide", as in Illustrator) of the picked part.
export function drawCylinderGuide( v: View2D, shape: Cylinder, pick: CylinderPick ): void {
    const color = rgba( Colors.smartGuide );
    const px = 1 / v.scale;
    const dot = ( p: Vec2 | Vec3 ) => v.disk( p, 3 * px, color );
    switch( pick.part ) {
        case Part.SymmetryPlaneHandle: {
            const s3 = shape.spine3d, dirs = shape.symmetryDirections.map( d => dir( d ) ), r = shape.denseRadii;
            v.stroke( s3.map( ( p, i ) => add( p, scale( dirs[i], r[i] ) ) ), color, px );
            v.stroke( s3.map( ( p, i ) => sub( p, scale( dirs[i], r[i] ) ) ), color, px );
            dot( symmetryHandlePos( shape, pick.t! ) );
            break;
        }
        case Part.CapRadiusHandle: dot( capHandlePos( shape, pick.t as 0 | 1 ) ); break;
        case Part.RadiusHandle: {
            const [ a, b ] = diameterSegment( shape, pick.t! );
            dot( a ); dot( b );
            break;
        }
        case Part.CrossSectionTiltHandle: dot( tiltHandlePos( shape, pick.t! ) ); break;
        case Part.Diameter: v.stroke( diameterSegment( shape, pick.t! ), color, px ); break;
        case Part.CrossSection:
        case Part.CrossSectionInterior: v.stroke( crossSectionLoop3d( shape, pick.t! ), color, px, true ); break;
        case Part.Spine:
            v.stroke( shape.spine2d, color, px );
            dot( shape.spine2dAtT( pick.t! ) );
            if( shape.crossSections.has( pick.t! ) ) v.stroke( crossSectionLoop3d( shape, pick.t! ), color, px, true );
            break;
        case Part.Boundary:
        case Part.BoundaryInterior: v.stroke( shape.boundary2d, color, px, true ); break;
    }
}

export function drawEllipsoidGuide( v: View2D, e: Ellipsoid ): void {
    const [ c, a, b ] = e.ellipse;
    v.ellipse( c, a, b, rgba( Colors.smartGuide ), 1 / v.scale );
}

export function drawShapeGuide( v: View2D, shape: Shape ): void {
    if( shape instanceof Cylinder ) drawCylinderGuide( v, shape, { part: Part.BoundaryInterior } );
    else drawEllipsoidGuide( v, shape );
}

// A color for an annotation group (GetSamePropertyColor() uses a random value per group;
// here it is derived from the annotation's position in the list).
export function groupColor( index: number ): RGB {
    const h = ( index * 0.6180339887 ) % 1;
    // HSV to RGB with full saturation and value, then darkened.
    const i = Math.floor( h * 6 ), f = h * 6 - i;
    const q = 1 - f;
    const [ r, g, b ] = [ [ 1, f, 0 ], [ q, 1, 0 ], [ 0, 1, f ], [ 0, q, 1 ], [ f, 0, 1 ], [ 1, 0, q ] ][ i % 6 ];
    return [ Math.round( 0.75 * 255 * r ), Math.round( 0.75 * 255 * g ), Math.round( 0.75 * 255 * b ) ];
}

// Tinted copies of white widget images, for annotation markings.
const tintCache = new Map<string, HTMLCanvasElement>();
function tinted( img: HTMLImageElement, color: RGB ): HTMLCanvasElement {
    const key = `${ img.src }|${ color.join( ',' ) }`;
    let c = tintCache.get( key );
    if( !c ) {
        c = document.createElement( 'canvas' );
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext( '2d' )!;
        ctx.drawImage( img, 0, 0 );
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = rgba( color );
        ctx.fillRect( 0, 0, c.width, c.height );
        tintCache.set( key, c );
    }
    return c;
}

// The 2d center and unit direction at which a same-tilt or same-scale marking is drawn.
function markingFrame( scene: Scene, item: { shape: string, t?: number } ): [ Vec2, Vec2 ] | null {
    const s = scene.shape( item.shape );
    if( !s ) return null;
    if( s instanceof Ellipsoid ) return [ s.ellipse[0], dir( s.ellipse[1] ) ];
    if( item.t === undefined ) {
        const half = Math.floor( s.n / 2 );
        return [ s.spine2d[half], dir( sub( s.spine2d[ Math.min( half + 1, s.n - 1 ) ], s.spine2d[half] ) ) ];
    }
    return [ s.spine2dAtT( item.t ), dir( s.tangent2dAtT( item.t ) ) ];
}

export function drawSameTilt( v: View2D, scene: Scene, a: SameTilt, color: RGB, widgets: Widgets, locked: Set<string> ): void {
    const size = 4 * 2 * v.lineWidth;
    for( const item of a.items ) {
        if( locked.has( item.shape ) ) continue;
        const f = markingFrame( scene, item );
        if( f ) v.image( tinted( widgets.same_angle, color ), f[0], f[1], size );
    }
}

export function drawSameLength( v: View2D, scene: Scene, a: SameLength, color: RGB, locked: Set<string> ): void {
    const kSize = 5 * 0.01;
    for( const item of a.items ) {
        if( locked.has( item.shape ) ) continue;
        const s = scene.shape( item.shape );
        const f = markingFrame( scene, { shape: item.shape } );
        if( !s || !f ) continue;
        const length = s.length3d();
        const [ c, n ] = f;
        const right: Vec2 = [ n[1], -n[0] ];
        const size = 3 * length * kSize;
        const thickness = 1.5 * length * 0.01;
        for( const off of [ -0.2, 0.2 ] ) {
            v.stroke( [ add( sub( c, scale( right, 0.4 * size ) ), scale( n, off * size ) ), add( add( c, scale( right, 0.4 * size ) ), scale( n, off * size ) ) ], rgba( color ), 2 * thickness );
        }
    }
}

export function drawSameScale( v: View2D, scene: Scene, a: SameScale, color: RGB, locked: Set<string> ): void {
    const kSize = Math.max( 0.04, 2.5 * 0.01 );
    for( const item of a.items ) {
        if( locked.has( item.shape ) ) continue;
        const s = scene.shape( item.shape );
        const f = markingFrame( scene, item );
        if( !s || !f ) continue;
        const radius = s instanceof Ellipsoid ? s.getRadius() : s.radii.get( item.t! );
        if( radius === undefined ) continue;
        const [ c, n ] = f;
        const right: Vec2 = [ n[1], -n[0] ];
        const size = 10 * radius * kSize;
        const thickness = 5 * radius * 0.01;
        const col = rgba( color );
        const l0 = add( c, scale( right, radius - 0.5 * size ) ), l1 = sub( c, scale( right, radius - 0.5 * size ) );
        v.stroke( [ l0, l1 ], col, 1.5 * thickness );
        v.stroke( [ add( sub( l0, scale( right, size ) ), scale( n, size ) ), l0, sub( sub( l0, scale( right, size ) ), scale( n, size ) ) ], col, 1.5 * thickness );
        v.stroke( [ add( add( l1, scale( right, size ) ), scale( n, size ) ), l1, sub( add( l1, scale( right, size ) ), scale( n, size ) ) ], col, 1.5 * thickness );
        for( const off of [ -0.2, 0.2 ] ) {
            v.stroke( [ add( sub( c, scale( n, 0.7 * size ) ), scale( right, off * size ) ), add( add( c, scale( n, 0.7 * size ) ), scale( right, off * size ) ) ], col, thickness );
        }
    }
}

export function drawMirror( v: View2D, scene: Scene, a: Mirror, color: RGB, locked: Set<string> ): void {
    if( locked.has( a.shape ) ) return;
    const o = originRelativeTo( scene, a.shape, a.parent );
    // An equals sign with a tilde above it.
    const s = 2.5 * v.lineWidth;
    const col = rgba( color );
    const w = 0.75 * v.lineWidth;
    v.stroke( [ [ o[0] - s, o[1] - 0.35 * s ], [ o[0] + s, o[1] - 0.35 * s ] ], col, w );
    v.stroke( [ [ o[0] - s, o[1] + 0.35 * s ], [ o[0] + s, o[1] + 0.35 * s ] ], col, w );
    const tilde: Vec2[] = [];
    for( let i = 0; i <= 16; ++i ) { const x = -1 + 2 * i / 16; tilde.push( [ o[0] + s * x, o[1] + 1.1 * s + 0.35 * s * Math.sin( Math.PI * x ) ] ); }
    v.stroke( tilde, col, w );
}

export function drawAlign( v: View2D, scene: Scene, a: Align, color: RGB, locked: Set<string> ): void {
    if( locked.has( a.shapes[0] ) || locked.has( a.shapes[1] ) ) return;
    const o1 = originRelativeTo( scene, a.shapes[0], a.parent );
    const o2 = originRelativeTo( scene, a.shapes[1], a.parent );
    const k = 1.5 * v.lineWidth;
    const outer = k + 0.75 * v.lineWidth;
    v.disk( o1, outer, rgba( color ) );
    v.disk( o2, outer, rgba( color ) );
    v.stroke( [ o1, o2 ], rgba( color ), 2 * v.lineWidth );
    const dark: RGB = [ color[0] >> 1, color[1] >> 1, color[2] >> 1 ];
    v.disk( o1, k, rgba( dark ) );
    v.disk( o2, k, rgba( dark ) );
}

// The displayed curves where connected shapes meet: their meshes' intersection after placing them
// in depth relative to each other (connection_curve_precise in the desktop app).
export function connectionCurves( scene: Scene, c: Connection ): Vec2[][] {
    const s0 = scene.shape( c.shapes[0] ), s1 = scene.shape( c.shapes[1] );
    if( !s0 || !s1 ) return [];
    // The depth offset of shape 1 relative to shape 0, as in placing connections in depth.
    const off = [ c.attachFront[0] ? 0 : 1, c.attachFront[1] ? 0 : 1 ];
    const edge = segLengths( c.curve );
    let weighted = 0, total = 0;
    c.curve.forEach( ( p, i ) => {
        const t0 = s0.rayTs( [ p[0], p[1], 0 ], [ 0, 0, -1 ] ).sort( ( a, b ) => a - b );
        const t1 = s1.rayTs( [ p[0], p[1], 0 ], [ 0, 0, -1 ] ).sort( ( a, b ) => a - b );
        if( t0.length <= off[0] || t1.length <= off[1] ) return;
        let w = ( i === 0 ? 0 : edge[i - 1] ) + ( i === edge.length ? 0 : edge[i] );
        if( edge.length === 0 ) w = 2;
        weighted += ( t1[off[1]] - t0[off[0]] ) * w;
        total += w;
    } );
    if( total === 0 ) return [];
    const dz = weighted / total;
    const m1 = s1.mesh.clone();
    for( const p of m1.vs ) p[2] += dz;
    return connectionIntersection( s0.mesh, m1, c.attachFront ).map( seg => [ to2( seg.a ), to2( seg.b ) ] );
}

export function drawConnection( v: View2D, curves: Vec2[][], c: Connection ): void {
    const darkening = ( 2 * Number( c.attachFront[0] ) + Number( c.attachFront[1] ) ) / 3;
    const color: RGB = Colors.connection.map( x => Math.round( darkening * x ) ) as RGB;
    const col = rgba( color, 200 / 255 );
    const W = 2 * v.lineWidth;
    if( curves.length === 0 ) {
        if( c.curve.length === 1 ) v.disk( c.curve[0], 0.5 * W, col );
        else v.stroke( c.curve, col, W );
        return;
    }
    v.ctx.beginPath();
    for( const seg of curves ) { v.ctx.moveTo( seg[0][0], seg[0][1] ); v.ctx.lineTo( seg[1][0], seg[1][1] ); }
    v.ctx.strokeStyle = col;
    v.ctx.lineWidth = W;
    v.ctx.stroke();
}

export function drawAnnotations( v: View2D, scene: Scene, types: Set<Annotation['type']>, widgets: Widgets, locked: Set<string>, connectionCurveCache: Map<Connection, Vec2[][]> ): void {
    scene.annotations.forEach( ( a, index ) => {
        if( !types.has( a.type ) ) return;
        const color = groupColor( index );
        try {
            switch( a.type ) {
                case 'connection':
                    if( a.shapes.some( s => locked.has( s ) ) ) return;
                    if( !connectionCurveCache.has( a ) ) connectionCurveCache.set( a, connectionCurves( scene, a ) );
                    drawConnection( v, connectionCurveCache.get( a )!, a );
                    break;
                case 'sameTilt': drawSameTilt( v, scene, a, color, widgets, locked ); break;
                case 'sameScale': drawSameScale( v, scene, a, color, locked ); break;
                case 'sameLength': drawSameLength( v, scene, a, color, locked ); break;
                case 'mirror': drawMirror( v, scene, a, color, locked ); break;
                case 'align': drawAlign( v, scene, a, color, locked ); break;
            }
        } catch( e ) {
            // A malformed annotation shouldn't prevent drawing the rest.
            console.warn( 'Failed to draw annotation', a, e );
        }
    } );
}
