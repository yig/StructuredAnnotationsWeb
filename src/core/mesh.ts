// A minimal triangle mesh and ray intersection (ports the parts of mesh_gui.TriMesh,
// raytri.c, and surface_intersections.py the modeling code relies on).

import { Vec3 } from './vec';

export type Face = [ number, number, number ];

export class TriMesh {
    constructor( public vs: Vec3[] = [], public faces: Face[] = [] ) {}

    clone(): TriMesh {
        return new TriMesh( this.vs.map( v => [ v[0], v[1], v[2] ] as Vec3 ), this.faces.map( f => [ f[0], f[1], f[2] ] as Face ) );
    }

    // Appends another mesh's vertices and faces (as a separate connected component).
    append( other: TriMesh ): void {
        const offset = this.vs.length;
        for( const v of other.vs ) this.vs.push( [ v[0], v[1], v[2] ] );
        for( const f of other.faces ) this.faces.push( [ f[0] + offset, f[1] + offset, f[2] + offset ] );
    }

    translate( offset: Vec3 ): void {
        for( const v of this.vs ) { v[0] += offset[0]; v[1] += offset[1]; v[2] += offset[2]; }
    }
}

const kRayTriEpsilon = 0.000001;

// raytri.c intersect_triangle1(): Moller-Trumbore intersection, accepting both triangle orientations.
// Returns the ray parameter t of the intersection, or null.
export function rayTriangleT( orig: Vec3, d: Vec3, v0: Vec3, v1: Vec3, v2: Vec3 ): number | null {
    const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
    const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
    // pvec = d x edge2
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;

    const tx = orig[0] - v0[0], ty = orig[1] - v0[1], tz = orig[2] - v0[2];
    let u: number, v: number;
    // qvec = tvec x edge1
    let qx: number, qy: number, qz: number;
    if( det > kRayTriEpsilon ) {
        u = tx * px + ty * py + tz * pz;
        if( u < 0 || u > det ) return null;
        qx = ty * e1z - tz * e1y; qy = tz * e1x - tx * e1z; qz = tx * e1y - ty * e1x;
        v = d[0] * qx + d[1] * qy + d[2] * qz;
        if( v < 0 || u + v > det ) return null;
    } else if( det < -kRayTriEpsilon ) {
        u = tx * px + ty * py + tz * pz;
        if( u > 0 || u < det ) return null;
        qx = ty * e1z - tz * e1y; qy = tz * e1x - tx * e1z; qz = tx * e1y - ty * e1x;
        v = d[0] * qx + d[1] * qy + d[2] * qz;
        if( v > 0 || u + v < det ) return null;
    } else {
        return null;
    }
    return ( e2x * qx + e2y * qy + e2z * qz ) / det;
}

// The t's of all intersections of the line (or ray) with the mesh, in face order.
export function rayMeshTs( mesh: TriMesh, orig: Vec3, d: Vec3 ): number[] {
    const result: number[] = [];
    const vs = mesh.vs;
    for( const f of mesh.faces ) {
        const t = rayTriangleT( orig, d, vs[f[0]], vs[f[1]], vs[f[2]] );
        if( t !== null ) result.push( t );
    }
    return result;
}

// Writes a Wavefront OBJ string for a list of meshes, one object per mesh.
export function meshesToOBJ( meshes: { name: string, mesh: TriMesh }[] ): string {
    const lines: string[] = [ '# Structured Annotations for 2D-to-3D Modeling' ];
    let offset = 1;
    for( const { name, mesh } of meshes ) {
        lines.push( `o ${ name }` );
        for( const v of mesh.vs ) lines.push( `v ${ v[0] } ${ v[1] } ${ v[2] }` );
        for( const f of mesh.faces ) lines.push( `f ${ f[0] + offset } ${ f[1] + offset } ${ f[2] + offset }` );
        offset += mesh.vs.length;
    }
    return lines.join( '\n' ) + '\n';
}
