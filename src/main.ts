import { App } from './ui/app';
import { SceneData } from './core/scene';

const $ = <T extends HTMLElement>( id: string ) => document.getElementById( id ) as T;

const app = new App( {
    canvas2d: $( 'view2d' ),
    canvas3d: $( 'view3d' ),
    status: $( 'status' ),
    toolbar: $( 'toolbar' ),
    sceneTitle: $( 'scene-title' ),
    undo: $( 'undo' ),
    redo: $( 'redo' ),
    flash: $( 'flash' ),
} );

// For debugging and automated testing in development builds.
if( import.meta.env.DEV ) ( window as unknown as { app: App } ).app = app;

interface SceneEntry { name: string, file: string, shapes: number, annotations: number }

async function main(): Promise<void> {
    await app.init();

    const select = $<HTMLSelectElement>( 'scene-select' );
    let entries: SceneEntry[] = [];
    try { entries = await ( await fetch( 'scenes/index.json' ) ).json(); }
    catch { /* No example scenes. */ }
    for( const e of entries ) {
        const option = document.createElement( 'option' );
        option.value = e.file;
        option.textContent = `${ e.name } (${ e.shapes } shape${ e.shapes === 1 ? "" : "s" })`;
        select.appendChild( option );
    }
    const load = async ( file: string ) => {
        try {
            await app.loadSceneFromUrl( `scenes/${ encodeURIComponent( file ) }` );
            select.value = file;
            const url = new URL( window.location.href );
            url.searchParams.set( 'scene', file );
            history.replaceState( null, '', url );
        } catch( e ) { app.flash( ( e as Error ).message ); }
    };
    select.addEventListener( 'change', () => { if( select.value ) void load( select.value ); } );

    $( 'new' ).addEventListener( 'click', () => { app.newScene(); select.value = ''; } );
    $( 'save' ).addEventListener( 'click', () => app.saveSceneFile() );
    $( 'export' ).addEventListener( 'click', () => app.exportOBJ() );
    $( 'undo' ).addEventListener( 'click', () => app.undo() );
    $( 'redo' ).addEventListener( 'click', () => app.redo() );

    const openFile = $<HTMLInputElement>( 'open-file' );
    $( 'open' ).addEventListener( 'click', () => openFile.click() );
    openFile.addEventListener( 'change', async () => {
        const file = openFile.files?.[0];
        openFile.value = '';
        if( !file ) return;
        try {
            const data = JSON.parse( await file.text() ) as SceneData;
            // Relative image paths can't be resolved for local files; embedded (data URL) images work.
            await app.loadScene( data, window.location.href );
            select.value = '';
        } catch( e ) { app.flash( `Couldn't open ${ file.name }: ${ ( e as Error ).message }` ); }
    } );

    const imageFile = $<HTMLInputElement>( 'image-file' );
    $( 'image' ).addEventListener( 'click', () => imageFile.click() );
    imageFile.addEventListener( 'change', async () => {
        const file = imageFile.files?.[0];
        imageFile.value = '';
        if( file ) { await app.setImageFile( file ); app.resetView3d(); }
    } );

    $<HTMLInputElement>( 'show-all' ).addEventListener( 'change', e => { app.showAllAnnotations = ( e.target as HTMLInputElement ).checked; app.requestRender(); } );
    $<HTMLInputElement>( 'fill' ).addEventListener( 'change', e => { app.fillShapes = ( e.target as HTMLInputElement ).checked; app.requestRender(); } );
    $<HTMLInputElement>( 'show-image-3d' ).addEventListener( 'change', e => app.view3d.setShowImage( ( e.target as HTMLInputElement ).checked ) );
    $( 'reset-3d' ).addEventListener( 'click', () => app.resetView3d() );

    const help = $<HTMLDialogElement>( 'help' );
    $( 'help-button' ).addEventListener( 'click', () => help.showModal() );

    const requested = new URLSearchParams( window.location.search ).get( 'scene' );
    const initial = entries.find( e => e.file === requested ) ?? entries.find( e => e.name === 'camel' ) ?? entries[0];
    if( initial ) await load( initial.file );
    else app.newScene();
}

void main();
