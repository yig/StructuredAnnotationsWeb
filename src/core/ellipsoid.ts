// The ellipsoid primitive (paper Sections 4.1 and 5.1).  Ports annotations_ellipsoid.AnnotationData
// and ellipsoid.Ellipsoid.
//
// An ellipsoid has a 2d ellipse (center, two axes), used when drawing in 2d, and a 3d center and
// three orthogonal axes.  Axis 0 is the long axis; axes 1 and 2 have equal length and span the
// circular cross section, which the user tilts out of the image plane.

import { TriMesh, Face } from './mesh';
import { sphereVertices, sphereFaces } from './sphereMesh';
import { Vec2, Vec3, add, sub, scale, dot, mag, mag2, dir, cross, projectPointToPlane, Plane, kEps } from './vec';
import { LU, Matrix } from './linalg';

export interface EllipsoidData {
    id: string;
    type: 'ellipsoid';
    ellipse: [ Vec2, Vec2, Vec2 ];
    center: Vec3;
    axes: [ Vec3, Vec3, Vec3 ];
}

export class Ellipsoid {
    readonly type = 'ellipsoid';
    ellipse: [ Vec2, Vec2, Vec2 ];
    center: Vec3;
    axes: [ Vec3, Vec3, Vec3 ];

    constructor( public id: string, data: Omit<EllipsoidData, 'id' | 'type'> ) {
        this.ellipse = data.ellipse.map( p => [ p[0], p[1] ] as Vec2 ) as [ Vec2, Vec2, Vec2 ];
        this.center = [ ...data.center ] as Vec3;
        this.axes = data.axes.map( a => [ ...a ] as Vec3 ) as [ Vec3, Vec3, Vec3 ];
    }

    // SetCircle(): creates an ellipsoid from a 2d ellipse ( center, axis a, axis b ) lying in the image plane.
    static fromEllipse( id: string, ellipse: [ Vec2, Vec2, Vec2 ] ): Ellipsoid {
        const [ c, a, b ] = ellipse;
        const axis0: Vec3 = [ a[0], a[1], 0 ];
        const axis1: Vec3 = [ b[0], b[1], 0 ];
        const axis2 = scale( dir( cross( axis0, axis1 ) ), Math.min( mag( a ), mag( b ) ) );
        return new Ellipsoid( id, { ellipse: [ c, a, b ], center: [ c[0], c[1], 0 ], axes: [ axis0, axis1, axis2 ] } );
    }

    toData(): EllipsoidData {
        return {
            id: this.id,
            type: 'ellipsoid',
            ellipse: this.ellipse.map( p => [ p[0], p[1] ] ) as [ Vec2, Vec2, Vec2 ],
            center: [ ...this.center ],
            axes: this.axes.map( a => [ ...a ] ) as [ Vec3, Vec3, Vec3 ],
        };
    }

    clone(): Ellipsoid { return new Ellipsoid( this.id, this.toData() ); }

    // The sphere mesh transformed by the axes and center.
    get mesh(): TriMesh {
        const [ a0, a1, a2 ] = this.axes;
        const vs = sphereVertices.map( v => [
            v[0] * a0[0] + v[1] * a1[0] + v[2] * a2[0] + this.center[0],
            v[0] * a0[1] + v[1] * a1[1] + v[2] * a2[1] + this.center[1],
            v[0] * a0[2] + v[1] * a1[2] + v[2] * a2[2] + this.center[2],
        ] as Vec3 );
        return new TriMesh( vs, sphereFaces.map( f => [ f[0], f[1], f[2] ] as Face ) );
    }

    // ray_ellipse_intersection_ts() with ray_is_line = True.
    rayTs( orig: Vec3, d: Vec3 ): number[] {
        // axes^T maps the unit sphere to the ellipsoid; invert it.
        const M = new Matrix( 3, 3 );
        for( let i = 0; i < 3; ++i ) for( let j = 0; j < 3; ++j ) M.set( i, j, this.axes[j][i] );
        const lu = new LU( M );
        const p = Array.from( lu.solve( sub( orig, this.center ) ) );
        const q = Array.from( lu.solve( d ) );
        // Intersect with the unit sphere.
        const c = scale( p, -1 );
        const qa = dot( q, q );
        const qb = -2 * dot( q, c );
        const qc = dot( c, c ) - 1;
        let qrad = qb * qb - 4 * qa * qc;
        if( qrad < 0 ) return [];
        qrad = Math.sqrt( Math.max( 0, qrad ) );
        return [ ( -qb + qrad ) / ( 2 * qa ), ( -qb - qrad ) / ( 2 * qa ) ];
    }

    // The tilt of the circular cross section: 0 means it is perpendicular to the image plane.
    getTilt(): number {
        const n = dir( this.axes[0] );
        return -Math.atan( n[2] / mag( [ n[0], n[1] ] ) );
    }

    setTilt( radians: number ): void {
        const x = Math.sin( radians ) * mag( this.axes[2] );
        // Ellipsoids' orientations flip so that axes[2] always points in positive z,
        // so multiply by the negative sign of axes[0].z.
        const neg = this.axes[0][2] < 0 ? 1 : -1;
        const d = dir( [ this.axes[2][0], this.axes[2][1] ] as Vec2 );
        this.setCrossSectionFromPoint( 1, [ this.center[0] + x * neg * d[0], this.center[1] + x * neg * d[1] ] );
    }

    getRadius(): number { return mag( this.axes[1] ); }
    setRadius( radius: number ): void {
        const s = radius / mag( this.axes[1] );
        this.axes[1] = scale( this.axes[1], s );
        this.axes[2] = scale( this.axes[2], s );
    }

    length3d(): number { return 2 * mag( this.axes[0] ); }
    setLength3d( length: number, origin: Vec3 ): void {
        const s = length / ( 2 * mag( this.axes[0] ) );
        this.axes[0] = scale( this.axes[0], s );
        this.center = add( scale( sub( this.center, origin ), s ), origin );
        const [ c, a, b ] = this.ellipse;
        this.ellipse = [ [ s * ( c[0] - origin[0] ) + origin[0], s * ( c[1] - origin[1] ) + origin[1] ], scale( a, s ), b ];
    }

    candidateOrigins(): Vec3[] { return [ this.center ]; }

    translate( offset: number[] ): void {
        const o: Vec3 = [ offset[0], offset[1], offset.length > 2 ? offset[2] : 0 ];
        this.center = add( this.center, o );
        this.ellipse[0] = [ this.ellipse[0][0] + o[0], this.ellipse[0][1] + o[1] ];
    }

    offsetInDepth( zOffset: number ): void {
        this.center = [ this.center[0], this.center[1], this.center[2] - zOffset ];
    }

    // The symmetry plane passes through the center, perpendicular to the long axis.
    mirrorPlane( _pt: Vec3 ): Plane { return [ this.center, this.axes[0] ]; }

    // SetCrossSectionFromStroke() for a single-point stroke: keeps axis 'whichAxis' in the image plane
    // with the same 2d length, and tilts axis 2 so that its tip projects (as nearly as possible) to
    // 'point', keeping the silhouette of the remaining axis unchanged.
    setCrossSectionFromPoint( whichAxis: 0 | 1, point: Vec2 ): void {
        const axes = this.axes;
        const oldAxes = axes.map( a => [ ...a ] as Vec3 );

        axes[whichAxis] = [ axes[whichAxis][0], axes[whichAxis][1], 0 ];
        const magWhich = mag( axes[whichAxis] );
        if( magWhich <= kEps ) return;

        // The closest point to 'point' on the plane perpendicular to axis 'whichAxis'.
        const perpExtremum = projectPointToPlane( [ point[0], point[1], 0 ], [ this.center, axes[whichAxis] ] );
        perpExtremum[2] = 2 * magWhich + this.center[2];
        axes[2] = sub( closestPointOnSphereToRay( this.center, magWhich, perpExtremum, [ 0, 0, -1 ] ), this.center );

        const kMinRiseCosAngle = Math.cos( Math.PI / 10 );
        if( mag( [ axes[2][0], axes[2][1] ] ) / mag( axes[2] ) > kMinRiseCosAngle ) {
            // Refuse to create an infinitely long (in depth) shape; clip to the maximum tilt.
            const xymag2 = axes[2][0] ** 2 + axes[2][1] ** 2;
            axes[2] = [ axes[2][0], axes[2][1], Math.sqrt( ( xymag2 - kMinRiseCosAngle ** 2 * xymag2 ) / kMinRiseCosAngle ** 2 ) ];
            axes[2] = scale( dir( axes[2] ), magWhich );
        }

        const otherAxis = whichAxis === 1 ? 0 : 1;
        const silhouette = xymagSilhouette( oldAxes, otherAxis );
        axes[otherAxis] = cross( axes[whichAxis], axes[2] );
        const xy = ( v: Vec3 ) => mag( [ v[0], v[1] ] );
        axes[otherAxis] = scale( axes[otherAxis], xymagForSilhouette( axes, otherAxis, silhouette ) / xy( axes[otherAxis] ) );

        // Update the 2d ellipse.
        const otherDir = dir( [ axes[otherAxis][0], axes[otherAxis][1] ] as Vec2 );
        this.ellipse = [
            [ this.center[0], this.center[1] ],
            [ axes[whichAxis][0], axes[whichAxis][1] ],
            scale( otherDir, silhouette ),
        ];
    }

    // Handle positions used by the UI.
    handlePoint( which: 'axis0+' | 'axis0-' | 'axis1+' | 'axis1-' | 'tilt' ): Vec3 {
        switch( which ) {
            case 'axis0+': return add( this.center, this.axes[0] );
            case 'axis0-': return sub( this.center, this.axes[0] );
            case 'axis1+': return add( this.center, this.axes[1] );
            case 'axis1-': return sub( this.center, this.axes[1] );
            case 'tilt': return add( this.center, this.axes[2] );
        }
    }
}

// The 2d extent of the ellipsoid's silhouette along axis 'which' (as seen along z).
function xymagSilhouette( axes: Vec3[], which: number ): number {
    const a0 = [ mag( [ axes[which][0], axes[which][1] ] ), axes[which][2] ];
    const a1 = [ mag( [ axes[2][0], axes[2][1] ] ), axes[2][2] ];
    const theta = Math.atan( a1[0] / a0[0] );
    return Math.cos( theta ) * a0[0] + Math.sin( theta ) * a1[0];
}

// Newton's method for the 2d length of axis 'which' whose silhouette extent is 'silhouette'.
function xymagForSilhouette( axes: Vec3[], which: number, silhouette: number ): number {
    const kStepTol = 1e-5, kMaxIter = 10;
    const b = mag( [ axes[2][0], axes[2][1] ] );
    let x = mag( [ axes[which][0], axes[which][1] ] );
    let dstep = 2 * kStepTol;
    for( let iter = 0; dstep > kStepTol && iter < kMaxIter; ++iter ) {
        const theta = Math.atan( b / x );
        const c = Math.cos( theta ), s = Math.sin( theta );
        const fx = c * x + s * b - silhouette;
        const chain = ( 1 / ( 1 + b * b / ( x * x ) ) ) * ( -b / ( x * x ) );
        const dfx = x * ( -s ) * chain + c + b * c * chain;
        dstep = Math.abs( fx / dfx );
        x = x - fx / dfx;
    }
    return x;
}

// vecutil.closest_point_on_sphere_to_ray() with ray_is_line = False: the intersection of the ray
// with the sphere nearest the ray origin, or the closest point on the sphere if they don't intersect.
function closestPointOnSphereToRay( center: Vec3, radius: number, rayPt: Vec3, rayDir: Vec3 ): Vec3 {
    const d = dir( rayDir );
    let toRay = sub( rayPt, center );
    toRay = sub( toRay, scale( d, dot( toRay, d ) ) );
    if( mag2( toRay ) > radius * radius ) return add( center, scale( dir( toRay ), radius ) );

    const c = sub( center, rayPt );
    const qa = dot( d, d ), qb = -2 * dot( d, c ), qc = dot( c, c ) - radius * radius;
    const qrad = Math.sqrt( Math.max( 0, qb * qb - 4 * qa * qc ) );
    const ts = [ ( -qb + qrad ) / ( 2 * qa ), ( -qb - qrad ) / ( 2 * qa ) ].filter( t => t >= 0 );
    let t = ts[0];
    for( const u of ts ) if( Math.abs( u ) < Math.abs( t ) ) t = u;
    return add( rayPt, scale( d, t ) );
}
