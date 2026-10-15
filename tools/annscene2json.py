'''
Converts "wx_annotate_shell file format" .annscene pickles (the format saved by
wx_annotate_collection.py) into the JSON scene format used by the web port.

Usage (from the repository root, using the Python environment that runs the desktop app):
    venv/bin/python web/tools/annscene2json.py OUTPUT_DIR SCENE.annscene [SCENE.annscene ...]

Each scene is written to OUTPUT_DIR/<scene name, made URL-safe>.json.  The guide image, if found,
is copied to OUTPUT_DIR/images/ and referenced relative to the JSON file.

The JSON format is documented in web/src/core/scene.ts.
'''

import os
import sys
import json
import shutil
import warnings

sys.path.insert( 0, os.path.dirname( os.path.abspath( __file__ ) ) )
from common import kRepoRoot, load_annotations
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

def slug( name ):
    '''
    Returns a URL-safe version of a file name (without its extension), so that converted files
    can be served by any static web server.
    '''
    import re, unicodedata
    name = unicodedata.normalize( 'NFKD', name ).encode( 'ascii', 'ignore' ).decode( 'ascii' )
    name = re.sub( r'[^A-Za-z0-9]+', '-', name ).strip( '-' ).lower()
    return name or 'scene'

def find_image( image_path ):
    '''
    Returns the path to an existing guide image file given the path stored in the scene, or None.
    Paths saved on other machines are resolved by looking for the 'scenes/' suffix in this repository.
    '''
    if image_path is None: return None

    ## Python 2 pickles store paths as UTF-8 bytes, which are loaded as latin1-decoded strings.
    try: image_path = image_path.encode( 'latin1' ).decode( 'utf8' )
    except ( UnicodeEncodeError, UnicodeDecodeError ): pass

    candidates = [ image_path, os.path.join( kRepoRoot, image_path ) ]

    norm = image_path.replace( '\\', '/' )
    marker = 'scenes/'
    if marker in norm:
        candidates.append( os.path.join( kRepoRoot, norm[ norm.rindex( marker ): ] ) )
    ## Images that used to live outside of the repository may have been copied into scenes/artwork.
    candidates.append( os.path.join( kRepoRoot, 'scenes', 'artwork', os.path.basename( norm ) ) )
    candidates.append( os.path.join( kRepoRoot, 'scenes', 'artwork', 'blair', os.path.basename( norm ) ) )

    ## macOS file names may be stored in either Unicode normalization form.
    import unicodedata
    for candidate in candidates:
        for form in ( 'NFC', 'NFD' ):
            normalized = unicodedata.normalize( form, candidate )
            if os.path.isfile( normalized ): return normalized
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

    def parenting_connection_index( manip ):
        con = manip.parenting_connection
        if con is None: return None
        if id( con ) in connection2index: return connection2index[ id( con ) ]
        ## The connection was deleted but is still referenced.  The desktop app keeps using the
        ## deleted connection's curve; use the live connection between the same shapes instead, if any.
        for other in anns:
            if isinstance( other, Connection ) and set( map( id, other.regions ) ) == set( map( id, con.regions ) ):
                print( 'NOTE: same-length annotation referenced a deleted connection; using the live one between the same shapes.' )
                return connection2index[ id( other ) ]
        print( 'NOTE: same-length annotation referenced a deleted connection; dropping the reference.' )
        return None
    
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
                        'connection': parenting_connection_index( m ),
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
    A = load_annotations( path )

    shapes, annotations = convert_annotations( A.anns )

    name = os.path.splitext( os.path.basename( path ) )[0]

    ## Annotations.Load() leaves image_path as None when it can't open the image,
    ## so read the stored path from the file's ( format, annotations, image path, oblique ) tuple.
    import pickle
    with open( path, 'rb' ) as f:
        stored_image_path = pickle.load( f, encoding = 'latin1' )[2]
    
    image = None
    image_src = find_image( stored_image_path )
    if image_src is not None:
        os.makedirs( os.path.join( out_dir, 'images' ), exist_ok = True )
        base, ext = os.path.splitext( os.path.basename( image_src ) )
        image = 'images/' + slug( base ) + ext.lower()
        shutil.copyfile( image_src, os.path.join( out_dir, image ) )
    elif stored_image_path is not None:
        print( 'WARNING: guide image not found:', stored_image_path )

    scene = {
        'format': kFormatName,
        'version': kFormatVersion,
        'name': name,
        'image': image,
        'shapes': shapes,
        'annotations': annotations,
        }

    out_path = os.path.join( out_dir, slug( name ) + '.json' )
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
    write_index( out_dir )

def write_index( out_dir ):
    '''
    Writes OUTPUT_DIR/index.json, listing every scene in OUTPUT_DIR, for the web app's scene menu.
    '''
    scenes = []
    for name in sorted( os.listdir( out_dir ), key = str.lower ):
        if not name.endswith( '.json' ) or name == 'index.json': continue
        with open( os.path.join( out_dir, name ) ) as f:
            scene = json.load( f )
        if scene.get( 'format' ) != kFormatName: continue
        scenes.append( { 'name': scene['name'], 'file': name, 'shapes': len( scene['shapes'] ), 'annotations': len( scene['annotations'] ) } )
    with open( os.path.join( out_dir, 'index.json' ), 'w' ) as f:
        json.dump( scenes, f, indent = 1 )
    print( 'Wrote', os.path.join( out_dir, 'index.json' ) )

if __name__ == '__main__': main()
