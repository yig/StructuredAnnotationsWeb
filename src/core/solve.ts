// Building the 3d model: applying annotations to the primitives (paper Section 5).
// Ports annotations_symbols.ApplyConstraints() and the code it calls.
//
// Annotations are applied in the paper's order: same-tilt, same-scale, connection curves
// (placement in depth), same-length, alignment, and mirroring.  Each operates on copies of the
// user's shapes, so the user's input (which matches the guide image) is never modified.

import { Cylinder } from './cylinder';
import { Ellipsoid } from './ellipsoid';
import { TriMesh, Face } from './mesh';
import { closestPointSatisfyingConstraints } from './linalg';
import { Scene, Shape, Connection, Annotation, SameTilt, SameScale, SameLength, Align, Mirror } from './scene';
import { Vec2, Vec3, add, sub, scale, dot, dir, cross, orthogonal, segLengths, average, projectPointToPlane, reflectPointAcrossPlane, Plane } from './vec';

export interface SolvedScene {
    // Solved copies of the scene's shapes, by id.
    shapes: Map<string, Shape>;
    // Meshes created by mirror annotations.
    mirrored: { source: string, mesh: TriMesh }[];
    // Problems encountered (e.g. annotations referring to missing shapes).
    warnings: string[];
}

const kViewDir: Vec3 = [ 0, 0, -1 ];

class Solver {
    readonly shapes = new Map<string, Shape>();
    readonly connections: Connection[];
    readonly annotations: Annotation[];
    readonly warnings: string[] = [];
    readonly mirrored: { source: string, mesh: TriMesh }[] = [];

    constructor( scene: Scene ) {
        for( const s of scene.shapes ) this.shapes.set( s.id, s.clone() );
        // Copy annotations, because connection curves are translated along with shapes.
        // (Don't remove invalid ones: same-length items refer to connections by index.)
        this.annotations = structuredClone( scene.annotations );
        this.invalid = new Set( this.annotations.filter( a => !this.refersToExistingShapes( a ) ) );
        this.connections = this.of<Connection>( 'connection' );
    }

    private readonly invalid: Set<Annotation>;

    private refersToExistingShapes( a: Annotation ): boolean {
        const ids: string[] =
            a.type === 'connection' ? a.shapes :
            a.type === 'align' ? [ ...a.shapes, a.parent ] :
            a.type === 'mirror' ? [ a.shape, a.parent ] :
            a.items.map( i => i.shape );
        const ok = ids.every( id => this.shapes.has( id ) );
        if( !ok ) this.warnings.push( `Ignoring a ${ a.type } annotation that refers to a missing shape.` );
        return ok;
    }

    shape( id: string ): Shape { return this.shapes.get( id )!; }

    // The valid annotations of the given type, in order.
    of<T extends Annotation>( type: T['type'] ): T[] {
        return this.annotations.filter( a => a.type === type && !this.invalid.has( a ) ) as T[];
    }

    run(): SolvedScene {
        for( const a of this.of<SameTilt>( 'sameTilt' ) ) this.applySameTilt( a );
        for( const a of this.of<SameScale>( 'sameScale' ) ) this.applySameScale( a );
        this.placeInDepth();
        for( const a of this.of<SameLength>( 'sameLength' ) ) this.applySameLength( a );
        for( const a of this.of<Align>( 'align' ) ) this.applyAlign( a );
        for( const a of this.of<Mirror>( 'mirror' ) ) this.applyMirror( a );
        return { shapes: this.shapes, mirrored: this.mirrored, warnings: this.warnings };
    }

    // Same-tilt: average the absolute tilts, keeping each one's sign.
    private applySameTilt( a: SameTilt ): void {
        const get = ( item: SameTilt['items'][number] ): number | undefined => {
            const s = this.shape( item.shape );
            if( s instanceof Ellipsoid ) return s.getTilt();
            return item.t === undefined ? undefined : s.tilts.get( item.t );
        };
        const set = ( item: SameTilt['items'][number], v: number ) => {
            const s = this.shape( item.shape );
            if( s instanceof Ellipsoid ) s.setTilt( v );
            else if( item.t !== undefined ) { s.tilts.set( item.t, v ); s.changed( 'tilts' ); }
        };
        const items = a.items.filter( i => get( i ) !== undefined );
        const toAverage = a.masters.length > 0 ? a.masters.map( i => a.items[i] ).filter( i => items.includes( i ) ) : items;
        let avg = 0;
        for( const i of toAverage ) avg += Math.abs( get( i )! );
        if( toAverage.length > 0 ) avg /= toAverage.length;
        for( const i of items ) set( i, avg * ( get( i )! < 0 ? -1 : 1 ) );
    }

    // Same-scale: set every cross section's radius to the average.
    private applySameScale( a: SameScale ): void {
        const items = a.items.filter( i => {
            const s = this.shape( i.shape );
            return s instanceof Cylinder && s.radii.has( i.t );
        } );
        const radius = ( i: SameScale['items'][number] ) => ( this.shape( i.shape ) as Cylinder ).radii.get( i.t )!;
        const toAverage = a.masters.length > 0 ? a.masters.map( i => a.items[i] ).filter( i => items.includes( i ) ) : items;
        let avg = 0;
        for( const i of toAverage ) avg += radius( i );
        if( toAverage.length > 0 ) avg /= toAverage.length;
        for( const i of items ) {
            const s = this.shape( i.shape ) as Cylinder;
            s.radii.set( i.t, avg );
            s.changed( 'radii' );
        }
    }

    // The sorted t's along the vertical line through 2d point 'pt' at which it crosses 'shape'.
    private depthTs( shape: Shape, pt: Vec2 ): number[] {
        return shape.rayTs( [ pt[0], pt[1], 0 ], kViewDir ).sort( ( a, b ) => a - b );
    }

    // wx_annotate_symmetry_xsection.PlaceInDepth(): translates shapes in depth so that connected
    // shapes meet along their connection curves, by depth-first search over the connection graph.
    private placeInDepth(): void {
        const frozen = new Set<string>();
        const allRegions = this.connections.flatMap( c => c.shapes );
        const region2connections = new Map<string, Connection[]>();
        for( const r of allRegions ) region2connections.set( r, [] );
        for( const c of this.connections ) for( const r of c.shapes ) region2connections.get( r )!.push( c );

        const dfs = ( region: string ) => {
            for( const c of region2connections.get( region )! ) {
                if( frozen.has( c.shapes[0] ) && frozen.has( c.shapes[1] ) ) continue;
                this.placeInDepthAccordingToConnection( c, frozen );
                dfs( c.shapes[0] === region ? c.shapes[1] : c.shapes[0] );
            }
        };
        for( const r of allRegions ) {
            if( !frozen.has( r ) ) {
                frozen.add( r );
                dfs( r );
            }
        }
    }

    // annotations_rotund.place_in_depth_according_to_connection(): translates the connection's
    // unfrozen shape in depth to minimize the (length-weighted) squared depth differences between
    // the two attached surfaces along the connection curve.
    private placeInDepthAccordingToConnection( c: Connection, frozen: Set<string> ): void {
        const freeIndex = frozen.has( c.shapes[0] ) ? 1 : 0;
        const fixedIndex = 1 - freeIndex;
        const free = this.shape( c.shapes[freeIndex] );
        const fixed = this.shape( c.shapes[fixedIndex] );
        const freeOff = c.attachFront[freeIndex] ? 0 : 1;
        const fixedOff = c.attachFront[fixedIndex] ? 0 : 1;

        const edgeLengths = segLengths( c.curve );
        let weighted = 0, totalWeight = 0, count = 0;
        c.curve.forEach( ( pt, i ) => {
            const freeTs = this.depthTs( free, pt );
            if( freeTs.length <= freeOff ) return;
            const fixedTs = this.depthTs( fixed, pt );
            if( fixedTs.length <= fixedOff ) return;
            // z = 0 + t * (-1)
            const zFree = -freeTs[freeOff];
            const zFixed = -fixedTs[fixedOff];
            let w = ( i === 0 ? 0 : edgeLengths[i - 1] ) + ( i === edgeLengths.length ? 0 : edgeLengths[i] );
            if( edgeLengths.length === 0 ) w = 2;
            weighted += ( zFree - zFixed ) * w;
            totalWeight += w;
            count += 1;
        } );
        const zOffset = count > 0 && totalWeight > 0 ? -weighted / totalWeight : 0;
        free.offsetInDepth( -zOffset );
        frozen.add( free.id );
    }

    // annotations_rotund.connection_frozen_com(): the weighted center of the connection curve
    // projected onto the surface of 'fixedId'.
    private connectionFrozenCom( c: Connection, fixedId: string ): Vec3 {
        const fixedIndex = c.shapes[0] === fixedId ? 0 : 1;
        const fixed = this.shape( fixedId );
        const off = c.attachFront[fixedIndex] ? 0 : 1;
        const edgeLengths = segLengths( c.curve );
        const pts: Vec3[] = [];
        const weights: number[] = [];
        c.curve.forEach( ( pt, i ) => {
            const ts = this.depthTs( fixed, pt );
            if( ts.length <= off ) return;
            pts.push( [ pt[0], pt[1], -ts[off] ] );
            let w = 0.5 * ( ( i === 0 ? 0 : edgeLengths[i - 1] ) + ( i === edgeLengths.length ? 0 : edgeLengths[i] ) );
            if( edgeLengths.length === 0 ) w = 1;
            weights.push( w );
        } );
        if( pts.length === 0 ) {
            this.warnings.push( "A connection curve doesn't intersect its shape." );
            const avg = average( c.curve );
            return [ avg[0], avg[1], 0 ];
        }
        return average( pts, weights );
    }

    // SizeManipSweepShape.get_origin(): the origin about which a shape is scaled or mirrored.
    // Without a parent connection, it's the shape's center; otherwise it is the candidate origin
    // (spine endpoints and midpoint, or ellipsoid center) closest in 2d to the connection.
    private origin( shapeId: string, parentConnection: Connection | null ): Vec3 {
        const s = this.shape( shapeId );
        if( parentConnection === null ) return [ ...( s instanceof Cylinder ? s.center() : s.center ) ] as Vec3;
        const parent = parentConnection.shapes[0] === shapeId ? parentConnection.shapes[1] : parentConnection.shapes[0];
        const com = this.connectionFrozenCom( parentConnection, parent );
        let best: Vec3 | null = null, bestD = Infinity;
        for( const pt of s.candidateOrigins() ) {
            const d = ( pt[0] - com[0] ) ** 2 + ( pt[1] - com[1] ) ** 2;
            // Python's min() over ( distance, point ) tuples breaks ties lexicographically.
            if( d < bestD || ( d === bestD && best && lexLess( pt, best ) ) ) { best = pt; bestD = d; }
        }
        return [ ...best! ] as Vec3;
    }

    private connectionBetween( a: string, b: string ): Connection | undefined {
        if( a === b ) return undefined;
        return this.connections.find( c => c.shapes.includes( a ) && c.shapes.includes( b ) );
    }

    // wx_annotate_collection.run_dfs() rooted at 'root' over 'connections': visits each reachable
    // shape once, with the connection it was reached through (null for the root).
    private dfs( connections: Connection[], root: string, visit: ( incoming: Connection | null, shape: string ) => void ): void {
        const visited = new Set<string>();
        const go = ( incoming: Connection | null, region: string ) => {
            if( visited.has( region ) ) return;
            visited.add( region );
            visit( incoming, region );
            for( const c of connections ) {
                if( !c.shapes.includes( region ) ) continue;
                for( const other of c.shapes ) if( other !== region ) go( c, other );
            }
        };
        go( null, root );
    }

    private translateShape( c: Connection | null, shapeId: string, offset: Vec3 ): void {
        if( c ) c.curve = c.curve.map( p => [ p[0] + offset[0], p[1] + offset[1] ] as Vec2 );
        this.shape( shapeId ).translate( offset );
    }

    // Translates a shape and its subtree (not crossing to 'parentId'), including connection curves.
    private translateRecursive( shapeId: string, parentId: string, offset: Vec3 ): void {
        const between = this.connectionBetween( shapeId, parentId );
        const cons = this.connections.filter( c => c !== between );
        this.dfs( cons, shapeId, ( c, s ) => this.translateShape( c, s, offset ) );
    }

    // Same-length: set every shape's 3d length to the average, scaling about each shape's origin
    // and translating attached shapes so they remain connected.
    private applySameLength( a: SameLength ): void {
        const size = ( id: string ) => this.shape( id ).length3d();
        const toAverage = a.masters.length > 0 ? a.masters.map( i => a.items[i] ) : a.items;
        let avg = 0;
        for( const i of toAverage ) avg += Math.abs( size( i.shape ) );
        if( toAverage.length > 0 ) avg /= toAverage.length;
        for( const item of a.items ) {
            const parentConnection = item.connection === null ? null : ( this.annotations[ item.connection ] as Connection );
            this.setSize( item.shape, parentConnection, avg );
        }
    }

    // SizeManipSweepShape.set_size()
    private setSize( shapeId: string, parentConnection: Connection | null, newSize: number ): void {
        const shape = this.shape( shapeId );
        const s = newSize / shape.length3d();
        const origin = this.origin( shapeId, parentConnection );

        const children: [ Connection, string ][] = [];
        const cons: Connection[] = [];
        for( const c of this.connections ) {
            if( c.shapes.includes( shapeId ) ) {
                const other = c.shapes[0] === shapeId ? c.shapes[1] : c.shapes[0];
                if( c !== parentConnection ) children.push( [ c, other ] );
            } else {
                cons.push( c );
            }
        }

        // Translate each child's subtree to follow the child's origin under the scaling.
        for( const [ toChild, child ] of children ) {
            const childOrigin = this.origin( child, toChild );
            const offset = add( sub( scale( sub( childOrigin, origin ), s ), childOrigin ), origin );
            toChild.curve = toChild.curve.map( p => [ p[0] + offset[0], p[1] + offset[1] ] as Vec2 );
            this.dfs( cons, child, ( c, n ) => this.translateShape( c, n, offset ) );
        }

        shape.setLength3d( newSize, origin );
    }

    private mirrorPlane( shapeId: string, pt: Vec3 ): Plane { return this.shape( shapeId ).mirrorPlane( pt ); }

    // MirrorManipSweepShape.origin()
    private originRelativeTo( shapeId: string, parentId: string ): Vec3 {
        return this.origin( shapeId, this.connectionBetween( shapeId, parentId ) ?? null );
    }

    // Alignment: one shape onto, or two shapes symmetrically across, the parent's symmetry sheet.
    private applyAlign( a: Align ): void {
        const [ s1, s2 ] = a.shapes;
        if( s1 === s2 ) {
            const origin = this.originRelativeTo( s1, a.parent );
            const plane = this.mirrorPlane( a.parent, origin );
            this.translateRecursive( s1, a.parent, sub( projectPointToPlane( origin, plane ), origin ) );
            return;
        }

        const o1 = this.originRelativeTo( s1, a.parent );
        const o2 = this.originRelativeTo( s2, a.parent );
        const p1 = this.mirrorPlane( a.parent, o1 );
        const p2 = this.mirrorPlane( a.parent, o2 );
        const plane: Plane = [ scale( add( p1[0], p2[0] ), 0.5 ), dir( add( p1[1], p2[1] ) ) ];

        // Find the smallest offsets such that the origins are reflections of each other across the plane.
        const n = plane[1];
        const ortho1 = orthogonal( n );
        const ortho2 = cross( n, ortho1 );
        const neg = ( v: Vec3 ) => v.map( x => -x );
        const x = closestPointSatisfyingConstraints(
            [ ...o1, ...o2 ],
            [ [ ...ortho1, ...neg( ortho1 ) ], [ ...ortho2, ...neg( ortho2 ) ], [ ...n, ...n ] ],
            [ 0, 0, 2 * dot( plane[0], n ) ],
        );
        this.translateRecursive( s1, a.parent, sub( x.slice( 0, 3 ) as Vec3, o1 ) );
        this.translateRecursive( s2, a.parent, sub( x.slice( 3, 6 ) as Vec3, o2 ) );
    }

    // Mirroring: a reflected copy of the shape and its subtree.
    private applyMirror( a: Mirror ): void {
        const origin = this.originRelativeTo( a.shape, a.parent );
        const originMirror = reflectPointAcrossPlane( origin, this.mirrorPlane( a.parent, origin ) );
        const o = scale( add( origin, originMirror ), 0.5 );
        const n = dir( sub( origin, originMirror ) );

        const mesh = new TriMesh();
        const between = this.connectionBetween( a.shape, a.parent );
        this.dfs( this.connections.filter( c => c !== between ), a.shape, ( _, s ) => mesh.append( this.shape( s ).mesh ) );
        mesh.vs = mesh.vs.map( v => {
            const d = 2 * dot( sub( v, o ), n );
            return sub( v, scale( n, d ) );
        } );
        // Reflection turns the mesh inside out; flip the faces.
        mesh.faces = mesh.faces.map( f => [ f[0], f[2], f[1] ] as Face );
        this.mirrored.push( { source: a.shape, mesh } );
    }
}

function lexLess( a: Vec3, b: Vec3 ): boolean {
    for( let i = 0; i < 3; ++i ) if( a[i] !== b[i] ) return a[i] < b[i];
    return false;
}

export function solveScene( scene: Scene ): SolvedScene {
    return new Solver( scene ).run();
}
