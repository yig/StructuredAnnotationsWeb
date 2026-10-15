// The application: owns the scene, the views, the tools, undo/redo, and file operations.

import * as THREE from 'three';
import { Scene, SceneData, Connection, Annotation } from '../core/scene';
import { Cylinder } from '../core/cylinder';
import { solveScene, SolvedScene } from '../core/solve';
import { meshesToOBJ, TriMesh } from '../core/mesh';
import { Vec2 } from '../core/vec';
import { View2D } from './view2d';
import { View3D } from './view3d';
import { drawShape, drawAnnotations, Widgets } from './draw';
import {
    Tool, AppContext, ToolEvent, MenuItem, SelectTool, CylinderTool, EllipsoidTool, ConnectTool,
    SameTiltTool, SameLengthTool, SameScaleTool, MirrorTool, AlignTool, PanTool, ZoomTool,
} from './tools';
import { openCrossSectionEditor } from './crossSectionEditor';
import { showMenu, hideMenu } from './menu';

const kWidgetNames = [ 'cap_radius_manip', 'cross_section_tilt', 'ellipse_rotscale', 'radius_manip', 'same_angle', 'same_length', 'symmetry_plane_manip' ];
const kAllAnnotationTypes: Annotation['type'][] = [ 'connection', 'sameTilt', 'sameScale', 'sameLength', 'mirror', 'align' ];
const kMaxUndo = 100;
const kDefaultImage = new URL( 'xy-grid.png', document.baseURI ).href;

interface Snapshot { scene: SceneData; selection: string[] }

function loadImage( url: string ): Promise<HTMLImageElement> {
    return new Promise( ( resolve, reject ) => {
        const img = new Image();
        img.onload = () => resolve( img );
        img.onerror = () => reject( new Error( `Couldn't load image ${ url }` ) );
        img.src = url;
    } );
}

export interface AppElements {
    canvas2d: HTMLCanvasElement;
    canvas3d: HTMLCanvasElement;
    status: HTMLElement;
    toolbar: HTMLElement;
    sceneTitle: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    flash: HTMLElement;
}

export class App implements AppContext {
    scene = new Scene( 'Untitled', null, [], [] );
    selection = new Set<string>();
    locked = new Set<string>();
    readonly view: View2D;
    readonly view3d: View3D;
    widgets: Widgets = {};
    readonly tools: Tool[];
    tool: Tool;

    showAllAnnotations = true;
    fillShapes = false;

    private image: HTMLImageElement | null = null;
    // Where the scene's image URL is resolved relative to.
    private baseUrl = '';
    private solved: SolvedScene | null = null;
    private undoStack: Snapshot[] = [];
    private redoStack: Snapshot[] = [];
    private renderRequested = false;
    private solveRequested = false;
    private lastSolveMs = 0;
    private connectionCurves = new Map<Connection, Vec2[][]>();
    private hover: ToolEvent | null = null;
    // Temporary panning with the middle button or while Space is held.
    private panning: { last: Vec2 } | null = null;
    private spaceDown = false;
    private flashTimer = 0;
    private dirty = false;

    constructor( private readonly el: AppElements ) {
        this.view = new View2D( el.canvas2d );
        this.view3d = new View3D( el.canvas3d, () => {} );
        this.tools = [
            new SelectTool( this ), new CylinderTool( this ), new EllipsoidTool( this ), new ConnectTool( this ),
            new SameTiltTool( this ), new SameLengthTool( this ), new SameScaleTool( this ),
            new MirrorTool( this ), new AlignTool( this, true ), new AlignTool( this, false ),
            new PanTool( this ), new ZoomTool( this ),
        ];
        this.tool = this.tools[0];
        this.buildToolbar();
        this.bindEvents();
        new ResizeObserver( () => this.resize() ).observe( el.canvas2d );
        new ResizeObserver( () => this.view3d.resize() ).observe( el.canvas3d );
    }

    async init(): Promise<void> {
        const entries = await Promise.all( kWidgetNames.map( async name => [ name, await loadImage( `widgets/${ name }.png` ) ] as const ) );
        this.widgets = Object.fromEntries( entries );
        this.resize();
    }

    // ---- Scenes

    async loadSceneFromUrl( url: string ): Promise<void> {
        const response = await fetch( url );
        if( !response.ok ) throw new Error( `Couldn't load ${ url }: ${ response.status }` );
        const data = await response.json() as SceneData;
        await this.loadScene( data, new URL( url, window.location.href ).href );
    }

    async loadScene( data: SceneData, baseUrl: string ): Promise<void> {
        const scene = Scene.fromData( data );
        this.baseUrl = baseUrl;
        this.scene = scene;
        this.selection = new Set();
        this.locked = new Set();
        this.undoStack = [];
        this.redoStack = [];
        this.dirty = false;
        for( const t of this.tools ) t.reset();
        await this.setImageFromScene();
        this.view.center = [ 0, 0 ];
        this.view.zoom = 1;
        this.sceneChanged( false );
        this.resetView3d();
        this.updateTitle();
    }

    newScene(): void {
        void this.loadScene( { format: 'structured-annotations-scene', version: 1, name: 'Untitled', image: null, shapes: [], annotations: [] }, window.location.href );
    }

    // Scenes without a guide image show a grid, as in the desktop app (scenes/artwork/xy grid2.png).
    // The default isn't stored in the scene.
    private async setImageFromScene(): Promise<void> {
        this.image = null;
        const url = this.scene.image ? new URL( this.scene.image, this.baseUrl ).href : kDefaultImage;
        try { this.image = await loadImage( url ); }
        catch( e ) { this.flash( String( ( e as Error ).message ) ); }
        this.view3d.setImage( this.image, ...this.imageRect() );
    }

    // Annotations.SetImage(): the image is centered, with its longer side spanning [-1,1].
    imageRect(): [ [ number, number ], [ number, number ] ] {
        if( !this.image ) return [ [ -1, -1 ], [ 2, 2 ] ];
        const s = 2 / Math.max( this.image.width, this.image.height );
        const size: [ number, number ] = [ this.image.width * s, this.image.height * s ];
        return [ [ -0.5 * size[0], -0.5 * size[1] ], size ];
    }

    // Sets the guide image from a local file; it is embedded in saved scenes.
    async setImageFile( file: File ): Promise<void> {
        const dataUrl = await new Promise<string>( ( resolve, reject ) => {
            const reader = new FileReader();
            reader.onload = () => resolve( reader.result as string );
            reader.onerror = () => reject( reader.error );
            reader.readAsDataURL( file );
        } );
        this.saveUndo();
        this.scene.image = dataUrl;
        await this.setImageFromScene();
        this.dirty = true;
        this.requestRender();
    }

    saveSceneFile(): void {
        const data = this.scene.toData();
        download( `${ this.scene.name || 'scene' }.json`, JSON.stringify( data ), 'application/json' );
        this.dirty = false;
        this.updateTitle();
    }

    // The solved model as OBJ, one object per shape (and per mirrored copy).
    exportOBJ(): void {
        const solved = this.solved ?? solveScene( this.scene );
        const meshes: { name: string, mesh: TriMesh }[] = [];
        this.scene.shapes.forEach( ( s, i ) => {
            const shape = solved.shapes.get( s.id );
            if( shape ) meshes.push( { name: `${ s instanceof Cylinder ? 'cylinder' : 'ellipsoid' }_${ i + 1 }`, mesh: shape.mesh } );
        } );
        solved.mirrored.forEach( ( m, i ) => meshes.push( { name: `mirrored_${ i + 1 }`, mesh: m.mesh } ) );
        download( `${ this.scene.name || 'model' }.obj`, meshesToOBJ( meshes ), 'text/plain' );
    }

    private updateTitle(): void {
        this.el.sceneTitle.textContent = ( this.scene.name || 'Untitled' ) + ( this.dirty ? ' •' : '' );
        document.title = `${ this.scene.name || 'Untitled' } — Structured Annotations`;
    }

    // ---- Undo

    saveUndo(): void {
        this.undoStack.push( { scene: this.scene.toData(), selection: [ ...this.selection ] } );
        if( this.undoStack.length > kMaxUndo ) this.undoStack.shift();
        this.redoStack = [];
        this.updateUndoButtons();
    }
    discardUndo(): void {
        this.undoStack.pop();
        this.updateUndoButtons();
    }
    undo(): void { this.restore( this.undoStack, this.redoStack ); }
    redo(): void { this.restore( this.redoStack, this.undoStack ); }
    private restore( from: Snapshot[], to: Snapshot[] ): void {
        const snapshot = from.pop();
        if( !snapshot ) return;
        to.push( { scene: this.scene.toData(), selection: [ ...this.selection ] } );
        const imageChanged = snapshot.scene.image !== this.scene.image;
        this.scene = Scene.fromData( snapshot.scene );
        this.selection = new Set( snapshot.selection.filter( id => this.scene.shape( id ) ) );
        for( const t of this.tools ) t.reset();
        if( imageChanged ) void this.setImageFromScene();
        this.sceneChanged( false );
    }
    private updateUndoButtons(): void {
        this.el.undo.disabled = this.undoStack.length === 0;
        this.el.redo.disabled = this.redoStack.length === 0;
    }

    // ---- Changes, solving, and rendering

    changed( live = false ): void {
        this.dirty = true;
        this.sceneChanged( live );
    }

    private sceneChanged( live: boolean ): void {
        this.connectionCurves.clear();
        this.updateUndoButtons();
        this.updateTitle();
        this.requestRender();
        this.requestSolve( live );
    }

    private requestSolve( live: boolean ): void {
        if( this.solveRequested ) return;
        this.solveRequested = true;
        // During drags, skip frames if solving is slow.
        const delay = live ? Math.min( 250, this.lastSolveMs ) : 0;
        const run = () => { this.solveRequested = false; this.solveNow(); };
        if( delay > 16 ) setTimeout( () => requestAnimationFrame( run ), delay );
        else requestAnimationFrame( run );
    }

    private solveNow(): void {
        const start = performance.now();
        try {
            this.solved = solveScene( this.scene );
            const meshes = [ ...this.scene.shapes.map( s => this.solved!.shapes.get( s.id )!.mesh ), ...this.solved.mirrored.map( m => m.mesh ) ];
            this.view3d.setMeshes( meshes );
            for( const w of this.solved.warnings ) console.warn( w );
        } catch( e ) {
            console.error( e );
            this.flash( 'Couldn\'t build the 3d model: ' + ( e as Error ).message );
        }
        this.lastSolveMs = performance.now() - start;
    }

    resetView3d(): void {
        const [ pos, size ] = this.imageRect();
        const box = new THREE.Box3( new THREE.Vector3( pos[0], pos[1], -0.5 ), new THREE.Vector3( pos[0] + size[0], pos[1] + size[1], 0.5 ) );
        const center = box.getCenter( new THREE.Vector3() );
        center.z = 0;
        this.view3d.resetView( center, 0.55 * Math.max( size[0], size[1] ) );
    }

    requestRender(): void {
        if( this.renderRequested ) return;
        this.renderRequested = true;
        requestAnimationFrame( () => { this.renderRequested = false; this.render2d(); } );
    }

    private resize(): void {
        this.view.resize();
        this.render2d();
    }

    private render2d(): void {
        const v = this.view;
        v.begin( '#ffffff' );
        if( this.image ) {
            const [ pos, size ] = this.imageRect();
            const ctx = v.ctx;
            ctx.save();
            ctx.globalAlpha = 0.5;
            ctx.translate( pos[0], pos[1] + size[1] );
            ctx.scale( 1, -1 );
            ctx.drawImage( this.image, 0, 0, size[0], size[1] );
            ctx.restore();
        }
        // The first shape in the list is drawn on top.
        for( let i = this.scene.shapes.length - 1; i >= 0; --i ) {
            const s = this.scene.shapes[i];
            try { drawShape( v, s, { fill: this.fillShapes, locked: this.locked.has( s.id ) } ); }
            catch( e ) { console.warn( 'Failed to draw shape', s.id, e ); }
        }
        const types = new Set( this.showAllAnnotations ? kAllAnnotationTypes : this.tool.annotationTypes() );
        drawAnnotations( v, this.scene, types, this.widgets, this.locked, this.connectionCurves );
        try { this.tool.drawOverlay( v ); }
        catch( e ) { console.warn( 'Failed to draw tool overlay', e ); }
        this.el.status.textContent = this.tool.status();
    }

    // ---- Tools

    setTool( name: string ): void {
        const tool = this.tools.find( t => t.name === name );
        if( !tool ) return;
        this.tool.reset();
        this.tool = tool;
        tool.hover = this.hover;
        for( const b of this.el.toolbar.querySelectorAll( 'button' ) ) b.setAttribute( 'aria-pressed', String( b.dataset.tool === name ) );
        this.el.canvas2d.dataset.tool = name;
        this.requestRender();
    }

    private buildToolbar(): void {
        const groups: string[][] = [ [ 'select' ], [ 'cylinder', 'ellipsoid' ], [ 'connect', 'sameTilt', 'sameLength', 'sameScale', 'mirror', 'align', 'center' ], [ 'pan', 'zoom' ] ];
        for( const group of groups ) {
            const div = document.createElement( 'div' );
            div.className = 'tool-group';
            for( const name of group ) {
                const tool = this.tools.find( t => t.name === name )!;
                const b = document.createElement( 'button' );
                b.dataset.tool = name;
                b.title = `${ tool.title } (${ tool.shortcut.toUpperCase() })`;
                b.setAttribute( 'aria-label', tool.title );
                b.setAttribute( 'aria-pressed', String( tool === this.tool ) );
                const img = document.createElement( 'img' );
                img.src = `icons/${ tool.icon }.png`;
                img.alt = '';
                b.appendChild( img );
                b.addEventListener( 'click', () => this.setTool( name ) );
                div.appendChild( b );
            }
            this.el.toolbar.appendChild( div );
        }
    }

    moveToFront( id: string ): void {
        const i = this.scene.shapes.findIndex( s => s.id === id );
        if( i > 0 ) this.scene.shapes.unshift( ...this.scene.shapes.splice( i, 1 ) );
    }

    openCrossSectionEditor( shape: Cylinder, t: number ): void {
        openCrossSectionEditor( this, shape, t );
    }

    flash( message: string ): void {
        const f = this.el.flash;
        f.textContent = message;
        f.hidden = false;
        clearTimeout( this.flashTimer );
        this.flashTimer = window.setTimeout( () => { f.hidden = true; }, 4000 );
    }

    // ---- Input

    private toolEvent( e: { clientX: number, clientY: number, shiftKey: boolean, altKey: boolean, metaKey: boolean, ctrlKey: boolean } ): ToolEvent {
        const r = this.el.canvas2d.getBoundingClientRect();
        const screen: Vec2 = [ e.clientX - r.left, e.clientY - r.top ];
        return { world: this.view.toWorld( screen ), screen, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey };
    }

    private bindEvents(): void {
        const c = this.el.canvas2d;
        c.addEventListener( 'pointerdown', e => {
            hideMenu();
            if( e.button === 2 ) return;
            c.setPointerCapture( e.pointerId );
            const ev = this.toolEvent( e );
            this.hover = ev;
            if( e.button === 1 || this.spaceDown ) { this.panning = { last: ev.screen }; e.preventDefault(); return; }
            if( e.button !== 0 ) return;
            this.tool.hover = ev;
            this.tool.down( ev );
            this.requestRender();
        } );
        c.addEventListener( 'pointermove', e => {
            const ev = this.toolEvent( e );
            this.hover = ev;
            if( this.panning ) {
                const v = this.view;
                v.center = [ v.center[0] - ( ev.screen[0] - this.panning.last[0] ) / v.scale, v.center[1] + ( ev.screen[1] - this.panning.last[1] ) / v.scale ];
                this.panning.last = ev.screen;
                this.requestRender();
                return;
            }
            this.tool.move( ev );
        } );
        const end = ( e: PointerEvent ) => {
            if( this.panning ) { this.panning = null; return; }
            if( e.button !== 0 && !this.tool.dragging ) return;
            this.tool.up( this.toolEvent( e ) );
        };
        c.addEventListener( 'pointerup', end );
        c.addEventListener( 'pointercancel', end );
        c.addEventListener( 'pointerleave', () => { if( !this.tool.dragging ) { this.tool.hover = null; this.requestRender(); } } );
        c.addEventListener( 'wheel', e => {
            e.preventDefault();
            const r = c.getBoundingClientRect();
            this.view.zoomAbout( Math.exp( -e.deltaY * ( e.deltaMode === 1 ? 0.05 : 0.0015 ) ), [ e.clientX - r.left, e.clientY - r.top ] );
            if( this.hover ) this.tool.move( this.toolEvent( e ) );
            this.requestRender();
        }, { passive: false } );
        c.addEventListener( 'contextmenu', e => {
            e.preventDefault();
            const items: MenuItem[] = this.tool.contextMenu( this.toolEvent( e ) );
            if( items.length > 0 ) showMenu( items, e.clientX, e.clientY, () => this.requestRender() );
        } );

        window.addEventListener( 'keydown', e => {
            if( isTyping( e ) ) return;
            const mod = e.metaKey || e.ctrlKey;
            if( mod && e.key.toLowerCase() === 'z' ) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
            if( mod && e.key.toLowerCase() === 'y' ) { e.preventDefault(); this.redo(); return; }
            if( mod && e.key.toLowerCase() === 's' ) { e.preventDefault(); this.saveSceneFile(); return; }
            if( e.key === ' ' ) { this.spaceDown = true; this.el.canvas2d.dataset.panning = 'true'; e.preventDefault(); return; }
            if( e.key === 'Escape' ) { hideMenu(); this.tool.reset(); this.requestRender(); return; }
            if( this.hover && this.tool.key( e.key, { ...this.hover, shift: e.shiftKey, alt: e.altKey, mod } ) ) { e.preventDefault(); return; }
            if( !mod && !e.altKey && e.key.length === 1 ) {
                const tool = this.tools.find( t => t.shortcut === e.key.toLowerCase() );
                if( tool ) { this.setTool( tool.name ); return; }
            }
            this.refreshModifiers( e );
        } );
        window.addEventListener( 'keyup', e => {
            if( e.key === ' ' ) { this.spaceDown = false; delete this.el.canvas2d.dataset.panning; }
            this.refreshModifiers( e );
        } );
        window.addEventListener( 'beforeunload', e => { if( this.dirty && this.undoStack.length > 0 ) e.preventDefault(); } );
    }

    // Modifier keys change what tools show under the mouse.
    private refreshModifiers( e: KeyboardEvent ): void {
        if( !this.hover ) return;
        this.hover = { ...this.hover, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey };
        this.tool.hover = this.hover;
        this.requestRender();
    }
}

function isTyping( e: KeyboardEvent ): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && ( t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable || !!t.closest( 'dialog' ) );
}

export function download( name: string, contents: string, type: string ): void {
    const url = URL.createObjectURL( new Blob( [ contents ], { type } ) );
    const a = document.createElement( 'a' );
    a.href = url;
    a.download = name;
    document.body.appendChild( a );
    a.click();
    a.remove();
    setTimeout( () => URL.revokeObjectURL( url ), 1000 );
}
