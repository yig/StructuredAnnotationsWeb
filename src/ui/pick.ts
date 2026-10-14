// Picking primitives' parts and handles under the mouse.
// Ports wx_annotate_collection.PickSweepShapeHandle() and wx_annotate_sphere.PickAnnotationHandleZ().

import { Cylinder } from '../core/cylinder';
import { Ellipsoid } from '../core/ellipsoid';
import { Shape } from '../core/scene';
import { closestOnLineStrip, contourContains } from '../core/curves';
import { boundaryPerpendicular, crossSectionLoop3d, tiltDirection, EllipsoidHandle } from '../core/edit';
import { edgeIndex2t } from '../core/spine';
import { Vec2, Vec3, add, sub, scale, dir, mag2, dot, to2 } from '../core/vec';

// Parts of a cylinder, in increasing order of specificity (the most specific picked part wins).
export enum Part {
    BoundaryInterior = 0,
    CrossSectionInterior = 1,
    CrossSection = 2,
    Boundary = 3,
    SymmetryPlane = 4,
    Spine = 5,
    Diameter = 6,
    CrossSectionTiltHandle = 7,
    RadiusHandle = 8,
    CapRadiusHandle = 9,
    SymmetryPlaneHandle = 10,
}

export interface CylinderPick {
    part: Part;
    // The spine parameter of the picked attribute (for handles, cross sections, and the spine).
    t?: number;
    // For radius handles, whether the right-turn side was picked.
    rightTurn?: boolean;
}

export interface Thresholds {
    // World-space distances within which points and edges are picked.
    point: number;
    edge: number;
}

export function symmetryHandlePos( shape: Cylinder, t: number ): Vec3 {
    const vi = shape.vertexIndexAtT( t );
    return add( shape.spine3d[vi], scale( dir( shape.symmetryDirections[vi] ), shape.radiusAtT( t ) ) );
}

export function capHandlePos( shape: Cylinder, end: 0 | 1 ): Vec2 {
    const pos = shape.spine2dAtT( end );
    const tangent = dir( shape.tangent2dAtT( end ) );
    return add( pos, scale( tangent, shape.capRadiusAt( end ) * ( end === 0 ? -1 : 1 ) ) );
}

export function tiltHandlePos( shape: Cylinder, t: number ): Vec3 {
    const c = shape.spine2dAtT( t );
    return add( [ c[0], c[1], 0 ], scale( tiltDirection( shape, t ), shape.radiusAtT( t ) ) );
}

export function diameterSegment( shape: Cylinder, t: number ): [ Vec2, Vec2 ] {
    const c = shape.spine2dAtT( t );
    const tan = shape.tangent2dAtT( t );
    const normal = dir( [ tan[1], -tan[0] ] as Vec2 );
    const r = shape.radiusAtT( t );
    return [ add( c, scale( normal, r ) ), sub( c, scale( normal, r ) ) ];
}

// PickSweepShapeHandle(): the picked part of 'shape' at 2d world position 'p', or null.
export function pickCylinder( shape: Cylinder, p: Vec2, th: Thresholds, parts?: Part[] ): CylinderPick | null {
    const want = ( part: Part ) => !parts || parts.includes( part );
    const near = ( q: Vec2, r: number ) => mag2( sub( p, q ) ) < r * r;

    if( want( Part.SymmetryPlaneHandle ) ) {
        for( const t of shape.symmetry.keys() ) if( near( to2( symmetryHandlePos( shape, t ) ), th.point ) ) return { part: Part.SymmetryPlaneHandle, t };
    }
    if( want( Part.CapRadiusHandle ) ) {
        for( const end of [ 0, 1 ] as const ) if( near( capHandlePos( shape, end ), th.point ) ) return { part: Part.CapRadiusHandle, t: end };
    }
    if( want( Part.RadiusHandle ) ) {
        for( const t of shape.radii.keys() ) {
            const [ b1, b2 ] = boundaryPerpendicular( shape, t );
            if( near( b1, th.point ) ) return { part: Part.RadiusHandle, t, rightTurn: true };
            if( near( b2, th.point ) ) return { part: Part.RadiusHandle, t, rightTurn: false };
        }
    }
    if( want( Part.CrossSectionTiltHandle ) ) {
        for( const t of shape.tilts.keys() ) if( near( to2( tiltHandlePos( shape, t ) ), th.point ) ) return { part: Part.CrossSectionTiltHandle, t };
    }
    if( want( Part.Diameter ) ) {
        for( const t of shape.radii.keys() ) {
            if( closestOnLineStrip( diameterSegment( shape, t ), p ).distSqr < th.edge ** 2 ) return { part: Part.Diameter, t };
        }
    }
    if( want( Part.Spine ) ) {
        const c = closestOnLineStrip( shape.spine2d, p );
        if( c.distSqr < th.edge ** 2 ) return { part: Part.Spine, t: edgeIndex2t( c.edgeIndex, shape.n ) };
    }
    if( want( Part.Boundary ) ) {
        if( closestOnLineStrip( shape.boundary2d, p, true ).distSqr < th.edge ** 2 ) return { part: Part.Boundary };
    }
    if( want( Part.CrossSection ) ) {
        for( const t of [ ...shape.tilts.keys(), ...shape.crossSections.keys() ] ) {
            const loop = crossSectionLoop3d( shape, t ).map( to2 );
            if( closestOnLineStrip( loop, p, true ).distSqr < th.edge ** 2 ) return { part: Part.CrossSection, t };
        }
    }
    if( want( Part.CrossSectionInterior ) ) {
        for( const t of [ ...shape.tilts.keys(), ...shape.radii.keys(), ...shape.crossSections.keys() ] ) {
            // The vertical line through p intersects the cross section's plane inside the circle?
            const center = shape.spine3dAtT( t );
            const normal = shape.tangent3dAtT( t );
            if( Math.abs( normal[2] ) < 1e-12 ) continue;
            const z = center[2] - ( normal[0] * ( p[0] - center[0] ) + normal[1] * ( p[1] - center[1] ) ) / normal[2];
            if( mag2( sub( center, [ p[0], p[1], z ] ) ) <= shape.radiusAtT( t ) ** 2 ) return { part: Part.CrossSectionInterior, t };
        }
    }
    if( want( Part.BoundaryInterior ) ) {
        if( contourContains( shape.boundary2d, p ) ) return { part: Part.BoundaryInterior };
    }
    return null;
}

// PickAnnotationHandleZ(): the picked ellipsoid handle (the one closest to the viewer), or null.
// With 'pointRadius' 0, only the whole ellipsoid ('move') can be picked.
export function pickEllipsoid( e: Ellipsoid, p: Vec2, pointRadius: number ): { handle: EllipsoidHandle, z: number } | null {
    const candidates: { handle: EllipsoidHandle, z: number }[] = [];
    for( const handle of [ 'axis0+', 'axis0-', 'axis1+', 'axis1-', 'tilt' ] as const ) {
        const pos = e.handlePoint( handle );
        // Axis 0 handles behind the center are hidden.
        if( ( handle === 'axis0+' || handle === 'axis0-' ) && pos[2] + 1e-5 < e.center[2] ) continue;
        if( mag2( sub( p, to2( pos ) ) ) > pointRadius * pointRadius ) continue;
        candidates.push( { handle, z: pos[2] } );
    }
    if( candidates.length > 0 ) return candidates.reduce( ( a, b ) => b.z > a.z ? b : a );
    const ts = e.rayTs( [ p[0], p[1], 0 ], [ 0, 0, -1 ] );
    if( ts.length > 0 ) return { handle: 'move', z: -Math.min( ...ts ) };
    return null;
}

// The shapes whose surfaces the vertical line through 'p' crosses, with the nearest crossing's
// ray parameter, in list order (PickShapeSurfaces()).
export function pickSurfaces( shapes: Shape[], p: Vec2 ): { t: number, shape: Shape }[] {
    const result: { t: number, shape: Shape }[] = [];
    for( const shape of shapes ) {
        const ts = shape.rayTs( [ p[0], p[1], 0 ], [ 0, 0, -1 ] );
        if( ts.length > 0 ) result.push( { t: Math.min( ...ts ), shape } );
    }
    return result;
}

export function isFrontFacing( n: Vec3 ): boolean { return dot( n, [ 0, 0, 1 ] ) > 0; }
