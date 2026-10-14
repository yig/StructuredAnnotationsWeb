'''
Converts "wx_annotate_shell file format" .annscene pickles (the format saved by
wx_annotate_collection.py) into the JSON scene format used by the web port.

Usage (from the repository root, using the Python environment that runs the desktop app):
    venv/bin/python web/tools/annscene2json.py OUTPUT_DIR SCENE.annscene [SCENE.annscene ...]

Each scene is written to OUTPUT_DIR/<scene name>.json.  The guide image, if found,
is copied to OUTPUT_DIR/images/ and referenced relative to the JSON file.

The JSON format is documented in web/src/core/scene.ts.
'''

import os
import sys
import json
import shutil
import warnings

kRepoRoot = os.path.abspath( os.path.join( os.path.dirname( __file__ ), '..', '..' ) )
sys.path.insert( 0, kRepoRoot )
warnings.filterwarnings( 'ignore' )

kFormatName = 'structured-annotations-scene'
kFormatVersion = 1

def floats( a ):
    '''
    Converts a (nested) sequence of numbers to nested lists of Python floats.
    Python's json module writes floats with repr(), so values round-trip exactly.
    '''
    import numpy
    return numpy.asarray( a, dtype = float ).tolist()

def ordered_items( d ):
    '''
    Returns the items of a dictionary keyed by parameter t as a list of ( t, value ) pairs.
    The dictionary's order is preserved, because the geometry depends on it in a few places
    (for example, when two values map to the same spine vertex, the later one wins).
    '''
    return list( d.items() )

def find_image( image_path ):
    '''
    Returns the path to an existing guide image file given the path stored in the scene, or None.
    Paths saved on other machines are resolved by looking for the 'scenes/' suffix in this repository.
    '''
    if image_path is None: return None

    candidates = [ image_path, os.path.join( kRepoRoot, image_path ) ]

    norm = image_path.replace( '\\', '/' )
    marker = 'scenes/'
    if marker in norm:
        candidates.append( os.path.join( kRepoRoot, norm[ norm.rindex( marker ): ] ) )
    ## Images that used to live outside of the repository may have been copied into scenes/artwork.
    candidates.append( os.path.join( kRepoRoot, 'scenes', 'artwork', os.path.basename( norm ) ) )
    candidates.append( os.path.join( kRepoRoot, 'scenes', 'artwork', 'blair', os.path.basename( norm ) ) )

    for candidate in candidates:
        if os.path.isfile( candidate ): return candidate
    return None

def convert_annotations( anns ):
    '''
    Given the list of annotations from an unpickled scene,
    returns a tuple ( shapes, annotations ) of JSON-ready lists.
    '''

    from annotations_sweep import SweepShape
    from annotations_ellipsoid import AnnotationData
    from annotations_rotund import Connection
    import annotations_symbols as sym

    shapes = []
    annotations = []

    ## Shapes are referenced by their uuid.
    shape2id = {}
    for ann in anns:
        if isinstance( ann, SweepShape ):
            shape2id[ id( ann ) ] = str( ann.uuid )
            shapes.append( {
                'id': str( ann.uuid ),
                'type': 'cylinder',
                'spine': floats( ann.spine2d ),
                'tilts': [ [ float(t), float(v) ] for t, v in ordered_items( ann.tilt_radians ) ],
                'radii': [ [ float(t), float(v) ] for t, v in ordered_items( ann.radii ) ],
                'symmetry': [ [ float(t), float(v) ] for t, v in ordered_items( ann.symmetry_radians ) ],
                'crossSections': [ [ float(t), floats( v ) ] for t, v in ordered_items( ann.cross_sections ) ],
                'capRadii': [ None if c is None else float(c) for c in ann.cap_radii ],
                } )
        elif isinstance( ann, AnnotationData ):
            if ann.ellipsoid is None: continue
            shape2id[ id( ann ) ] = str( ann.uuid )
            shapes.append( {
                'id': str( ann.uuid ),
                'type': 'ellipsoid',
                'ellipse': floats( ann.ellipse ),
                'center': floats( ann.ellipsoid.center ),
                'axes': floats( ann.ellipsoid.axes ),
                } )

    ## Annotations are referenced by their index in this list.
    connection2index = {}
    for ann in anns:
        if isinstance( ann, Connection ):
            connection2index[ id( ann ) ] = len( annotations )
            annotations.append( {
                'type': 'connection',
                'shapes': [ shape2id[ id( region ) ] for region in ann.regions ],
                'attachFront': [ bool( f ) for f in ann.regions_attaches_front ],
                'curve': floats( ann.connection_curve ),
                } )

    def masters( ann ):
        return [ ann.manips.index( m ) for m in ann.master_manips ]

    for ann in anns:
        if isinstance( ann, sym.SameTilt ):
            annotations.append( {
                'type': 'sameTilt',
                'items': [
                    { 'shape': shape2id[ id( m.shape ) ], 't': float( m.t ) } if isinstance( m, sym.TiltManipSweepShape )
                    else { 'shape': shape2id[ id( m.shape ) ] }
                    for m in ann.manips
                    ],
                'masters': masters( ann ),
                } )
        elif isinstance( ann, sym.SameRadius ):
            annotations.append( {
                'type': 'sameScale',
                'items': [ { 'shape': shape2id[ id( m.shape ) ], 't': float( m.t ) } for m in ann.manips ],
                'masters': masters( ann ),
                } )
        elif isinstance( ann, sym.SameSize ):
            annotations.append( {
                'type': 'sameLength',
                'items': [
                    {
                        'shape': shape2id[ id( m.shape ) ],
                        'connection': None if m.parenting_connection is None else connection2index[ id( m.parenting_connection ) ],
                    }
                    for m in ann.manips
                    ],
                'masters': masters( ann ),
                } )
        elif isinstance( ann, sym.MirrorAlignAcrossParent ):
            annotations.append( {
                'type': 'align',
                'shapes': [ shape2id[ id( ann.manip1.shape ) ], shape2id[ id( ann.manip2.shape ) ] ],
                'parent': shape2id[ id( ann.parent_manip.shape ) ],
                } )
        elif isinstance( ann, sym.MirrorAcrossParent ):
            annotations.append( {
                'type': 'mirror',
                'shape': shape2id[ id( ann.manip.shape ) ],
                'parent': shape2id[ id( ann.parent_manip.shape ) ],
                } )

    return shapes, annotations

def convert_file( path, out_dir ):
    from wx_annotate_shell import Annotations

    A = Annotations()
    A.Load( path )

    shapes, annotations = convert_annotations( A.anns )

    name = os.path.splitext( os.path.basename( path ) )[0]

    image = None
    image_src = find_image( A.image_path )
    if image_src is not None:
        os.makedirs( os.path.join( out_dir, 'images' ), exist_ok = True )
        image = 'images/' + os.path.basename( image_src )
        shutil.copyfile( image_src, os.path.join( out_dir, image ) )
    elif A.image_path is not None:
        print( 'WARNING: guide image not found:', A.image_path )

    scene = {
        'format': kFormatName,
        'version': kFormatVersion,
        'name': name,
        'image': image,
        'shapes': shapes,
        'annotations': annotations,
        }

    out_path = os.path.join( out_dir, name + '.json' )
    with open( out_path, 'w' ) as f:
        json.dump( scene, f, separators = ( ',', ':' ) )
    print( 'Wrote', out_path )
    return out_path

def main():
    if len( sys.argv ) < 3:
        print( __doc__ )
        sys.exit( 1 )

    out_dir = sys.argv[1]
    os.makedirs( out_dir, exist_ok = True )
    for path in sys.argv[2:]:
        convert_file( path, out_dir )

if __name__ == '__main__': main()
