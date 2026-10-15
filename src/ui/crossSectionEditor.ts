// The cross section editor (paper Section 4.1, "Cross-section shape adjustment mode"):
// draw a closed curve, choose a preset, or rotate the cross section.
// Ports SweepShapeAnnotationCreateMode.ArbitraryCrossSection and its helpers.

import { Cylinder, kCrossSectionSamples } from '../core/cylinder';
import { crossSectionAt } from '../core/edit';
import { smoothClosedStroke, normalizeCrossSection } from '../core/curves';
import { Vec2, mag } from '../core/vec';
import presets from '../core/crossSectionPresets.json';
import { Colors, rgba } from './view2d';

export interface CrossSectionEditorHost {
    saveUndo(): void;
    changed( live?: boolean ): void;
}

const kPresetNames: Record<string, string> = { unit_circle: 'Circle', oval: 'Oval', ear: 'Ear' };

export function openCrossSectionEditor( host: CrossSectionEditorHost, shape: Cylinder, t: number ): void {
    const dialog = document.createElement( 'dialog' );
    dialog.className = 'xsection-dialog';
    dialog.innerHTML = `
        <form method="dialog">
            <h2>Cross section</h2>
            <p class="hint">Draw a closed curve, choose a preset, or drag outside the white square to rotate.
            The line shows the symmetry direction.</p>
            <canvas width="320" height="320" aria-label="Cross section canvas"></canvas>
            <div class="presets" role="group" aria-label="Presets"></div>
            <div class="buttons">
                <button type="button" data-action="smooth">Smooth</button>
                <button type="button" data-action="delete">Delete</button>
                <span class="spacer"></span>
                <button type="submit" value="done" class="primary">Done</button>
            </div>
        </form>`;
    document.body.appendChild( dialog );

    const canvas = dialog.querySelector( 'canvas' )!;
    const ctx = canvas.getContext( '2d' )!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 320 * dpr; canvas.height = 320 * dpr;
    canvas.style.width = '320px'; canvas.style.height = '320px';
    const size = 320;
    // As in the desktop editor, the inner (white) square is [-0.5, 0.5]^2 and cross sections
    // (normalized to unit size) are drawn at half scale; 'kView' is the half-width of the visible area.
    const kOuter = 0.52, kInner = 0.5, kView = 0.68;
    const toCanvas = ( p: Vec2 ): Vec2 => [ size / 2 + p[0] / kView * size / 2, size / 2 - p[1] / kView * size / 2 ];
    const fromCanvas = ( x: number, y: number ): Vec2 => [ ( x - size / 2 ) / ( size / 2 ) * kView, -( y - size / 2 ) / ( size / 2 ) * kView ];

    let stroke: Vec2[] | null = null;
    let rotating: { last: Vec2, started: boolean } | null = null;

    const current = (): Vec2[] => crossSectionAt( shape, t );
    const set = ( xs: Vec2[], live = false ) => {
        shape.crossSections.set( t, xs.map( p => [ p[0], p[1] ] ) );
        shape.changed( 'crossSections' );
        host.changed( live );
        draw();
    };

    const draw = () => {
        ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );
        ctx.clearRect( 0, 0, size, size );
        const rect = ( r: number, color: string ) => {
            const [ x0, y0 ] = toCanvas( [ -r, r ] ), [ x1, y1 ] = toCanvas( [ r, -r ] );
            ctx.fillStyle = color;
            ctx.fillRect( x0, y0, x1 - x0, y1 - y0 );
        };
        rect( kOuter, 'rgba(0,0,0,0.8)' );
        rect( kInner, 'rgba(255,255,255,1)' );
        // The symmetry direction.
        ctx.strokeStyle = rgba( Colors.symmetrySheet );
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo( ...toCanvas( [ 0, 0 ] ) );
        ctx.lineTo( ...toCanvas( [ kInner, 0 ] ) );
        ctx.stroke();
        // The cross section.
        const loop = current().map( p => toCanvas( [ kInner * p[0], kInner * p[1] ] ) );
        ctx.strokeStyle = rgba( Colors.symmetryXSection );
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        loop.forEach( ( p, i ) => i === 0 ? ctx.moveTo( ...p ) : ctx.lineTo( ...p ) );
        ctx.closePath();
        ctx.stroke();
        if( stroke ) {
            ctx.strokeStyle = rgba( Colors.symmetryXSection, 200 / 255 );
            ctx.beginPath();
            stroke.forEach( ( p, i ) => { const c = toCanvas( p ); i === 0 ? ctx.moveTo( ...c ) : ctx.lineTo( ...c ); } );
            ctx.stroke();
        }
        ( dialog.querySelector( '[data-action="delete"]' ) as HTMLButtonElement ).disabled = !shape.crossSections.has( t );
    };

    const eventPoint = ( e: PointerEvent ): Vec2 => {
        const r = canvas.getBoundingClientRect();
        return fromCanvas( e.clientX - r.left, e.clientY - r.top );
    };
    canvas.addEventListener( 'pointerdown', e => {
        canvas.setPointerCapture( e.pointerId );
        const p = eventPoint( e );
        if( Math.abs( p[0] ) <= kOuter && Math.abs( p[1] ) <= kOuter ) stroke = [ p ];
        else rotating = { last: p, started: false };
    } );
    canvas.addEventListener( 'pointermove', e => {
        const p = eventPoint( e );
        if( stroke ) { stroke.push( p ); draw(); }
        else if( rotating ) {
            const a = Math.atan2( p[1], p[0] ) - Math.atan2( rotating.last[1], rotating.last[0] );
            rotating.last = p;
            if( mag( p ) === 0 || a === 0 ) return;
            if( !rotating.started ) { host.saveUndo(); rotating.started = true; }
            const c = Math.cos( a ), s = Math.sin( a );
            set( current().map( q => [ c * q[0] - s * q[1], s * q[0] + c * q[1] ] ), true );
        }
    } );
    canvas.addEventListener( 'pointerup', () => {
        if( stroke ) {
            const drawn = stroke;
            stroke = null;
            if( drawn.length >= 3 ) {
                host.saveUndo();
                set( normalizeCrossSection( smoothClosedStroke( drawn, 1, kCrossSectionSamples ) ) );
            } else draw();
        }
        if( rotating?.started ) host.changed( false );
        rotating = null;
    } );

    const presetBox = dialog.querySelector( '.presets' )!;
    for( const [ key, loop ] of Object.entries( presets as unknown as Record<string, Vec2[]> ) ) {
        const button = document.createElement( 'button' );
        button.type = 'button';
        button.title = kPresetNames[key] ?? key;
        const c = document.createElement( 'canvas' );
        c.width = 48 * dpr; c.height = 48 * dpr;
        c.style.width = '48px'; c.style.height = '48px';
        const g = c.getContext( '2d' )!;
        g.setTransform( dpr, 0, 0, dpr, 0, 0 );
        g.strokeStyle = rgba( Colors.symmetryXSection );
        g.lineWidth = 2;
        g.beginPath();
        loop.forEach( ( p, i ) => { const x = 24 + 18 * p[0], y = 24 - 18 * p[1]; i === 0 ? g.moveTo( x, y ) : g.lineTo( x, y ); } );
        g.closePath();
        g.stroke();
        button.appendChild( c );
        const label = document.createElement( 'span' );
        label.textContent = kPresetNames[key] ?? key;
        button.appendChild( label );
        button.addEventListener( 'click', () => { host.saveUndo(); set( loop ); } );
        presetBox.appendChild( button );
    }

    dialog.querySelector( '[data-action="smooth"]' )!.addEventListener( 'click', () => {
        const xs = current();
        host.saveUndo();
        set( normalizeCrossSection( smoothClosedStroke( xs, 1, xs.length ) ) );
    } );
    dialog.querySelector( '[data-action="delete"]' )!.addEventListener( 'click', () => {
        host.saveUndo();
        shape.crossSections.delete( t );
        shape.changed( 'crossSections' );
        host.changed( false );
        dialog.close();
    } );
    dialog.addEventListener( 'close', () => dialog.remove() );
    draw();
    dialog.showModal();
}
