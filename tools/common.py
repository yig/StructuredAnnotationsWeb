'''
Shared helpers for the conversion tools.
'''

import os
import sys
import uuid
import warnings

kRepoRoot = os.path.abspath( os.path.join( os.path.dirname( __file__ ), '..', '..' ) )
sys.path.insert( 0, kRepoRoot )
warnings.filterwarnings( 'ignore' )

def load_annotations( path ):
    '''
    Loads a "wx_annotate_shell file format" scene and returns the Annotations object.

    Older scenes don't store uuids for their shapes, and unpickling assigns them random ones.
    To give the same shapes the same ids every time a file is loaded, those uuids are
    generated deterministically from the file name and the order in which they are created.
    '''
    from wx_annotate_shell import Annotations

    name = os.path.basename( path )
    counter = [ 0 ]
    def deterministic_uuid4():
        counter[0] += 1
        return uuid.uuid5( uuid.NAMESPACE_URL, '%s#%d' % ( name, counter[0] ) )

    original_uuid4 = uuid.uuid4
    uuid.uuid4 = deterministic_uuid4
    try:
        A = Annotations()
        A.Load( path )
    finally:
        uuid.uuid4 = original_uuid4
    return A
