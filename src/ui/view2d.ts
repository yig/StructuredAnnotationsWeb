// The 2d annotation view: a canvas with a pannable, zoomable world-space transform.
// As in the desktop app (wxBasicGLCanvas), at zoom 1 the view contains [-1,1] x [-1,1].

import { Vec2, Vec3 } from '../core/vec';

export type RGB = [ number, number, number ];

export const Colors = {
    silhouette: [ 0, 0, 0 ] as RGB,
    symmetryXSection: [ 87, 118, 55 ] as RGB,
    circularXSection: [ 213, 99, 191 ] as RGB,
    diameter: [ 106, 49, 95 ] as RGB,
    connection: [ 87, 118, 55 ] as RGB,
    spine: [ 0, 0, 0 ] as RGB,
    symmetrySheet: [ 103, 83, 99 ] as RGB,
    smartGuide: [ 135, 229, 228 ] as RGB,
    liveSpine: [ 255, 0, 0 ] as RGB,
};

export function rgba( c: RGB, a = 1 ): string { return `rgba(${ c[0] },${ c[1] },${ c[2] },${ a })`; }

// World-space sizes at zoom 1 (wx_annotate_collection.py).
export const kWorldDefaultLineWidth = 0.01;
export const kPointDistanceThreshold = 0.04;
export const kEdgeDistanceThreshold = 0.03;

export class View2D {
    readonly ctx: CanvasRenderingContext2D;
    center: Vec2 = [ 0, 0 ];
    zoom = 1;
    // Canvas size in CSS pixels.
    width = 1;
    height = 1;
    private dpr = 1;

    constructor( readonly canvas: HTMLCanvasElement ) {
        this.ctx = canvas.getContext( '2d' )!;
    }

    resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        this.dpr = window.devicePixelRatio || 1;
        this.width = Math.max( 1, rect.width );
        this.height = Math.max( 1, rect.height );
        this.canvas.width = Math.round( this.width * this.dpr );
        this.canvas.height = Math.round( this.height * this.dpr );
    }

    // Pixels per world unit.
    get scale(): number { return 0.5 * Math.min( this.width, this.height ) * this.zoom; }

    // World-space line width and picking thresholds, constant in screen space as in the desktop app.
    get lineWidth(): number { return kWorldDefaultLineWidth / this.zoom; }
    get pointThreshold(): number { return kPointDistanceThreshold / this.zoom; }
    get edgeThreshold(): number { return kEdgeDistanceThreshold / this.zoom; }

    toScreen( p: Vec2 | Vec3 ): Vec2 {
        return [ 0.5 * this.width + ( p[0] - this.center[0] ) * this.scale, 0.5 * this.height - ( p[1] - this.center[1] ) * this.scale ];
    }
    toWorld( s: Vec2 ): Vec2 {
        return [ ( s[0] - 0.5 * this.width ) / this.scale + this.center[0], -( s[1] - 0.5 * this.height ) / this.scale + this.center[1] ];
    }

    // Zooms by 'factor' keeping the world point under screen point 'about' fixed.
    zoomAbout( factor: number, about: Vec2 ): void {
        const before = this.toWorld( about );
        this.zoom = Math.max( 0.05, Math.min( 200, this.zoom * factor ) );
        const after = this.toWorld( about );
        this.center = [ this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1] ];
    }

    // Zooms and pans so that the world rectangle [lo, hi] fills the view.
    zoomToRect( lo: Vec2, hi: Vec2 ): void {
        const w = Math.max( 1e-6, Math.abs( hi[0] - lo[0] ) ), h = Math.max( 1e-6, Math.abs( hi[1] - lo[1] ) );
        this.center = [ 0.5 * ( lo[0] + hi[0] ), 0.5 * ( lo[1] + hi[1] ) ];
        const m = Math.min( this.width, this.height );
        this.zoom = Math.min( this.width / ( w * 0.5 * m ), this.height / ( h * 0.5 * m ) );
    }

    // Begins drawing a frame in world coordinates.
    begin( background: string ): void {
        const ctx = this.ctx;
        ctx.setTransform( this.dpr, 0, 0, this.dpr, 0, 0 );
        ctx.fillStyle = background;
        ctx.fillRect( 0, 0, this.width, this.height );
        const s = this.scale;
        ctx.setTransform( this.dpr * s, 0, 0, -this.dpr * s, this.dpr * ( 0.5 * this.width - this.center[0] * s ), this.dpr * ( 0.5 * this.height + this.center[1] * s ) );
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }

    // ---- Drawing helpers in world coordinates.

    path( pts: ( Vec2 | Vec3 )[], closed: boolean ): void {
        const ctx = this.ctx;
        ctx.beginPath();
        pts.forEach( ( p, i ) => i === 0 ? ctx.moveTo( p[0], p[1] ) : ctx.lineTo( p[0], p[1] ) );
        if( closed ) ctx.closePath();
    }

    stroke( pts: ( Vec2 | Vec3 )[], color: string, width: number, closed = false ): void {
        if( pts.length === 0 ) return;
        this.path( pts, closed );
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = width;
        this.ctx.stroke();
    }

    // A line loop whose opacity ramps with each point's depth (colors_from_linear_alpha_for_points()):
    // the farthest point is transparent and the nearest opaque.
    strokeDepthFaded( pts: Vec3[], color: RGB, width: number ): void {
        let lo = Infinity, hi = -Infinity;
        for( const p of pts ) { lo = Math.min( lo, p[2] ); hi = Math.max( hi, p[2] ); }
        const ctx = this.ctx;
        ctx.lineWidth = width;
        for( let i = 0; i < pts.length; ++i ) {
            const a = pts[i], b = pts[ ( i + 1 ) % pts.length ];
            const alpha = hi === lo ? 1 : ( 0.5 * ( a[2] + b[2] ) - lo ) / ( hi - lo );
            ctx.strokeStyle = rgba( color, alpha );
            ctx.beginPath();
            ctx.moveTo( a[0], a[1] );
            ctx.lineTo( b[0], b[1] );
            ctx.stroke();
        }
    }

    fill( pts: ( Vec2 | Vec3 )[], color: string ): void {
        if( pts.length === 0 ) return;
        this.path( pts, true );
        this.ctx.fillStyle = color;
        this.ctx.fill();
    }

    disk( p: Vec2 | Vec3, r: number, color: string ): void {
        this.ctx.beginPath();
        this.ctx.arc( p[0], p[1], r, 0, 2 * Math.PI );
        this.ctx.fillStyle = color;
        this.ctx.fill();
    }

    ellipse( center: Vec2, a: Vec2, b: Vec2, color: string, width: number, samples = 64 ): void {
        const pts: Vec2[] = [];
        for( let i = 0; i < samples; ++i ) {
            const th = 2 * Math.PI * i / samples;
            pts.push( [ center[0] + Math.cos( th ) * a[0] + Math.sin( th ) * b[0], center[1] + Math.cos( th ) * a[1] + Math.sin( th ) * b[1] ] );
        }
        this.stroke( pts, color, width, true );
    }

    // draw_widget(): an image centered at 'pos', rotated so the image's up direction is 'yvec',
    // fitting in a square of side 'size', optionally tinted.
    image( img: HTMLImageElement | HTMLCanvasElement, pos: Vec2 | Vec3, yvec: Vec2 | Vec3, size: number, alpha = 1 ): void {
        const w = img.width, h = img.height;
        if( !w || !h ) return;
        const m = Math.max( w, h );
        const dw = size * w / m, dh = size * h / m;
        const ctx = this.ctx;
        ctx.save();
        ctx.translate( pos[0], pos[1] );
        ctx.rotate( Math.atan2( yvec[1], yvec[0] ) - 0.5 * Math.PI );
        // World y is up; images are drawn with their top towards +y.
        ctx.scale( 1, -1 );
        ctx.globalAlpha = alpha;
        ctx.drawImage( img, -0.5 * dw, -0.5 * dh, dw, dh );
        ctx.restore();
    }
}
