// A minimal contextual menu.

import { MenuItem } from './tools';

let current: HTMLElement | null = null;

export function hideMenu(): void {
    current?.remove();
    current = null;
}

export function showMenu( items: MenuItem[], x: number, y: number, afterAction: () => void ): void {
    hideMenu();
    // Drop leading, trailing, and repeated separators.
    const cleaned: MenuItem[] = [];
    for( const item of items ) {
        if( item.separator && ( cleaned.length === 0 || cleaned[ cleaned.length - 1 ].separator ) ) continue;
        cleaned.push( item );
    }
    while( cleaned.length > 0 && cleaned[ cleaned.length - 1 ].separator ) cleaned.pop();
    if( cleaned.length === 0 ) return;

    const menu = document.createElement( 'div' );
    menu.className = 'context-menu';
    menu.setAttribute( 'role', 'menu' );
    for( const item of cleaned ) {
        if( item.separator ) {
            const hr = document.createElement( 'div' );
            hr.className = 'separator';
            hr.setAttribute( 'role', 'separator' );
            menu.appendChild( hr );
            continue;
        }
        const b = document.createElement( 'button' );
        b.setAttribute( 'role', 'menuitem' );
        b.textContent = item.label ?? '';
        b.disabled = item.enabled === false;
        b.addEventListener( 'click', () => {
            hideMenu();
            item.action?.();
            afterAction();
        } );
        menu.appendChild( b );
    }
    document.body.appendChild( menu );
    // Keep the menu on screen.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${ Math.min( x, window.innerWidth - r.width - 4 ) }px`;
    menu.style.top = `${ Math.min( y, window.innerHeight - r.height - 4 ) }px`;
    current = menu;
    ( menu.querySelector( 'button:not(:disabled)' ) as HTMLButtonElement | null )?.focus();
    menu.addEventListener( 'keydown', e => {
        if( e.key === 'Escape' ) hideMenu();
        if( e.key === 'ArrowDown' || e.key === 'ArrowUp' ) {
            e.preventDefault();
            const buttons = [ ...menu.querySelectorAll<HTMLButtonElement>( 'button:not(:disabled)' ) ];
            const i = buttons.indexOf( document.activeElement as HTMLButtonElement );
            buttons[ ( i + ( e.key === 'ArrowDown' ? 1 : buttons.length - 1 ) ) % buttons.length ]?.focus();
        }
    } );
    setTimeout( () => window.addEventListener( 'pointerdown', function close( e ) {
        if( !menu.contains( e.target as Node ) ) { hideMenu(); window.removeEventListener( 'pointerdown', close ); }
    } ) );
}
