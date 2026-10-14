// The 3d preview of the solved model (ResultCanvasCollection in the desktop app): toon shading
// with black silhouettes, an orthographic camera, and the guide image behind the model.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TriMesh } from '../core/mesh';

// The desktop app's NPR shader: a headlight quantized to four levels, in a bisque color.
const toonVertex = /* glsl */`
    varying vec3 vNormal;
    void main() {
        vNormal = normalize( normalMatrix * normal );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
`;
const toonFragment = /* glsl */`
    uniform vec3 color;
    varying vec3 vNormal;
    void main() {
        vec3 n = normalize( vNormal );
        if( !gl_FrontFacing ) n = -n;
        float intensity = ( floor( dot( vec3( 0.0, 0.0, 1.0 ), n ) * 4.0 ) + 1.0 ) / 4.0;
        intensity = clamp( intensity, 0.0, 1.0 );
        gl_FragColor = vec4( intensity * color, 1.0 );
    }
`;
// Silhouettes: back faces pushed out along their normals by a constant screen-space width.
const outlineVertex = /* glsl */`
    uniform float thickness;
    void main() {
        vec4 viewPos = modelViewMatrix * vec4( position, 1.0 );
        vec3 n = normalize( normalMatrix * normal );
        viewPos.xyz += n * thickness;
        gl_Position = projectionMatrix * viewPos;
    }
`;
const outlineFragment = /* glsl */`
    void main() { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); }
`;

export class View3D {
    readonly renderer: THREE.WebGLRenderer;
    readonly scene = new THREE.Scene();
    readonly camera: THREE.OrthographicCamera;
    readonly controls: OrbitControls;
    private readonly modelGroup = new THREE.Group();
    private readonly toonMaterial: THREE.ShaderMaterial;
    private readonly outlineMaterial: THREE.ShaderMaterial;
    private imagePlane: THREE.Mesh | null = null;
    private viewHalfHeight = 1.2;
    showImage = true;
    showOutlines = true;

    constructor( readonly canvas: HTMLCanvasElement, private readonly onChange: () => void ) {
        this.renderer = new THREE.WebGLRenderer( { canvas, antialias: true } );
        this.renderer.setClearColor( 0xffffff, 1 );
        this.camera = new THREE.OrthographicCamera( -1, 1, 1, -1, -100, 100 );
        this.camera.position.set( 0, 0, 10 );
        this.controls = new OrbitControls( this.camera, canvas );
        this.controls.enableDamping = false;
        this.controls.addEventListener( 'change', () => this.render() );

        this.toonMaterial = new THREE.ShaderMaterial( {
            uniforms: { color: { value: new THREE.Color( 0.95, 0.92, 0.75 ) } },
            vertexShader: toonVertex, fragmentShader: toonFragment, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        } );
        this.outlineMaterial = new THREE.ShaderMaterial( {
            uniforms: { thickness: { value: 0.01 } },
            vertexShader: outlineVertex, fragmentShader: outlineFragment, side: THREE.BackSide,
        } );
        this.scene.add( this.modelGroup );
    }

    resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        this.renderer.setPixelRatio( window.devicePixelRatio || 1 );
        this.renderer.setSize( Math.max( 1, rect.width ), Math.max( 1, rect.height ), false );
        this.updateProjection();
        this.render();
    }

    private updateProjection(): void {
        const rect = this.canvas.getBoundingClientRect();
        const aspect = Math.max( 1, rect.width ) / Math.max( 1, rect.height );
        const h = this.viewHalfHeight;
        this.camera.left = -h * aspect;
        this.camera.right = h * aspect;
        this.camera.top = h;
        this.camera.bottom = -h;
        this.camera.updateProjectionMatrix();
        // About 1.5 pixels wide.
        this.outlineMaterial.uniforms.thickness.value = 1.5 * ( 2 * h ) / Math.max( 1, rect.height ) / this.camera.zoom;
    }

    // Looks at the model from the front (the 2d view's direction).
    resetView( center: THREE.Vector3, halfHeight: number ): void {
        this.viewHalfHeight = halfHeight;
        this.camera.zoom = 1;
        this.controls.target.copy( center );
        this.camera.position.set( center.x, center.y, center.z + 10 );
        this.camera.up.set( 0, 1, 0 );
        this.controls.update();
        this.updateProjection();
        this.render();
    }

    setMeshes( meshes: TriMesh[] ): void {
        for( const child of [ ...this.modelGroup.children ] ) {
            this.modelGroup.remove( child );
            ( child as THREE.Mesh ).geometry?.dispose();
        }
        for( const m of meshes ) {
            const geometry = new THREE.BufferGeometry();
            const pos = new Float32Array( m.vs.length * 3 );
            m.vs.forEach( ( v, i ) => { pos[3 * i] = v[0]; pos[3 * i + 1] = v[1]; pos[3 * i + 2] = v[2]; } );
            const index = new Uint32Array( m.faces.length * 3 );
            m.faces.forEach( ( f, i ) => { index[3 * i] = f[0]; index[3 * i + 1] = f[1]; index[3 * i + 2] = f[2]; } );
            geometry.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
            geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );
            geometry.computeVertexNormals();
            this.modelGroup.add( new THREE.Mesh( geometry, this.toonMaterial ) );
            if( this.showOutlines ) {
                const outline = new THREE.Mesh( geometry, this.outlineMaterial );
                outline.renderOrder = -1;
                this.modelGroup.add( outline );
            }
        }
        this.render();
    }

    // The guide image, as a plane behind the model (at depth -0.5, as in the desktop app).
    setImage( image: HTMLImageElement | null, pos: [ number, number ], size: [ number, number ] ): void {
        if( this.imagePlane ) {
            this.scene.remove( this.imagePlane );
            this.imagePlane.geometry.dispose();
            ( this.imagePlane.material as THREE.MeshBasicMaterial ).map?.dispose();
            ( this.imagePlane.material as THREE.Material ).dispose();
            this.imagePlane = null;
        }
        if( image ) {
            const texture = new THREE.Texture( image );
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
            const material = new THREE.MeshBasicMaterial( { map: texture, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false } );
            this.imagePlane = new THREE.Mesh( new THREE.PlaneGeometry( size[0], size[1] ), material );
            this.imagePlane.position.set( pos[0] + 0.5 * size[0], pos[1] + 0.5 * size[1], -0.5 );
            this.imagePlane.renderOrder = -2;
            this.imagePlane.visible = this.showImage;
            this.scene.add( this.imagePlane );
        }
        this.render();
    }

    setShowImage( show: boolean ): void {
        this.showImage = show;
        if( this.imagePlane ) this.imagePlane.visible = show;
        this.render();
    }

    render(): void {
        this.updateProjection();
        this.renderer.render( this.scene, this.camera );
        this.onChange();
    }
}
