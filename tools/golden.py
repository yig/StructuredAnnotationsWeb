'''
Records reference ("golden") geometry computed by the desktop Python implementation,
for testing the web port against.

Usage (from the repository root, using the Python environment that runs the desktop app):
    venv/bin/python web/tools/golden.py OUTPUT_DIR SCENE.annscene [SCENE.annscene ...]

For each scene, writes OUTPUT_DIR/<scene name>.golden.json containing:
    "raw": per-shape geometry before any annotations are applied,
    "solved": per-shape geometry after annotations_symbols.ApplyConstraints(),
    "mirrored": meshes created by mirror annotations.
Shapes are keyed by the same ids that annscene2json.py writes.
'''

import os
import sys
import json
import warnings
from copy import deepcopy

sys.path.insert( 0, os.path.dirname( os.path.abspath( __file__ ) ) )
from common import kRepoRoot, load_annotations
## Modules such as ellipsoid.py load data files relative to the current directory.
kInvocationDir = os.getcwd()
os.chdir( kRepoRoot )
warnings.filterwarnings( 'ignore' )

import numpy

def floats( a ):
    return numpy.asarray( a, dtype = float ).tolist()

def mesh_json( mesh ):
    return {
        'vs': floats( mesh.vs ),
        'faces': numpy.asarray( mesh.faces, dtype = int ).tolist(),
        }

def shape_json( shape ):
    from annotations_sweep import SweepShape
    if isinstance( shape, SweepShape ):
        return {
            'spine3d': floats( shape.spine3d ),
            'denseRadii': floats( shape.dense_radii ),
            'symmetryDirections': floats( shape.symmetry_directions ),
            'denseCrossSections': floats( shape.dense_cross_sections ),
            'boundary2d': floats( shape.boundary2d ),
            'spine2d': floats( shape.spine2d ),
            'mesh': mesh_json( shape.mesh ),
            }
    else:
        return {
            'center': floats( shape.ellipsoid.center ),
            'axes': floats( shape.ellipsoid.axes ),
            'ellipse': floats( shape.ellipse ),
            'mesh': mesh_json( shape.mesh ),
            }

def is_shape( ann ):
    from annotations_sweep import SweepShape
    from annotations_ellipsoid import AnnotationData
    return isinstance( ann, SweepShape ) or ( isinstance( ann, AnnotationData ) and ann.ellipsoid is not None )

def record( path, out_dir ):
    import annotations_symbols

    A = load_annotations( path )

    raw = {}
    for ann in deepcopy( A.anns ):
        if is_shape( ann ): raw[ str( ann.uuid ) ] = shape_json( ann )

    solved_anns = deepcopy( A.anns )
    annotations_symbols.ApplyConstraints( solved_anns )

    solved = {}
    mirrored = []
    for ann in solved_anns:
        if is_shape( ann ):
            solved[ str( ann.uuid ) ] = shape_json( ann )
        elif hasattr( ann, 'mesh' ) and type( ann ).__name__ == 'Struct':
            mirrored.append( mesh_json( ann.mesh ) )

    from annscene2json import slug
    name = slug( os.path.splitext( os.path.basename( path ) )[0] )
    out_path = os.path.join( out_dir, name + '.golden.json' )
    with open( out_path, 'w' ) as f:
        json.dump( { 'raw': raw, 'solved': solved, 'mirrored': mirrored }, f, separators = ( ',', ':' ) )
    print( 'Wrote', out_path )

def main():
    if len( sys.argv ) < 3:
        print( __doc__ )
        sys.exit( 1 )

    out_dir = os.path.join( kInvocationDir, sys.argv[1] )
    paths = [ os.path.join( kInvocationDir, p ) for p in sys.argv[2:] ]
    os.makedirs( out_dir, exist_ok = True )
    for path in paths:
        record( path, out_dir )

if __name__ == '__main__': main()
