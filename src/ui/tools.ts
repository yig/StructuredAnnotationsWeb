// The interactive tools.  Ports the modes of wx_annotate_collection.py and illustrator_mode.py:
// Select (ArrowMode2, with its handle manipulators), Cylinder (DrawSweepShapeMode), Ellipsoid,
// Connect, Same Tilt/Length/Scale, Mirror, Align, Center, Pan, and Zoom.

import { Cylinder } from '../core/cylinder';
import { Ellipsoid } from '../core/ellipsoid';
import { Scene, Shape, Connection, SameTilt, SameScale, SameLength, Annotation } from '../core/scene';
import {
    setSpine2d, resampleSpine, smoothSpine, straightenSpine, cylinderFromStroke, boundaryPerpendicular,
    tiltFromPoint, tiltAt, symmetryFromPoint, symmetryAt, dragEllipsoidHandle, EllipsoidHandle,
    garbageCollect, removeShape, removeAnnotation, neighbors, connected, newId, crossSectionLoop3d, kSamplesPerUnitDistance,
} from '../core/edit';
import { closestOnLineStrip, laplacianCurveEdit, smoothOpenStroke, fitEllipse, oversketch } from '../core/curves';
import { edgeIndex2t, t2edgeIndex } from '../core/spine';
import { Vec2, add, sub, scale, dot, mag, dir, lineStripLength, to2 } from '../core/vec';
import { View2D, Colors, rgba } from './view2d';
import { Part, CylinderPick, pickCylinder, pickEllipsoid, pickSurfaces, diameterSegment } from './pick';
import { drawCylinderHandles, drawEllipsoidHandles, drawCylinderGuide, drawShapeGuide, Widgets } from './draw';

export interface ToolEvent {
    world: Vec2;
    // CSS pixels in the 2d view.
    screen: Vec2;
    shift: boolean;
    alt: boolean;
    // Command (macOS) or Control.
    mod: boolean;
}

export interface MenuItem {
    label?: string;
    action?: () => void;
    enabled?: boolean;
    separator?: boolean;
}

export interface AppContext {
    scene: Scene;
    readonly view: View2D;
    selection: Set<string>;
    locked: Set<string>;
    readonly widgets: Widgets;
    // Records the scene for undo (call before the first modification of a gesture).
    saveUndo(): void;
    // Discards the most recent undo record (when a gesture turned out to change nothing).
    discardUndo(): void;
    // The scene changed: redraw, and rebuild the 3d model ('live' during drags).
    changed( live?: boolean ): void;
    requestRender(): void;
    setTool( name: string ): void;
    flash( message: string ): void;
    openCrossSectionEditor( shape: Cylinder, t: number ): void;
    moveToFront( id: string ): void;
}

// An in-progress drag, which receives events until the mouse is released.
export interface Drag {
    move( e: ToolEvent ): void;
    up( e: ToolEvent ): void;
    draw?( v: View2D ): void;
    status?(): string;
}

export abstract class Tool {
    abstract readonly name: string;
    abstract readonly title: string;
    abstract readonly icon: string;
    abstract readonly shortcut: string;
    protected drag: Drag | null = null;
    // A drag to start on the next mouse down (for modes chosen from a contextual menu).
    protected pending: ( ( e: ToolEvent ) => Drag | null ) | null = null;
    protected pendingStatus = '';
    hover: ToolEvent | null = null;

    constructor( protected readonly app: AppContext ) {}

    get dragging(): boolean { return this.drag !== null; }

    down( e: ToolEvent ): void {
        if( this.pending ) {
            const start = this.pending;
            this.pending = null;
            this.drag = start( e );
            return;
        }
        this.drag = this.press( e );
    }
    move( e: ToolEvent ): void {
        this.hover = e;
        if( this.drag ) this.drag.move( e );
        this.app.requestRender();
    }
    up( e: ToolEvent ): void {
        const d = this.drag;
        this.drag = null;
        d?.up( e );
        this.app.requestRender();
    }
    // Cancels any drag or pending mode (e.g. on undo).
    reset(): void { this.drag = null; this.pending = null; }

    // Starts a drag for a mouse press, or returns null.
    protected abstract press( e: ToolEvent ): Drag | null;
    // The status text for the mouse position.
    protected abstract hoverStatus( e: ToolEvent ): string;
    status(): string {
        if( this.drag?.status ) return this.drag.status();
        if( this.pending ) return this.pendingStatus;
        return this.hover ? this.hoverStatus( this.hover ) : '';
    }
    drawOverlay( v: View2D ): void {
        if( this.drag?.draw ) this.drag.draw( v );
        else if( this.hover ) this.drawHover( v, this.hover );
    }
    protected drawHover( _v: View2D, _e: ToolEvent ): void {}
    contextMenu( _e: ToolEvent ): MenuItem[] { return []; }
    // Returns true if the key was handled.
    key( _key: string, _e: ToolEvent ): boolean { return false; }
    // The annotation types drawn while this tool is active.
    annotationTypes(): Annotation['type'][] { return []; }

    protected unlockedShapes(): Shape[] { return this.app.scene.shapes.filter( s => !this.app.locked.has( s.id ) ); }
    protected thresholds() { return { point: this.app.view.pointThreshold, edge: this.app.view.edgeThreshold }; }
}

// A drag that collects a stroke.
class StrokeDrag implements Drag {
    readonly stroke: Vec2[];
    constructor( start: Vec2, private readonly finish: ( stroke: Vec2[], e: ToolEvent ) => void, private readonly color = Colors.spine, private readonly label = '' ) {
        this.stroke = [ start ];
    }
    move( e: ToolEvent ): void {
        const last = this.stroke[ this.stroke.length - 1 ];
        if( last[0] !== e.world[0] || last[1] !== e.world[1] ) this.stroke.push( e.world );
    }
    up( e: ToolEvent ): void { this.finish( this.stroke, e ); }
    draw( v: View2D ): void { v.stroke( this.stroke, rgba( this.color, 200 / 255 ), 2 * v.lineWidth ); }
    status(): string { return this.label; }
}

// A drag that calls 'update' with each new mouse position, recording undo before the first change.
class EditDrag implements Drag {
    private started = false;
    constructor(
        private readonly app: AppContext,
        private readonly update: ( e: ToolEvent, first: boolean ) => boolean | void,
        private readonly label: string,
        private readonly drawFn?: ( v: View2D ) => void,
        private readonly finish?: () => void,
    ) {}
    private moves = 0;
    move( e: ToolEvent ): void {
        if( !this.started ) this.app.saveUndo();
        const changed = this.update( e, this.moves++ === 0 ) !== false;
        if( !this.started ) {
            if( !changed ) { this.app.discardUndo(); return; }
            this.started = true;
        }
        if( changed ) this.app.changed( true );
    }
    up( _e: ToolEvent ): void {
        if( this.started ) { this.finish?.(); this.app.changed( false ); }
    }
    draw( v: View2D ): void { this.drawFn?.( v ); }
    status(): string { return this.label; }
}

// ---- Select ----------------------------------------------------------------------------------

type ShapeHandle = { shape: Cylinder, pick: CylinderPick } | { shape: Ellipsoid, handle: EllipsoidHandle };

const kSelectedParts = [ Part.CrossSectionTiltHandle, Part.RadiusHandle, Part.SymmetryPlaneHandle, Part.CapRadiusHandle, Part.CrossSection, Part.Spine, Part.Boundary, Part.BoundaryInterior ];

export class SelectTool extends Tool {
    readonly name = 'select';
    readonly title = 'Select and manipulate shapes';
    readonly icon = 'select';
    readonly shortcut = 'v';

    // The unlocked shape under the mouse (list order).
    pickShape( p: Vec2 ): Shape | null {
        for( const s of this.unlockedShapes() ) {
            if( s instanceof Cylinder ) { if( pickCylinder( s, p, this.thresholds(), [ Part.BoundaryInterior ] ) ) return s; }
            else if( pickEllipsoid( s, p, 0 ) ) return s;
        }
        return null;
    }

    pickHandle( p: Vec2 ): ShapeHandle | null {
        for( const s of this.app.scene.shapes ) {
            if( !this.app.selection.has( s.id ) ) continue;
            if( s instanceof Cylinder ) {
                const pick = pickCylinder( s, p, this.thresholds(), kSelectedParts );
                if( pick ) return { shape: s, pick };
            } else {
                const h = pickEllipsoid( s, p, this.app.view.pointThreshold );
                if( h ) return { shape: s, handle: h.handle };
            }
        }
        return null;
    }

    protected press( e: ToolEvent ): Drag | null {
        const app = this.app;
        if( e.shift ) {
            const s = this.pickShape( e.world );
            if( s ) {
                if( e.alt ) app.selection.delete( s.id );
                else { app.selection.add( s.id ); app.moveToFront( s.id ); }
            }
            return null;
        }
        if( app.selection.size > 0 && e.mod ) return this.translateDrag( app.scene.shapes.filter( s => app.selection.has( s.id ) ), e );
        const handle = this.pickHandle( e.world );
        if( handle ) {
            const d = this.dragForHandle( handle, e );
            d?.move( e );
            return d;
        }
        const s = this.pickShape( e.world );
        app.selection = new Set( s ? [ s.id ] : [] );
        if( s ) app.moveToFront( s.id );
        return null;
    }

    private translateDrag( shapes: Shape[], e: ToolEvent ): Drag {
        let last = e.world;
        return new EditDrag( this.app, ev => {
            const delta = sub( ev.world, last );
            last = ev.world;
            if( delta[0] === 0 && delta[1] === 0 ) return false;
            for( const s of shapes ) s.translate( delta );
        }, shapes.length > 1 ? 'Translate shapes' : 'Move' );
    }

    // ArrowMode2.ModeFromShapeHandle()
    private dragForHandle( h: ShapeHandle, e: ToolEvent ): Drag | null {
        if( h.shape instanceof Ellipsoid ) return this.ellipsoidDrag( h.shape, ( h as { handle: EllipsoidHandle } ).handle, e );
        const shape = h.shape;
        const pick = ( h as { pick: CylinderPick } ).pick;
        switch( pick.part ) {
            case Part.CrossSectionTiltHandle: return e.alt ? this.spineDeformer( shape ) : this.tilter( shape, pick.t! );
            case Part.RadiusHandle: return e.alt ? this.radiusManip( shape, pick.t! ) : this.silhouetteManip( shape, pick.t!, pick.rightTurn! );
            case Part.CapRadiusHandle: return this.capManip( shape, pick.t as 0 | 1 );
            case Part.SymmetryPlaneHandle: return this.symmetryManip( shape, pick.t! );
            case Part.Spine: return e.alt ? this.tilter( shape ) : this.spineDeformer( shape );
            case Part.Boundary: return e.alt ? this.radiusManip( shape ) : this.silhouetteManip( shape );
            case Part.BoundaryInterior: return this.translateDrag( [ shape ], e );
            case Part.CrossSection: this.app.openCrossSectionEditor( shape, pick.t! ); return null;
        }
        return null;
    }

    private handlesDraw( shape: Cylinder ) { return ( v: View2D ) => drawCylinderHandles( v, shape, this.app.widgets ); }

    // CircularCrossSectionTilter: drags a tilt handle; with no 't', adds one at the spine point clicked.
    tilter( shape: Cylinder, t?: number ): Drag | null {
        let param = t;
        return new EditDrag( this.app, ( e, first ) => {
            if( param === undefined ) {
                if( !first ) return false;
                const c = closestOnLineStrip( shape.spine2d, e.world );
                const used = shape.tilts.keys().map( k => shape.edgeIndexAtT( k ) );
                if( c.distSqr >= this.app.view.edgeThreshold ** 2 || used.includes( c.edgeIndex ) ) return false;
                param = edgeIndex2t( c.edgeIndex, shape.n );
            }
            shape.tilts.set( param, tiltFromPoint( shape, param, e.world ) );
            shape.changed( 'tilts' );
        }, 'Change tilt', this.handlesDraw( shape ) );
    }

    // CircularCrossSectionRadiusManip: drags a radius symmetrically; with no 't', adds one at the outline point clicked.
    radiusManip( shape: Cylinder, t?: number ): Drag | null {
        let param = t;
        return new EditDrag( this.app, ( e, first ) => {
            if( param === undefined ) {
                if( !first ) return false;
                const c = closestOnOffsets( shape, e.world );
                const used = shape.radii.keys().map( k => shape.edgeIndexAtT( k ) );
                if( c.distSqr >= this.app.view.edgeThreshold ** 2 || used.includes( c.edgeIndex ) ) return false;
                param = edgeIndex2t( c.edgeIndex, shape.n );
            }
            shape.radii.set( param, mag( sub( e.world, shape.spine2dAtT( param ) ) ) );
            shape.changed( 'radii' );
        }, 'Change scale', this.handlesDraw( shape ) );
    }

    // silhouette_manip.SweepShapeSilhouetteManip: drags one side of the outline while the opposite
    // side stays fixed, deforming the spine to remain centered (paper Section 4.1, "Cross-section scale handle").
    silhouetteManip( shape: Cylinder, t?: number, rightTurn?: boolean ): Drag | null {
        let param = t, right = rightTurn;
        let undeformed: Vec2[] = shape.spine2d.map( p => [ p[0], p[1] ] );
        let vertex = -1;
        let opposite: Vec2 | null = null;
        const init = () => {
            vertex = shape.vertexIndexAtT( param! );
            opposite = boundaryPerpendicular( shape, param! )[ right ? 1 : 0 ];
            undeformed = shape.spine2d.map( p => [ p[0], p[1] ] );
        };
        if( param !== undefined ) init();
        return new EditDrag( this.app, ( e, first ) => {
            if( param === undefined ) {
                if( !first ) return false;
                const plus = closestOnOffsets( shape, e.world, 1 ), minus = closestOnOffsets( shape, e.world, -1 );
                const c = plus.distSqr <= minus.distSqr ? plus : minus;
                right = plus.distSqr <= minus.distSqr;
                const used = shape.radii.keys().map( k => shape.edgeIndexAtT( k ) );
                if( c.distSqr >= this.app.view.edgeThreshold ** 2 || used.includes( c.edgeIndex ) ) return false;
                param = edgeIndex2t( c.edgeIndex, shape.n );
                init();
            }
            const mouse = e.world;
            const center = scale( add( mouse, opposite! ), 0.5 );
            const radius = 0.5 * mag( sub( mouse, opposite! ) );
            if( radius <= 0 ) return false;
            shape.radii.set( param, radius );

            const n = undeformed.length;
            const constraints = new Map<number, Vec2>();
            if( vertex !== 0 ) constraints.set( 0, undeformed[0] );
            if( vertex !== n - 1 ) constraints.set( n - 1, undeformed[ n - 1 ] );
            constraints.set( vertex, center );
            // Constrain the neighboring vertex on the same edge, to keep the spine perpendicular to the drag.
            const edge = t2edgeIndex( param, n );
            const vertex2 = edge === vertex ? edge + 1 : edge;
            let perp = dir( sub( mouse, opposite! ) );
            perp = scale( perp, mag( sub( undeformed[edge + 1], undeformed[edge] ) ) );
            let edgeVec: Vec2 = [ perp[1], -perp[0] ];
            if( right ) edgeVec = scale( edgeVec, -1 );
            constraints.set( vertex2, add( center, scale( edgeVec, vertex2 - vertex ) ) );
            setSpine2d( shape, laplacianCurveEdit( undeformed, [ ...constraints.entries() ] ) );
            shape.changed( 'radii' );
        }, 'Stretch silhouette', this.handlesDraw( shape ) );
    }

    // CapRadiusManip
    capManip( shape: Cylinder, end: 0 | 1 ): Drag {
        return new EditDrag( this.app, e => {
            const center = shape.spine2dAtT( end );
            let tangent = dir( shape.tangent2dAtT( end ) );
            if( end === 0 ) tangent = scale( tangent, -1 );
            shape.capRadii[end] = Math.max( 0, dot( tangent, sub( e.world, center ) ) );
            shape.changed( 'caps' );
        }, 'Change cap size', this.handlesDraw( shape ) );
    }

    // SymmetryPlaneManip (Alt continues the angle periodically).
    symmetryManip( shape: Cylinder, t: number ): Drag {
        return new EditDrag( this.app, ( e, first ) => {
            // Ignore the click itself.
            if( first ) return false;
            shape.symmetry.set( t, symmetryFromPoint( shape, t, e.world, e.alt ) );
            shape.changed( 'symmetry' );
        }, 'Change symmetry plane', this.handlesDraw( shape ) );
    }

    // SweepShapeSpineDeformer: the "peeling" spine deformation of [Igarashi et al. 2005].
    spineDeformer( shape: Cylinder ): Drag | null {
        const undeformed: Vec2[] = shape.spine2d.map( p => [ p[0], p[1] ] );
        let vertex: number | null = null;
        let start: Vec2 = [ 0, 0 ];
        let startIndex: number | null = null, endIndex: number | null = null;
        return new EditDrag( this.app, ( e, first ) => {
            if( first ) {
                const pick = pickCylinder( shape, e.world, this.thresholds(), [ Part.Spine ] );
                if( !pick ) return false;
                vertex = shape.vertexIndexAtT( pick.t! );
                start = e.world;
            }
            if( vertex === null ) return false;
            const n = undeformed.length;
            const d = mag( sub( e.world, start ) );
            let si = vertex - 1;
            while( si >= 0 && !( lineStripLength( undeformed.slice( si, vertex + 1 ) ) > d ) ) si -= 1;
            let ei = vertex + 1;
            while( ei < n && !( lineStripLength( undeformed.slice( vertex, ei + 1 ) ) > d ) ) ei += 1;
            // Keep both endpoints fixed (unless dragging an endpoint).
            ei = Math.min( n - 1, ei );
            si = Math.max( 0, si );
            // The live area only grows.
            if( startIndex !== null ) si = Math.min( si, startIndex );
            startIndex = si;
            if( endIndex !== null ) ei = Math.max( ei, endIndex );
            endIndex = ei;

            const constrainStart = si >= 0, tangentStart = si - 1 >= 0;
            si = Math.max( si - 1, 0 );
            const constrainEnd = ei < n, tangentEnd = ei + 1 < n;
            ei = Math.min( ei + 1, n - 1 );
            const constraints = new Map<number, Vec2>();
            if( constrainStart ) constraints.set( 0, undeformed[si] );
            if( tangentStart ) constraints.set( 1, undeformed[si + 1] );
            if( constrainEnd ) constraints.set( ei - si, undeformed[ei] );
            if( tangentEnd ) constraints.set( ei - 1 - si, undeformed[ei - 1] );
            constraints.set( vertex - si, e.world );
            if( constraints.size === 1 ) {
                setSpine2d( shape, undeformed.map( p => add( p, sub( e.world, start ) ) ) );
                return;
            }
            const edited = laplacianCurveEdit( undeformed.slice( si, ei + 1 ), [ ...constraints.entries() ] );
            const curve = undeformed.map( p => [ p[0], p[1] ] as Vec2 );
            edited.forEach( ( p, i ) => { curve[si + i] = p; } );
            setSpine2d( shape, curve );
        }, 'Drag to deform', v => {
            if( startIndex !== null && endIndex !== null ) {
                v.stroke( shape.spine2d.slice( Math.max( startIndex, 0 ), Math.min( endIndex + 1, shape.n ) ), rgba( Colors.liveSpine ), v.lineWidth );
            }
        }, () => smoothSpine( shape, 0 ) );
    }

    // SpineRedrawer: replaces part of the spine with (or extends it by) a stroke.
    oversketcher( shape: Cylinder, e: ToolEvent ): Drag {
        return new StrokeDrag( e.world, stroke => {
            if( stroke.length < 2 ) return;
            const n = shape.n;
            const smoothed = smoothOpenStroke( stroke, 10, Math.max( 3, Math.ceil( kSamplesPerUnitDistance * lineStripLength( stroke ) ) ) );
            this.app.saveUndo();
            const oldTs = shape.allParticularTs();
            const newTs = oldTs.slice();
            const spine = oversketch( shape.spine2d, smoothed, this.app.view.zoom, newTs );
            setSpine2d( shape, spine, new Map( oldTs.map( ( t, i ) => [ t, newTs[i] ] ) ) );
            resampleSpine( shape, Math.max( n, Math.max( 3, Math.ceil( kSamplesPerUnitDistance * lineStripLength( spine ) ) ) ) );
            this.app.changed( false );
        }, Colors.spine, 'Oversketch' );
    }

    private ellipsoidDrag( shape: Ellipsoid, handle: EllipsoidHandle, e: ToolEvent ): Drag {
        let last = e.world;
        const labels: Record<EllipsoidHandle, string> = { 'move': 'Move', 'axis0+': 'Rotate/Scale', 'axis0-': 'Rotate/Scale', 'axis1+': 'Change circle radius', 'axis1-': 'Change circle radius', 'tilt': 'Tilt circular cross section' };
        return new EditDrag( this.app, ev => {
            const delta = sub( ev.world, last );
            last = ev.world;
            if( delta[0] === 0 && delta[1] === 0 ) return false;
            dragEllipsoidHandle( shape, handle, delta );
        }, labels[handle], v => drawEllipsoidHandles( v, shape, this.app.widgets ) );
    }

    protected hoverStatus( e: ToolEvent ): string {
        if( e.shift ) return e.alt ? 'Remove from selection' : 'Add to selection';
        if( this.app.selection.size > 0 && e.mod ) return 'Translate shape' + ( this.app.selection.size > 1 ? 's' : '' );
        const h = this.pickHandle( e.world );
        if( h ) {
            if( h.shape instanceof Ellipsoid ) {
                const handle = ( h as { handle: EllipsoidHandle } ).handle;
                return handle === 'move' ? 'Move' : handle.startsWith( 'axis0' ) ? 'Rotate/Scale' : handle.startsWith( 'axis1' ) ? 'Change circle radius' : 'Tilt circular cross section';
            }
            const part = ( h as { pick: CylinderPick } ).pick.part;
            const alt = e.alt;
            return {
                [Part.CrossSectionTiltHandle]: alt ? 'Stretch' : 'Change tilt',
                [Part.RadiusHandle]: alt ? 'Change scale' : 'Stretch silhouette',
                [Part.CapRadiusHandle]: 'Change cap size',
                [Part.SymmetryPlaneHandle]: 'Change symmetry plane',
                [Part.Spine]: alt ? 'Add tilt handle' : 'Stretch',
                [Part.Boundary]: alt ? 'Add scale handle' : 'Stretch silhouette',
                [Part.BoundaryInterior]: 'Move',
                [Part.CrossSection]: 'Edit cross section',
            }[ part as number ] ?? '';
        }
        return 'Select shape';
    }

    protected drawHover( v: View2D, e: ToolEvent ): void {
        const app = this.app;
        const s = this.pickShape( e.world );
        for( const shape of app.scene.shapes ) {
            if( !app.selection.has( shape.id ) ) continue;
            if( shape instanceof Cylinder ) drawCylinderHandles( v, shape, app.widgets );
            else drawEllipsoidHandles( v, shape, app.widgets );
        }
        if( s && !app.selection.has( s.id ) ) drawShapeGuide( v, s );
        if( !e.shift && !( app.selection.size > 0 && e.mod ) ) {
            const h = this.pickHandle( e.world );
            if( h && h.shape instanceof Cylinder ) drawCylinderGuide( v, h.shape, ( h as { pick: CylinderPick } ).pick );
        }
    }

    drawOverlay( v: View2D ): void {
        if( this.drag?.draw ) {
            // Keep showing the other selected shapes' handles during a drag.
            for( const shape of this.app.scene.shapes ) {
                if( !this.app.selection.has( shape.id ) ) continue;
                if( shape instanceof Cylinder ) drawCylinderHandles( v, shape, this.app.widgets );
                else drawEllipsoidHandles( v, shape, this.app.widgets );
            }
            this.drag.draw( v );
        } else if( this.hover ) this.drawHover( v, this.hover );
        else for( const shape of this.app.scene.shapes ) {
            if( !this.app.selection.has( shape.id ) ) continue;
            if( shape instanceof Cylinder ) drawCylinderHandles( v, shape, this.app.widgets );
            else drawEllipsoidHandles( v, shape, this.app.widgets );
        }
    }

    key( key: string ): boolean {
        if( key === 'Delete' || key === 'Backspace' ) {
            if( this.app.selection.size === 0 ) return false;
            this.app.saveUndo();
            for( const id of this.app.selection ) { removeShape( this.app.scene, id ); this.app.locked.delete( id ); }
            this.app.selection = new Set();
            this.app.changed( false );
            return true;
        }
        return false;
    }

    annotationTypes(): Annotation['type'][] { return [ 'connection' ]; }

    // ArrowMode.doContextMenu() and _AddSweepShapeMenuItems()
    contextMenu( e: ToolEvent ): MenuItem[] {
        const app = this.app;
        const items: MenuItem[] = [];
        const selected = app.scene.shapes.filter( s => app.selection.has( s.id ) );
        let shape: Shape | null = null;
        for( const s of selected ) {
            if( s instanceof Cylinder ? pickCylinder( s, e.world, this.thresholds(), kSelectedParts ) : pickEllipsoid( s, e.world, app.view.pointThreshold ) ) { shape = s; break; }
        }
        const edit = ( f: () => void ) => () => { app.saveUndo(); f(); garbageCollect( app.scene ); app.changed( false ); };

        if( shape instanceof Cylinder ) items.push( ...this.cylinderMenu( shape, e, edit ) );
        if( shape ) {
            const s = shape;
            items.push( { label: 'Delete Shape', action: edit( () => { removeShape( app.scene, s.id ); app.selection.delete( s.id ); } ) } );
            items.push( { separator: true } );
            items.push( { label: 'Lock Shape', action: () => { app.locked.add( s.id ); app.selection.delete( s.id ); app.requestRender(); } } );
        }
        if( selected.length > 0 ) {
            items.push( { label: 'Lock All Selected Shapes', action: () => { for( const id of app.selection ) app.locked.add( id ); app.selection = new Set(); app.requestRender(); } } );
        }
        items.push( { label: 'Unlock All Shapes', enabled: app.locked.size > 0, action: () => { app.locked.clear(); app.requestRender(); } } );
        return items;
    }

    private cylinderMenu( shape: Cylinder, e: ToolEvent, edit: ( f: () => void ) => () => void ): MenuItem[] {
        const app = this.app;
        const th = this.thresholds();
        const pickPart = ( part: Part ) => pickCylinder( shape, e.world, th, [ part ] );
        const spine = pickPart( Part.Spine );
        const xsection = pickCylinder( shape, e.world, th, [ Part.CrossSectionInterior, Part.CrossSection ] );
        // ( exists, t ) for a kind of handle at the mouse: either the picked handle, or the spine point.
        const info = ( picked: CylinderPick | null, ts: number[] ): [ boolean, number ] | null => {
            if( picked ) return [ true, picked.t! ];
            if( spine ) {
                const vi = shape.vertexIndexAtT( spine.t! );
                const collide = ts.filter( t => shape.vertexIndexAtT( t ) === vi );
                if( collide.length > 0 ) return [ true, collide.reduce( ( a, b ) => Math.abs( spine.t! - b ) < Math.abs( spine.t! - a ) ? b : a ) ];
                return [ false, spine.t! ];
            }
            return null;
        };
        const items: MenuItem[] = [
            { label: 'Deform Spine', action: () => { this.pending = ev => { const d = this.spineDeformer( shape ); d?.move( ev ); return d; }; this.pendingStatus = 'Drag the spine to deform it'; } },
            { label: 'Over-sketch Spine', action: () => { this.pending = ev => this.oversketcher( shape, ev ); this.pendingStatus = 'Draw over or beyond the spine'; } },
            { label: 'Deform Silhouette', action: () => { this.pending = ev => { const d = this.silhouetteManip( shape ); d?.move( ev ); return d; }; this.pendingStatus = 'Drag the outline'; } },
            { label: 'Smooth Spine', action: edit( () => smoothSpine( shape ) ) },
            { label: 'Double Spine Tessellation', action: edit( () => resampleSpine( shape, Math.max( 3, Math.round( 2 * shape.n ) ) ) ) },
            { label: 'Halve Spine Tessellation', action: edit( () => resampleSpine( shape, Math.max( 3, Math.round( 0.5 * shape.n ) ) ) ) },
            { label: 'Straighten Spine', action: edit( () => straightenSpine( shape ) ) },
        ];

        const radiusPick = pickPart( Part.RadiusHandle );
        if( radiusPick ) {
            items.push( { separator: true }, { label: 'Change Scale', action: () => { this.pending = ev => { const d = this.radiusManip( shape, radiusPick.t! ); d?.move( ev ); return d; }; this.pendingStatus = 'Drag to change the scale'; } } );
        }

        const xs = info( xsection, shape.crossSections.keys() );
        if( xs ) {
            const t = xs[1];
            items.push( { separator: true } );
            items.push( { label: shape.crossSections.has( t ) ? 'Re-Draw Arbitrary Cross Section' : 'Draw Arbitrary Cross Section', action: () => app.openCrossSectionEditor( shape, t ) } );
            if( shape.crossSections.has( t ) ) {
                items.push( { label: 'Delete Arbitrary Cross Section', action: edit( () => { shape.crossSections.delete( t ); shape.changed( 'crossSections' ); } ) } );
            }
        }

        const tilt = info( pickPart( Part.CrossSectionTiltHandle ), shape.tilts.keys() );
        const radius = info( radiusPick, shape.radii.keys() );
        const symmetry = info( pickPart( Part.SymmetryPlaneHandle ), shape.symmetry.keys() );
        let cap: [ boolean, 0 | 1 ] | null = null;
        const capPick = pickPart( Part.CapRadiusHandle );
        if( capPick ) cap = [ false, capPick.t as 0 | 1 ];
        else if( spine ) {
            const vi = shape.vertexIndexAtT( spine.t! );
            if( vi === 0 || vi === shape.n - 1 ) cap = [ false, vi === 0 ? 0 : 1 ];
        }
        if( cap ) cap[0] = shape.capRadii[ cap[1] ] !== null;
        if( tilt || radius || symmetry || cap ) items.push( { separator: true } );

        if( tilt ) {
            const t = tilt[1];
            if( shape.tilts.has( t ) ) items.push( { label: 'Delete Tilt Handle', enabled: shape.tilts.size > 1, action: edit( () => { shape.tilts.delete( t ); shape.changed( 'tilts' ); } ) } );
            else items.push( { label: 'Add Tilt Handle', action: edit( () => { shape.tilts.set( t, tiltAt( shape, t ) ); shape.changed( 'tilts' ); } ) } );
        }
        if( radius ) {
            const t = radius[1];
            if( shape.radii.has( t ) ) items.push( { label: 'Delete Scale Handle', enabled: shape.radii.size > 1, action: edit( () => { shape.radii.delete( t ); shape.changed( 'radii' ); } ) } );
            else items.push( { label: 'Add Scale Handle', action: edit( () => { shape.radii.set( t, shape.radiusAtT( t ) ); shape.changed( 'radii' ); } ) } );
        }
        if( cap ) {
            const end = cap[1];
            items.push( { label: 'Free Cap Size Handle', enabled: cap[0], action: edit( () => { shape.capRadii[end] = null; shape.changed( 'caps' ); } ) } );
        }
        if( symmetry ) {
            const t = symmetry[1];
            if( shape.symmetry.has( t ) ) items.push( { label: 'Delete Symmetry Plane Handle', enabled: shape.symmetry.size > 1, action: edit( () => { shape.symmetry.delete( t ); shape.changed( 'symmetry' ); } ) } );
            else items.push( { label: 'Add Symmetry Plane Handle', action: edit( () => { shape.symmetry.set( t, symmetryAt( shape, t ) ); shape.changed( 'symmetry' ); } ) } );
        }
        items.push( { separator: true } );
        return items;
    }
}

// The closest point to 'p' on one side (sign +1 right, -1 left) of a cylinder's offset outline,
// or on either side if 'sign' is omitted (annotations_sweep.boundary_offsets2d()).
function closestOnOffsets( shape: Cylinder, p: Vec2, sign?: 1 | -1 ) {
    const radii = shape.denseRadii;
    const offsets = shape.spine2d.map( ( _, i ) => {
        const e = Math.min( i, shape.n - 2 );
        const tan = dir( sub( shape.spine2d[e + 1], shape.spine2d[e] ) );
        return scale( [ tan[1], -tan[0] ] as Vec2, radii[i] );
    } );
    const side = ( s: number ) => closestOnLineStrip( shape.spine2d.map( ( q, i ) => add( q, scale( offsets[i], s ) ) ), p );
    if( sign ) return side( sign );
    const a = side( 1 ), b = side( -1 );
    return a.distSqr <= b.distSqr ? a : b;
}

// ---- Creating shapes -------------------------------------------------------------------------

export class CylinderTool extends Tool {
    readonly name = 'cylinder';
    readonly title = 'Create a generalized cylinder by drawing its spine (Shift: straight)';
    readonly icon = 'spine';
    readonly shortcut = 'c';
    protected press( e: ToolEvent ): Drag {
        return new StrokeDrag( e.world, ( stroke, up ) => {
            const app = this.app;
            const shape = cylinderFromStroke( newId(), stroke, 0.2 / app.view.zoom, app.view.zoom, up.shift );
            if( !shape ) return;
            app.saveUndo();
            app.scene.shapes.push( shape );
            app.changed( false );
            app.setTool( 'select' );
            app.selection = new Set( [ shape.id ] );
        }, Colors.spine, 'Draw a spine' );
    }
    protected hoverStatus(): string { return 'Draw a spine'; }
}

export class EllipsoidTool extends Tool {
    readonly name = 'ellipsoid';
    readonly title = 'Create an ellipsoid by drawing its outline';
    readonly icon = 'ellipse';
    readonly shortcut = 'e';
    protected press( e: ToolEvent ): Drag {
        return new StrokeDrag( e.world, stroke => {
            const app = this.app;
            const ellipse = fitEllipse( smoothOpenStroke( stroke ) );
            if( !ellipse ) { app.flash( "Couldn't fit an ellipse to the stroke." ); return; }
            const [ , a, b ] = ellipse;
            if( Math.max( mag( a ), mag( b ) ) / Math.min( mag( a ), mag( b ) ) > 50 ) { app.flash( 'The ellipse is too narrow.' ); return; }
            const shape = Ellipsoid.fromEllipse( newId(), ellipse );
            shape.setCrossSectionFromPoint( 1, [ shape.center[0] + shape.axes[2][0], shape.center[1] + shape.axes[2][1] ] );
            app.saveUndo();
            app.scene.shapes.push( shape );
            app.changed( false );
            app.setTool( 'select' );
            app.selection = new Set( [ shape.id ] );
        }, [ 0, 0, 0 ], 'Draw an ellipse' );
    }
    protected hoverStatus(): string { return 'Draw an ellipse'; }
}

// ---- Connections -----------------------------------------------------------------------------

export class ConnectTool extends Tool {
    readonly name = 'connect';
    readonly title = 'Connect two overlapping shapes (drag where their surfaces should meet)';
    readonly icon = 'connect';
    readonly shortcut = 'k';
    private excluded = new Set<string>();

    private shapesAt( p: Vec2 ): Shape[] {
        return pickSurfaces( this.unlockedShapes(), p ).map( x => x.shape ).filter( s => !this.excluded.has( s.id ) );
    }
    private connectionBetween( a: string, b: string ): Connection | undefined {
        return this.app.scene.connections().find( c => c.shapes.includes( a ) && c.shapes.includes( b ) );
    }

    protected press( e: ToolEvent ): Drag | null {
        const shapes = this.shapesAt( e.world );
        if( shapes.length !== 2 ) return null;
        const existing = this.connectionBetween( shapes[0].id, shapes[1].id );
        if( !existing && connected( this.app.scene, shapes[0].id, shapes[1].id ) ) {
            this.app.flash( 'Refusing to add a cycle to the graph of connected shapes.' );
            return null;
        }
        const d = this.dragger( shapes, existing );
        d.move( e );
        return d;
    }

    // ConnectionDragger: the shapes meet under the mouse.
    private dragger( shapes: Shape[], existing?: Connection ): Drag {
        const app = this.app;
        let con = existing;
        return new EditDrag( app, ev => {
            const ray: [ [ number, number, number ], [ number, number, number ] ] = [ [ ev.world[0], ev.world[1], 0 ], [ 0, 0, -1 ] ];
            if( shapes.some( s => s.rayTs( ...ray ).length < 2 ) ) return false;
            if( !con ) {
                con = { type: 'connection', shapes: [ shapes[0].id, shapes[1].id ], attachFront: [ true, true ], curve: [] };
                app.scene.annotations.push( con );
            }
            con.curve = [ ev.world ];
        }, 'Drag connection curve' );
    }

    // ConnectionDrawer: the shapes meet along a drawn curve.
    private drawer( shapes: Shape[], existing: Connection | undefined, e: ToolEvent ): Drag {
        return new StrokeDrag( e.world, stroke => {
            if( stroke.length < 2 || ( stroke[0][0] === stroke[ stroke.length - 1 ][0] && stroke[0][1] === stroke[ stroke.length - 1 ][1] ) ) return;
            this.app.saveUndo();
            const curve = smoothOpenStroke( stroke, 10, 10 );
            if( existing ) existing.curve = curve;
            else this.app.scene.annotations.push( { type: 'connection', shapes: [ shapes[0].id, shapes[1].id ], attachFront: [ true, true ], curve } );
            this.app.changed( false );
        }, Colors.connection, 'Draw connection curve' );
    }

    protected hoverStatus( e: ToolEvent ): string {
        return this.shapesAt( e.world ).length === 2 ? 'Drag connection curve' : 'Connect two shapes';
    }
    protected drawHover( v: View2D, e: ToolEvent ): void {
        for( const s of this.shapesAt( e.world ) ) drawShapeGuide( v, s );
    }
    annotationTypes(): Annotation['type'][] { return [ 'connection' ]; }

    contextMenu( e: ToolEvent ): MenuItem[] {
        const app = this.app;
        const all = pickSurfaces( this.unlockedShapes(), e.world ).map( x => x.shape );
        if( all.length === 1 ) {
            const id = all[0].id;
            return this.excluded.has( id )
                ? [ { label: 'Un-exclude Shape', action: () => { this.excluded.delete( id ); } } ]
                : [ { label: 'Exclude Shape', action: () => { this.excluded.add( id ); } } ];
        }
        const shapes = all.filter( s => !this.excluded.has( s.id ) );
        if( shapes.length !== 2 ) return [];
        const con = this.connectionBetween( shapes[0].id, shapes[1].id );
        if( !con ) return [];
        // Signatures are in the connection's own shape order.
        const sig = ( a: boolean, b: boolean ) => () => { app.saveUndo(); con.attachFront = [ a, b ]; app.changed( false ); };
        return [
            { label: 'Draw Connection Curve', action: () => { this.pending = ev => this.drawer( shapes, con, ev ); this.pendingStatus = 'Draw the connection curve'; } },
            { label: 'Drag Connection Curve', action: () => { this.pending = ev => { const d = this.dragger( shapes, con ); d.move( ev ); return d; }; this.pendingStatus = 'Drag the connection curve'; } },
            { separator: true },
            { label: 'Disconnect', action: () => { app.saveUndo(); removeAnnotation( app.scene, con ); app.changed( false ); } },
            { separator: true },
            { label: 'Connect, Front', action: sig( true, true ) },
            { label: 'Connect, Front/Back', action: sig( true, false ) },
            { label: 'Connect, Back/Front', action: sig( false, true ) },
            { label: 'Connect, Back', action: sig( false, false ) },
        ];
    }
}

// ---- Same tilt / length / scale --------------------------------------------------------------

type Manip = { shape: string, t?: number };
type SameGroup = SameTilt | SameScale | SameLength;

abstract class SamePropertyTool extends Tool {
    abstract readonly property: string;
    abstract readonly type: SameGroup['type'];
    private group: SameGroup | null = null;

    abstract pickManip( p: Vec2 ): Manip | null;
    abstract drawManipGuide( v: View2D, m: Manip ): void;
    abstract newItem( m: Manip ): SameGroup['items'][number];

    private sameManip( item: { shape: string, t?: number }, m: Manip ): boolean {
        return item.shape === m.shape && ( this.type === 'sameLength' || item.t === m.t );
    }
    private groupOf( m: Manip ): SameGroup | null {
        return ( this.app.scene.annotations.find( a => a.type === this.type && ( a as SameGroup ).items.some( i => this.sameManip( i, m ) ) ) as SameGroup ) ?? null;
    }

    reset(): void { super.reset(); this.group = null; }

    protected press( e: ToolEvent ): Drag | null {
        const app = this.app;
        const m = this.pickManip( e.world );
        if( this.group && !app.scene.annotations.includes( this.group ) ) this.group = null;
        if( !this.group ) {
            if( !m ) return null;
            app.moveToFront( m.shape );
            let g = this.groupOf( m );
            if( !g ) {
                app.saveUndo();
                g = { type: this.type, items: [ this.newItem( m ) ], masters: [] } as SameGroup;
                app.scene.annotations.push( g );
                app.changed( false );
            }
            this.group = g;
            return null;
        }
        // Assigning to the group.
        if( !m ) { this.group = null; return null; }
        app.moveToFront( m.shape );
        const other = this.groupOf( m );
        if( other === this.group ) return null;
        app.saveUndo();
        ( this.group.items as Manip[] ).push( this.newItem( m ) );
        if( other ) {
            const i = other.items.findIndex( item => this.sameManip( item, m ) );
            other.items.splice( i, 1 );
            other.masters = other.masters.filter( k => k !== i ).map( k => k > i ? k - 1 : k );
        }
        garbageCollect( app.scene );
        // Our group may only have had one item.
        if( !app.scene.annotations.includes( this.group ) ) this.group = null;
        app.changed( false );
        return null;
    }

    protected hoverStatus( e: ToolEvent ): string {
        const m = this.pickManip( e.world );
        if( this.group ) {
            if( !m ) return `De-select same-${ this.property } group`;
            return this.groupOf( m ) !== this.group ? `Assign to same-${ this.property } group` : '';
        }
        if( !m ) return '';
        return this.groupOf( m ) ? `Choose same-${ this.property } group` : `Start same-${ this.property } group`;
    }
    protected drawHover( v: View2D, e: ToolEvent ): void {
        const m = this.pickManip( e.world );
        if( m ) this.drawManipGuide( v, m );
    }
    annotationTypes(): Annotation['type'][] { return [ this.type ]; }

    key( key: string, e: ToolEvent ): boolean {
        if( key !== 'Delete' && key !== 'Backspace' ) return false;
        const m = this.pickManip( e.world );
        if( !m ) return false;
        const g = this.groupOf( m );
        if( !g ) return false;
        this.app.saveUndo();
        const i = g.items.findIndex( item => this.sameManip( item, m ) );
        g.items.splice( i, 1 );
        g.masters = g.masters.filter( k => k !== i ).map( k => k > i ? k - 1 : k );
        garbageCollect( this.app.scene );
        this.app.changed( false );
        return true;
    }

    protected pickCylinderPart( p: Vec2, part: Part, has: ( s: Cylinder, t: number ) => boolean ): Manip | null {
        for( const s of this.unlockedShapes() ) {
            if( s instanceof Cylinder ) {
                const pick = pickCylinder( s, p, this.thresholds(), [ part ] );
                if( pick && has( s, pick.t! ) ) return { shape: s.id, t: pick.t };
            } else if( pickEllipsoid( s, p, this.app.view.pointThreshold ) ) {
                return { shape: s.id };
            }
        }
        return null;
    }
}

export class SameTiltTool extends SamePropertyTool {
    readonly name = 'sameTilt';
    readonly title = 'Mark cross sections with the same tilt';
    readonly icon = 'same-tilt';
    readonly shortcut = 't';
    readonly property = 'tilt';
    readonly type = 'sameTilt' as const;
    pickManip( p: Vec2 ) { return this.pickCylinderPart( p, Part.CrossSection, ( s, t ) => s.tilts.has( t ) ); }
    newItem( m: Manip ) { return m.t === undefined ? { shape: m.shape } : { shape: m.shape, t: m.t }; }
    drawManipGuide( v: View2D, m: Manip ): void {
        const s = this.app.scene.shape( m.shape );
        if( s instanceof Cylinder ) v.stroke( crossSectionLoop3d( s, m.t! ), rgba( Colors.smartGuide ), 1 / v.scale, true );
        else if( s ) drawShapeGuide( v, s );
    }
}

export class SameScaleTool extends SamePropertyTool {
    readonly name = 'sameScale';
    readonly title = 'Mark cross sections with the same scale';
    readonly icon = 'same-radius';
    readonly shortcut = 'r';
    readonly property = 'scale';
    readonly type = 'sameScale' as const;
    pickManip( p: Vec2 ) { return this.pickCylinderPart( p, Part.Diameter, ( s, t ) => s.radii.has( t ) ); }
    newItem( m: Manip ) { return m.t === undefined ? { shape: m.shape } : { shape: m.shape, t: m.t }; }
    drawManipGuide( v: View2D, m: Manip ): void {
        const s = this.app.scene.shape( m.shape );
        if( s instanceof Cylinder ) v.stroke( diameterSegment( s, m.t! ), rgba( Colors.smartGuide ), 1 / v.scale );
        else if( s ) drawShapeGuide( v, s );
    }
}

export class SameLengthTool extends SamePropertyTool {
    readonly name = 'sameLength';
    readonly title = 'Mark shapes with the same length';
    readonly icon = 'same-length';
    readonly shortcut = 'l';
    readonly property = 'length';
    readonly type = 'sameLength' as const;
    pickManip( p: Vec2 ) {
        for( const s of this.unlockedShapes() ) {
            if( s instanceof Cylinder ? pickCylinder( s, p, this.thresholds(), [ Part.Spine ] ) : pickEllipsoid( s, p, this.app.view.pointThreshold ) ) return { shape: s.id };
        }
        return null;
    }
    newItem( m: Manip ) {
        // The shape is scaled about its end nearest its (first) connection.
        const index = this.app.scene.annotations.findIndex( a => a.type === 'connection' && a.shapes.includes( m.shape ) );
        const s = this.app.scene.shape( m.shape );
        return { shape: m.shape, connection: index >= 0 && s instanceof Cylinder ? index : null };
    }
    drawManipGuide( v: View2D, m: Manip ): void {
        const s = this.app.scene.shape( m.shape );
        if( s instanceof Cylinder ) v.stroke( s.spine2d, rgba( Colors.smartGuide ), 1 / v.scale );
        else if( s ) drawShapeGuide( v, s );
    }
}

// ---- Mirror and align ------------------------------------------------------------------------

abstract class TwoClickTool extends Tool {
    protected first: string | null = null;
    protected pickShapeId( p: Vec2 ): string | null {
        const hits = pickSurfaces( this.unlockedShapes(), p );
        return hits.length > 0 ? hits[0].shape.id : null;
    }
    reset(): void { super.reset(); this.first = null; }
    protected drawHover( v: View2D, e: ToolEvent ): void {
        if( this.first ) {
            const s = this.app.scene.shape( this.first );
            if( s ) {
                const c = to2( s instanceof Cylinder ? s.center() : s.center );
                const k = 2.5 * v.lineWidth;
                v.disk( c, k, 'rgb(128,128,128)' );
                v.disk( c, 0.5 * k, 'rgb(64,64,64)' );
            }
        }
        const id = this.pickShapeId( e.world );
        const s = id ? this.app.scene.shape( id ) : null;
        if( s ) drawShapeGuide( v, s );
    }
}

export class MirrorTool extends TwoClickTool {
    readonly name = 'mirror';
    readonly title = 'Mirror a shape (and the shapes attached to it) across a connected shape';
    readonly icon = 'mirror-shape';
    readonly shortcut = 'm';
    protected press( e: ToolEvent ): Drag | null {
        const app = this.app;
        const id = this.pickShapeId( e.world );
        if( !this.first ) {
            if( !id ) return null;
            app.moveToFront( id );
            const existing = app.scene.annotations.filter( a => a.type === 'mirror' && a.shape === id );
            if( existing.length > 0 ) {
                app.saveUndo();
                for( const a of existing ) removeAnnotation( app.scene, a );
                app.changed( false );
            }
            this.first = id;
            return null;
        }
        const child = this.first;
        this.first = null;
        if( id && id !== child && app.scene.connections().some( c => c.shapes.includes( id ) && c.shapes.includes( child ) ) ) {
            app.saveUndo();
            app.scene.annotations.push( { type: 'mirror', shape: child, parent: id } );
            app.changed( false );
        } else if( id && id !== child ) {
            app.flash( 'A shape can only be mirrored across a shape it is connected to.' );
        }
        return null;
    }
    protected hoverStatus( e: ToolEvent ): string {
        if( this.first ) return 'Choose mirror';
        return this.pickShapeId( e.world ) ? 'Mirror this shape about another' : '';
    }
    annotationTypes(): Annotation['type'][] { return [ 'mirror' ]; }
    key( key: string, e: ToolEvent ): boolean {
        if( key !== 'Delete' && key !== 'Backspace' ) return false;
        const id = this.pickShapeId( e.world );
        const a = this.app.scene.annotations.find( a => a.type === 'mirror' && ( a.shape === id || a.parent === id ) );
        if( !a ) return false;
        this.app.saveUndo();
        removeAnnotation( this.app.scene, a );
        this.app.changed( false );
        return true;
    }
}

export class AlignTool extends TwoClickTool {
    readonly name: string;
    readonly title: string;
    readonly icon: string;
    readonly shortcut: string;

    // 'pair': align two shapes symmetrically across a shape both are connected to;
    // otherwise, center a shape on the symmetry sheet of a shape it is connected to.
    constructor( app: AppContext, private readonly pair: boolean ) {
        super( app );
        this.name = pair ? 'align' : 'center';
        this.title = pair ? 'Align two shapes symmetrically across a shape both are connected to' : 'Center a shape on a connected shape\'s symmetry sheet';
        this.icon = pair ? 'align-shape' : 'center-shape';
        this.shortcut = pair ? 'a' : 'x';
    }

    protected press( e: ToolEvent ): Drag | null {
        const app = this.app;
        const id = this.pickShapeId( e.world );
        if( !this.first ) {
            if( !id ) return null;
            app.moveToFront( id );
            const existing = app.scene.annotations.filter( a => a.type === 'align' && a.shapes.includes( id ) );
            if( existing.length > 0 ) {
                app.saveUndo();
                for( const a of existing ) removeAnnotation( app.scene, a );
                app.changed( false );
            }
            this.first = id;
            return null;
        }
        const first = this.first;
        this.first = null;
        if( !id || id === first ) return null;
        if( !this.pair ) {
            if( !neighbors( app.scene, first ).has( id ) ) { app.flash( 'A shape can only be centered on a shape it is connected to.' ); return null; }
            app.saveUndo();
            app.scene.annotations.push( { type: 'align', shapes: [ first, first ], parent: id } );
            app.changed( false );
            return null;
        }
        const n1 = neighbors( app.scene, id ), n2 = neighbors( app.scene, first );
        if( n1.has( first ) || n2.has( id ) ) { app.flash( 'Aligned shapes must both be connected to a third shape.' ); return null; }
        const bridge = [ ...n1 ].filter( s => n2.has( s ) );
        if( bridge.length !== 1 ) { app.flash( 'Aligned shapes must both be connected to a third shape.' ); return null; }
        app.saveUndo();
        app.scene.annotations.push( { type: 'align', shapes: [ first, id ], parent: bridge[0] } );
        app.changed( false );
        return null;
    }
    protected hoverStatus( e: ToolEvent ): string {
        if( this.first ) return this.pair ? 'Choose second shape' : 'Choose the shape to center on';
        return this.pickShapeId( e.world ) ? ( this.pair ? 'Align two shapes about another' : 'Center one shape on another' ) : '';
    }
    annotationTypes(): Annotation['type'][] { return [ 'align' ]; }
    key( key: string, e: ToolEvent ): boolean {
        if( key !== 'Delete' && key !== 'Backspace' ) return false;
        const id = this.pickShapeId( e.world );
        const a = this.app.scene.annotations.find( a => a.type === 'align' && id !== null && ( a.shapes.includes( id ) || a.parent === id ) );
        if( !a ) return false;
        this.app.saveUndo();
        removeAnnotation( this.app.scene, a );
        this.app.changed( false );
        return true;
    }
}

// ---- View tools ------------------------------------------------------------------------------

export class PanTool extends Tool {
    readonly name = 'pan';
    readonly title = 'Pan the view (or drag with the middle button, or hold Space)';
    readonly icon = 'pan';
    readonly shortcut = 'h';
    protected press( e: ToolEvent ): Drag {
        const v = this.app.view;
        let last = e.screen;
        return {
            move: ev => {
                v.center = [ v.center[0] - ( ev.screen[0] - last[0] ) / v.scale, v.center[1] + ( ev.screen[1] - last[1] ) / v.scale ];
                last = ev.screen;
                this.app.requestRender();
            },
            up: () => {},
            status: () => 'Drag to pan',
        };
    }
    protected hoverStatus(): string { return 'Drag to pan'; }
}

export class ZoomTool extends Tool {
    readonly name = 'zoom';
    readonly title = 'Zoom: click to zoom in, Alt-click to zoom out, drag to zoom to a rectangle (or use the scroll wheel)';
    readonly icon = 'zoom';
    readonly shortcut = 'z';
    protected press( e: ToolEvent ): Drag {
        const v = this.app.view;
        const start = e.world;
        let end = e.world;
        const isClick = () => { const a = v.toScreen( start ), b = v.toScreen( end ); return ( a[0] - b[0] ) ** 2 + ( a[1] - b[1] ) ** 2 < 49; };
        return {
            move: ev => { end = ev.world; },
            up: ev => {
                if( isClick() ) v.zoomAbout( ev.alt ? 0.5 : 2, v.toScreen( ev.world ) );
                else v.zoomToRect( [ Math.min( start[0], end[0] ), Math.min( start[1], end[1] ) ], [ Math.max( start[0], end[0] ), Math.max( start[1], end[1] ) ] );
                this.app.requestRender();
            },
            draw: view => { if( !isClick() ) view.stroke( [ start, [ end[0], start[1] ], end, [ start[0], end[1] ] ], 'black', 1 / view.scale, true ); },
            status: () => isClick() ? 'Zoom in' : 'Zoom to rect',
        };
    }
    protected hoverStatus( e: ToolEvent ): string { return e.alt ? 'Zoom out' : 'Zoom in'; }
}
