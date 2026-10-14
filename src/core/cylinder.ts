// The generalized cylinder primitive (paper Section 4.1 and 5.1).  Ports annotations_sweep.SweepShape.

import { TriMesh, rayMeshTs } from './mesh';
import {
    t2edgeIndex, t2vertexIndex, solveSpine3d, makeDiffuser, Diffuser, tiltRadiansToTangent3d,
} from './spine';
import {
    pathAndRadiiWithCaps, meshFromSweepCirclesNoPinch, meshFromSweepCircles, meshFromSweepCrossSections,
    smoothOrthogonalVectors, Caps, CrossSection, Frame, linspace,
} from './sweepSurface';
import {
    Vec, Vec2, Vec3, Plane, add, sub, scale, dot, mag2, dir, cross, lineStripLength,
    tangentsAndNormals, rotationMatrix, axisAngleRotation, matVec, reflectPointAcrossPlane, to3,
} from './vec';

export const kMinRadius = 0.01;
export const kCrossSectionSamples = 21;
// Whether to use the smoothed distance field to avoid pinching (annotations_sweep.kNoPinch).
export let kNoPinch = true;
export function setNoPinch( noPinch: boolean ): void { kNoPinch = noPinch; }

export const unitCircle: Vec2[] = linspace( 0, 2 * Math.PI, kCrossSectionSamples + 1 ).slice( 0, -1 )
    .map( theta => [ Math.cos( theta ), Math.sin( theta ) ] as Vec2 );

// A sparse attribute along the spine: ( t, value ) pairs in insertion order, keyed by exact t.
export class TMap<T> {
    constructor( public entries: [ number, T ][] = [] ) {}
    has( t: number ): boolean { return this.entries.some( e => e[0] === t ); }
    get( t: number ): T | undefined { return this.entries.find( e => e[0] === t )?.[1]; }
    set( t: number, v: T ): void {
        const e = this.entries.find( e => e[0] === t );
        if( e ) e[1] = v;
        else this.entries.push( [ t, v ] );
    }
    delete( t: number ): void { this.entries = this.entries.filter( e => e[0] !== t ); }
    keys(): number[] { return this.entries.map( e => e[0] ); }
    get size(): number { return this.entries.length; }
    clone( copyValue: ( v: T ) => T = v => v ): TMap<T> {
        return new TMap( this.entries.map( ( [ t, v ] ) => [ t, copyValue( v ) ] ) );
    }
    // Returns a new map with every t replaced by tMap( t ).
    remap( tMap: ( t: number ) => number ): TMap<T> {
        return new TMap( this.entries.map( ( [ t, v ] ) => [ tMap( t ), v ] ) );
    }
}

export interface CylinderData {
    id: string;
    type: 'cylinder';
    spine: Vec2[];
    tilts: [ number, number ][];
    radii: [ number, number ][];
    symmetry: [ number, number ][];
    crossSections: [ number, Vec2[] ][];
    capRadii: [ number | null, number | null ];
}

// The kinds of edits, which determine which cached geometry is invalidated.
export type CylinderChange = 'spine' | 'tilts' | 'radii' | 'crossSections' | 'symmetry' | 'caps';

export class Cylinder {
    readonly type = 'cylinder';
    spine2d: Vec2[];
    tilts: TMap<number>;
    radii: TMap<number>;
    symmetry: TMap<number>;
    crossSections: TMap<Vec2[]>;
    capRadii: [ number | null, number | null ];

    // Cached, generated geometry.
    private _spine3d: Vec3[] | null = null;
    private _diffuser: Diffuser | null = null;
    private _denseRadii: number[] | null = null;
    private _denseCrossSections: Vec2[][] | null = null;
    private _symmetryDirections: Vec3[] | null = null;
    private _mesh: TriMesh | null = null;
    private _boundary2d: Vec2[] | null = null;

    constructor( public id: string, data: Omit<CylinderData, 'id' | 'type'> ) {
        this.spine2d = data.spine.map( p => [ p[0], p[1] ] as Vec2 );
        this.tilts = new TMap( data.tilts.map( ( [ t, v ] ) => [ t, v ] ) );
        this.radii = new TMap( data.radii.map( ( [ t, v ] ) => [ t, v ] ) );
        this.symmetry = new TMap( data.symmetry.map( ( [ t, v ] ) => [ t, v ] ) );
        this.crossSections = new TMap( data.crossSections.map( ( [ t, v ] ) => [ t, v.map( p => [ p[0], p[1] ] as Vec2 ) ] ) );
        this.capRadii = [ data.capRadii[0], data.capRadii[1] ];
    }

    toData(): CylinderData {
        return {
            id: this.id,
            type: 'cylinder',
            spine: this.spine2d.map( p => [ p[0], p[1] ] ),
            tilts: this.tilts.entries.map( ( [ t, v ] ) => [ t, v ] ),
            radii: this.radii.entries.map( ( [ t, v ] ) => [ t, v ] ),
            symmetry: this.symmetry.entries.map( ( [ t, v ] ) => [ t, v ] ),
            crossSections: this.crossSections.entries.map( ( [ t, v ] ) => [ t, v.map( p => [ p[0], p[1] ] ) ] ),
            capRadii: [ this.capRadii[0], this.capRadii[1] ],
        };
    }

    // A copy of the user-specified data, without any cached geometry.
    clone(): Cylinder { return new Cylinder( this.id, this.toData() ); }

    // Invalidates cached geometry that depends on the given kind of change.
    changed( what: CylinderChange ): void {
        switch( what ) {
            case 'spine':
            case 'tilts':
                this._spine3d = null;
                this._diffuser = null;
                this._denseRadii = null;
                this._denseCrossSections = null;
                this._symmetryDirections = null;
                this._mesh = null;
                this._boundary2d = null;
                break;
            case 'radii':
                this._denseRadii = null;
                this._mesh = null;
                this._boundary2d = null;
                break;
            case 'crossSections':
                this._denseCrossSections = null;
                this._mesh = null;
                break;
            case 'symmetry':
                this._symmetryDirections = null;
                this._mesh = null;
                break;
            case 'caps':
                this._mesh = null;
                this._boundary2d = null;
                break;
        }
    }

    get n(): number { return this.spine2d.length; }
    edgeIndexAtT( t: number ): number { return t2edgeIndex( t, this.n ); }
    vertexIndexAtT( t: number ): number { return t2vertexIndex( t, this.n ); }

    get spine3d(): Vec3[] {
        if( !this._spine3d ) this._spine3d = solveSpine3d( this.spine2d, this.tilts.entries );
        return this._spine3d;
    }

    get diffuser(): Diffuser {
        if( !this._diffuser ) this._diffuser = makeDiffuser( this.spine3d );
        return this._diffuser;
    }

    get denseRadii(): number[] {
        if( !this._denseRadii ) {
            const constraints: [ number, number[] ][] = this.radii.entries.map( ( [ t, r ] ) => [ this.edgeIndexAtT( t ), [ r ] ] );
            this._denseRadii = this.diffuser( constraints ).map( ( [ r ] ) => Math.max( kMinRadius, r ) );
        }
        return this._denseRadii;
    }

    // Cross section loops (normalized, kCrossSectionSamples points each) at every spine vertex,
    // or an empty array if the cylinder has only circular cross sections.
    get denseCrossSections(): Vec2[][] {
        if( !this._denseCrossSections ) {
            if( this.crossSections.size === 0 ) {
                this._denseCrossSections = [];
            } else {
                // Following gen_dense_cross_sections(), including its quirks: a Map, like a Python dict,
                // keeps a key's original position when it is assigned again.
                const sparse = new Map<number, number[]>();
                for( const [ t, xs ] of this.crossSections.entries ) sparse.set( this.edgeIndexAtT( t ), xs.flat() );
                // Duplicate cross sections at a neighboring vertex, so they have zero gradient.
                const extra: [ number, number[] ][] = [];
                for( const [ edgeIndex, xs ] of sparse ) {
                    if( !sparse.has( edgeIndex + 1 ) ) extra.push( [ edgeIndex + 1, xs ] );
                    else if( !sparse.has( edgeIndex - 1 ) ) extra.push( [ edgeIndex - 1, xs ] );
                }
                // Python's negative indexing.
                const constraints = [ ...sparse.entries(), ...extra ].map( ( [ i, xs ] ) => [ i < 0 ? i + this.n : i, xs ] as [ number, number[] ] );
                this._denseCrossSections = this.diffuser( constraints ).map( flat => {
                    const loop: Vec2[] = [];
                    for( let k = 0; k < kCrossSectionSamples; ++k ) loop.push( [ flat[ 2 * k ], flat[ 2 * k + 1 ] ] );
                    return loop;
                } );
            }
        }
        return this._denseCrossSections;
    }

    // get_frame_components(): ( ups, normals, tangents ) at each spine vertex.
    frameComponents(): [ Vec3[], Vec3[], Vec3[] ] {
        const [ tangents, normals ] = tangentsAndNormals( this.spine3d );
        const planar = normals.map( v => dir( [ v[0], v[1], 0 ] as Vec3 ) );
        tangents.push( tangents[ tangents.length - 1 ] );
        planar.push( planar[ planar.length - 1 ] );
        const ups = planar.map( ( v, i ) => cross( v, tangents[i] ) );
        return [ ups, planar, tangents ];
    }

    // The symmetry sheet's direction at each spine vertex.
    get symmetryDirections(): Vec3[] {
        if( !this._symmetryDirections ) {
            const [ ups, normals, tangents ] = this.frameComponents();
            const frames: Frame[] = ups.map( ( u, i ) => [ u, normals[i], tangents[i] ] );
            const sparse: [ number, Vec3 ][] = this.symmetry.entries.map( ( [ t, theta ] ) => {
                const e = this.edgeIndexAtT( t );
                return [ e, add( scale( ups[e], Math.cos( theta ) ), scale( normals[e], Math.sin( theta ) ) ) ];
            } );
            this._symmetryDirections = smoothOrthogonalVectors( frames, sparse, this.diffuser );
        }
        return this._symmetryDirections;
    }

    caps(): Caps {
        return [
            this.capRadii[0] === null ? [ 'spherical' ] : [ 'fixed', this.capRadii[0] ],
            this.capRadii[1] === null ? [ 'spherical' ] : [ 'fixed', this.capRadii[1] ],
        ];
    }

    get mesh(): TriMesh {
        if( !this._mesh ) {
            if( this.crossSections.size === 0 ) {
                this._mesh = kNoPinch
                    ? meshFromSweepCirclesNoPinch( this.spine3d, this.denseRadii, this.caps() )
                    : meshFromSweepCircles( this.spine3d, this.denseRadii, this.caps() );
            } else {
                const radii = this.denseRadii;
                const symmetry = this.symmetryDirections;
                const sections: CrossSection[] = this.denseCrossSections.map( ( loop, i ) =>
                    [ symmetry[i], loop.map( p => scale( p, radii[i] ) ) ] );
                this._mesh = meshFromSweepCrossSections( this.spine3d, sections, this.caps(), kNoPinch );
            }
        }
        return this._mesh;
    }

    // The 2d outline: the spine offset by the radii, with end caps (gen_offset_boundary2d()).
    get boundary2d(): Vec2[] {
        if( !this._boundary2d ) {
            const ext = pathAndRadiiWithCaps( this.spine2d.map( p => to3( p ) ), this.denseRadii, this.caps(), 10 );
            const spine = ext.path.map( p => [ p[0], p[1] ] as Vec2 );
            const [ , normals ] = tangentsAndNormals( spine );
            normals.push( normals[ normals.length - 1 ] );
            const right = spine.map( ( p, i ) => add( p, scale( normals[i], ext.radii[i] ) ) );
            const left = spine.map( ( p, i ) => sub( p, scale( normals[i], ext.radii[i] ) ) ).reverse();
            this._boundary2d = [ ...right, [ ext.endCapPt[0], ext.endCapPt[1] ], ...left, [ ext.startCapPt[0], ext.startCapPt[1] ] ];
        }
        return this._boundary2d;
    }

    // Translates the shape, including its cached 3d geometry (which preserves depth placement).
    translate( delta: Vec ): void {
        const d3 = to3( delta );
        // Generate the cached geometry first, as the original does by accessing it.
        const mesh = this.mesh;
        const spine3d = this.spine3d;
        const boundary2d = this.boundary2d;
        for( const p of this.spine2d ) { p[0] += d3[0]; p[1] += d3[1]; }
        mesh.translate( d3 );
        for( const p of spine3d ) { p[0] += d3[0]; p[1] += d3[1]; p[2] += d3[2]; }
        for( const p of boundary2d ) { p[0] += d3[0]; p[1] += d3[1]; }
    }

    // Translates the shape's 3d geometry by 'zOffset' along the view direction (0,0,-1).
    offsetInDepth( zOffset: number ): void {
        const mesh = this.mesh;
        for( const v of mesh.vs ) v[2] -= zOffset;
        for( const p of this.spine3d ) p[2] -= zOffset;
    }

    // The t's along the line orig + t*d at which it crosses the surface.
    rayTs( orig: Vec3, d: Vec3 ): number[] { return rayMeshTs( this.mesh, orig, d ); }

    candidateOrigins(): Vec3[] {
        const s = this.spine3d;
        return [ s[0], s[ s.length - 1 ], s[ Math.floor( s.length / 2 ) ] ];
    }
    center(): Vec3 { const s = this.spine3d; return s[ Math.floor( s.length / 2 ) ]; }
    length3d(): number { return lineStripLength( this.spine3d ); }

    // set_length3d(): scales the shape about 'origin' so that its 3d spine has the given length.
    setLength3d( length: number, origin: Vec3 ): void {
        const s = length / this.length3d();
        const old0 = this.spine3d[0];
        const spine3d0: Vec3 = add( scale( sub( old0, origin ), s ), origin );
        this.spine2d = this.spine2d.map( p => [ s * ( p[0] - origin[0] ) + origin[0], s * ( p[1] - origin[1] ) + origin[1] ] );
        this.changed( 'spine' );
        // Scaling the 2d spine scales the 3d spine by the same factor, but the depth solve fixes the
        // first point at z = 0, so restore its depth.
        this.offsetInDepth( this.spine3d[0][2] - spine3d0[2] );
    }

    // symmetry_plane_tangent_plane_at_vertex_index()
    symmetryPlaneAtVertex( index: number ): Plane {
        const s = this.spine3d;
        const dirs = this.symmetryDirections;
        const e = Math.min( s.length - 2, index );
        const tangent = sub( s[e + 1], s[e] );
        return [ s[index], cross( tangent, dirs[index] ) ];
    }

    // mirror_plane(): the tangent plane of the symmetry sheet nearest the 3d point 'pt'.
    mirrorPlane( pt: Vec3 ): Plane {
        const s = this.spine3d;
        const tangents: Vec3[] = s.map( ( _, i ) => i + 1 < s.length ? sub( s[i + 1], s[i] ) : [ 0, 0, 0 ] );
        tangents[ s.length - 1 ] = tangents[ s.length - 2 ];

        const distsqrs: number[] = [];
        const xs = this.denseCrossSections;
        if( xs.length > 0 ) {
            for( let i = 0; i < s.length; ++i ) {
                const R = rotationMatrix( ...axisAngleRotation( tangents[i], [ 0, 0, 1 ] ) );
                const loop = xs[i].map( p => add( matVec( R, [ p[0], p[1], 0 ] ), s[i] ) );
                distsqrs.push( closestDistSqrOnLineLoop( loop, pt ) );
            }
        } else {
            const radii = this.denseRadii;
            for( let i = 0; i < s.length; ++i ) {
                const R = rotationMatrix( ...axisAngleRotation( [ 0, 0, 1 ], tangents[i] ) );
                const Rspine = matVec( R, s[i] );
                const Rpt = matVec( R, pt );
                // The 2d point-to-circle distance^2 plus the difference^2 of z components.
                const d: Vec2 = [ Rspine[0] - Rpt[0], Rspine[1] - Rpt[1] ];
                distsqrs.push( Math.abs( dot( d, d ) - radii[i] ** 2 ) + ( Rspine[2] - Rpt[2] ) ** 2 );
            }
        }
        let best = 0;
        for( let i = 1; i < distsqrs.length; ++i ) if( distsqrs[i] < distsqrs[best] ) best = i;
        return this.symmetryPlaneAtVertex( best );
    }

    mirrorPoint( pt: Vec3 ): Vec3 { return reflectPointAcrossPlane( pt, this.mirrorPlane( pt ) ); }

    // UI helpers.
    tangent2dAtT( t: number ): Vec2 {
        const e = this.edgeIndexAtT( t );
        return sub( this.spine2d[e + 1], this.spine2d[e] );
    }
    tangent3dAtT( t: number ): Vec3 {
        const tilt = this.tilts.get( t );
        if( tilt !== undefined ) return tiltRadiansToTangent3d( tilt, this.tangent2dAtT( t ) );
        const e = this.edgeIndexAtT( t );
        return sub( this.spine3d[e + 1], this.spine3d[e] );
    }
    radiusAtT( t: number ): number {
        const r = this.radii.get( t );
        if( r !== undefined ) return r;
        return this.denseRadii[ this.vertexIndexAtT( t ) ];
    }
    spine2dAtT( t: number ): Vec2 { return this.spine2d[ this.vertexIndexAtT( t ) ]; }
    spine3dAtT( t: number ): Vec3 { return this.spine3d[ this.vertexIndexAtT( t ) ]; }
    capRadiusAt( end: 0 | 1 ): number { return this.capRadii[ end ] ?? this.radiusAtT( end ); }
    allParticularTs(): number[] {
        return [ ...new Set( [ ...this.tilts.keys(), ...this.radii.keys(), ...this.crossSections.keys(), ...this.symmetry.keys() ] ) ];
    }
}

// closest_distsqr_and_point_and_edge_index_on_line_loop_to_point()[0]
function closestDistSqrOnLineLoop( loop: Vec3[], pt: Vec3 ): number {
    let best = Infinity;
    for( let i = 0; i < loop.length; ++i ) {
        const a = loop[i], b = loop[ ( i + 1 ) % loop.length ];
        const ab = sub( b, a );
        const len2 = mag2( ab );
        const t = len2 > 0 ? Math.max( 0, Math.min( 1, dot( sub( pt, a ), ab ) / len2 ) ) : 0;
        const closest = add( a, scale( ab, t ) );
        best = Math.min( best, mag2( sub( pt, closest ) ) );
    }
    return best;
}
