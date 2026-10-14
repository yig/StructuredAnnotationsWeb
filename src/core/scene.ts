// The scene: primitives and annotations, and their JSON representation.
//
// JSON format ("structured-annotations-scene", version 1):
// {
//   "format": "structured-annotations-scene", "version": 1,
//   "name": string, "image": URL of the guide image relative to the scene file, or null,
//   "shapes": [ CylinderData | EllipsoidData ],          (see cylinder.ts and ellipsoid.ts)
//   "annotations": [ Annotation ]                       (see below)
// }
// World coordinates: the guide image is centered at the origin and scaled so that its longer side
// spans [-1,1]; +y is up and +z points towards the viewer.
// Parameters 't' along a cylinder's spine are in [0,1] (vertex i of n is at t = i/(n-1)).
// Annotations reference shapes by id, and same-length items reference connections by their index
// in the annotations list.

import { Cylinder, CylinderData } from './cylinder';
import { Ellipsoid, EllipsoidData } from './ellipsoid';
import { Vec2 } from './vec';

export type Shape = Cylinder | Ellipsoid;
export type ShapeData = CylinderData | EllipsoidData;

// Connects two shapes where they overlap: the shapes' surfaces should meet along the curve.
export interface Connection {
    type: 'connection';
    shapes: [ string, string ];
    // For each shape, whether its front (true) or back (false) surface is attached.
    attachFront: [ boolean, boolean ];
    curve: Vec2[];
}

// Cross sections (of cylinders, at parameter t) or ellipsoids with the same tilt angle.
export interface SameTilt {
    type: 'sameTilt';
    items: { shape: string, t?: number }[];
    // Indices of items whose average determines the others' value; if empty, all items are averaged.
    masters: number[];
}

// Cylinder cross sections with the same scale (radius).
export interface SameScale {
    type: 'sameScale';
    items: { shape: string, t: number }[];
    masters: number[];
}

// Shapes with the same 3d length.  'connection' is the index of the connection to the shape's parent,
// which determines the origin about which the shape is scaled.
export interface SameLength {
    type: 'sameLength';
    items: { shape: string, connection: number | null }[];
    masters: number[];
}

// Aligns one shape onto (if both shapes are the same) or two shapes symmetrically across
// the parent's symmetry sheet.
export interface Align {
    type: 'align';
    shapes: [ string, string ];
    parent: string;
}

// Adds a copy of a shape (and the shapes attached to it) mirrored across the parent's symmetry sheet.
export interface Mirror {
    type: 'mirror';
    shape: string;
    parent: string;
}

export type Annotation = Connection | SameTilt | SameScale | SameLength | Align | Mirror;

export interface SceneData {
    format: 'structured-annotations-scene';
    version: 1;
    name: string;
    image: string | null;
    shapes: ShapeData[];
    annotations: Annotation[];
}

export const kSceneFormat = 'structured-annotations-scene';

export function shapeFromData( data: ShapeData ): Shape {
    return data.type === 'cylinder' ? new Cylinder( data.id, data ) : new Ellipsoid( data.id, data );
}

export class Scene {
    constructor(
        public name: string,
        public image: string | null,
        public shapes: Shape[],
        public annotations: Annotation[],
    ) {}

    static fromData( data: SceneData ): Scene {
        if( data.format !== kSceneFormat ) throw new Error( 'Not a structured annotations scene.' );
        if( data.version !== 1 ) throw new Error( `Unsupported scene version: ${ data.version }` );
        return new Scene( data.name, data.image, data.shapes.map( shapeFromData ), structuredClone( data.annotations ) );
    }

    toData(): SceneData {
        return {
            format: kSceneFormat,
            version: 1,
            name: this.name,
            image: this.image,
            shapes: this.shapes.map( s => s.toData() ),
            annotations: structuredClone( this.annotations ),
        };
    }

    shape( id: string ): Shape | undefined { return this.shapes.find( s => s.id === id ); }
    connections(): Connection[] { return this.annotations.filter( ( a ): a is Connection => a.type === 'connection' ); }
}
